/**
 * MCP 远程 Streamable HTTP 端点（冻版骨架）
 *
 *   POST /mcp  —— 单请求单响应，JSON-RPC 2.0 风格（initialize / tools/list / tools/call / ping）
 *   GET  /mcp  —— 返回能力描述（自检方便，非 MCP 规范必需）
 *
 * ⛔ 硬约束（违反即返工）
 *   1. 禁止本地 stdio MCP —— 评委必须零配置接入，只能是远程 URL 型
 *   2. 禁止 SSE 长连接保活 —— CF 隧道 100 秒硬限制，任何单次响应必须 < 90 秒
 *   3. 鉴权只认 Authorization: Bearer <DEMO_TOKEN>（兼容裸 token），DEMO_TOKEN 只从 env 读
 */
import express from "express";
import { requireMcpToken } from "../middleware/auth.js";
import { mcpLimiter, tryConsume } from "../middleware/ratelimit.js";
import { loadHandlers } from "./handlers.js";
import { callTool, listToolSchemas } from "./tools.js";

const SERVER_NAME = "beimingda";
const SERVER_VERSION = process.env.npm_package_version || "0.1.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  APP_ERROR: -32000,
};

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data ? { data } : {}) },
});

/** SSE 一律不支持：显式拒绝，避免客户端误以为要挂长连接 */
function rejectSse(res) {
  return res.status(405).json(
    rpcErr(null, RPC.INVALID_REQUEST, "SSE is not supported; use single POST /mcp request-response"),
  );
}

export function createMcpRouter() {
  const router = express.Router();
  loadHandlers();

  router.get("/", (req, res) => {
    res.json({
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      transport: "streamable-http",
      endpoint: "POST /mcp",
      sse: false,
      auth: "Authorization: Bearer <DEMO_TOKEN>",
      protocolVersions: SUPPORTED_PROTOCOLS,
      tools: listToolSchemas().length,
    });
  });

  router.get("/sse", (req, res) => rejectSse(res));

  router.post("/", requireMcpToken, async (req, res) => {
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];

    if (!messages.length || messages.some((m) => !m || typeof m !== "object")) {
      return res.status(400).json(rpcErr(null, RPC.INVALID_REQUEST, "invalid JSON-RPC payload"));
    }

    const responses = [];

    for (const msg of messages) {
      const { id, method, params } = msg;
      const isNotification = id === undefined || id === null;

      switch (method) {
        case "initialize": {
          const wanted = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : DEFAULT_PROTOCOL;
          responses.push(
            rpcOk(id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
              instructions:
                "北名大小助手：代取撮合 / 搭子匹配 / 迎新导览 / 日程提醒。只读演示令牌，限频 30 次/分钟。",
            }),
          );
          break;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
        case "notifications/roots/list_changed": {
          // 通知不需要响应
          break;
        }
        case "ping": {
          if (!isNotification) responses.push(rpcOk(id, {}));
          break;
        }
        case "tools/list": {
          responses.push(rpcOk(id, { tools: listToolSchemas() }));
          break;
        }
        case "tools/call": {
          // 限频只卡"工具调用"粒度：30 次/分钟
          const gate = tryConsume(mcpLimiter, req);
          if (!gate.allowed) {
            res.setHeader("Retry-After", String(gate.retryAfter ?? 60));
            responses.push(rpcErr(id, RPC.APP_ERROR, "rate limit exceeded", { code: "QUOTA" }));
            break;
          }
          const name = params?.name;
          const args = params?.arguments ?? {};
          if (!name || typeof name !== "string") {
            responses.push(rpcErr(id, RPC.INVALID_PARAMS, "params.name is required"));
            break;
          }
          const envelope = await callTool(name, args, { req, transport: "mcp" });
          responses.push(
            rpcOk(id, {
              content: [{ type: "text", text: JSON.stringify(envelope) }],
              structuredContent: envelope,
              isError: envelope.ok === false,
            }),
          );
          break;
        }
        default: {
          if (!isNotification) {
            responses.push(rpcErr(id, RPC.METHOD_NOT_FOUND, `method not found: ${method}`));
          }
        }
      }
    }

    if (!responses.length) return res.status(202).end();
    return res.status(batch ? 200 : 200).json(batch ? responses : responses[0]);
  });

  return router;
}

export default { createMcpRouter };
