/**
 * 鉴权（冻版）
 *   - DEMO_TOKEN 只从 process.env 读，⛔ 代码里一个字都不许硬编码
 *   - MCP 端点：Authorization: Bearer <DEMO_TOKEN>，兼容不带 Bearer 前缀的裸 token
 *   - HTTP 写接口：X-Demo-Token 头
 *   - 令牌设计为只读 + 限频 + 短周期轮换，泄露无风险
 */
import crypto from "node:crypto";
import { err, CODES } from "../util/envelope.js";

export function demoToken() {
  return process.env.DEMO_TOKEN || "";
}

/** 从请求里取出候选 token（MCP 与 HTTP 两套头都认） */
export function extractToken(req) {
  const auth = req.get?.("authorization") || req.headers?.authorization || "";
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
    return (m ? m[1] : String(auth)).trim();
  }
  const x = req.get?.("x-demo-token") || req.headers?.["x-demo-token"] || "";
  return String(x).trim();
}

/** 定长比较，避免时序侧信道 */
export function tokenMatches(candidate) {
  const expected = demoToken();
  if (!expected || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function deny(res) {
  return res
    .status(401)
    .json(err(CODES.SCHEMA_REJECTED, "invalid or missing DEMO_TOKEN"));
}

/** MCP 端点鉴权：任何情况下都必须带对令牌 */
export function requireMcpToken(req, res, next) {
  if (tokenMatches(extractToken(req))) return next();
  return deny(res);
}

/** HTTP 写接口鉴权（读接口开放） */
export function requireWriteToken(req, res, next) {
  if (tokenMatches(extractToken(req))) return next();
  return deny(res);
}

/** 只读模式开关：DEMO_TOKEN 未配置时，写接口一律拒绝（宁可拒也不放开） */
export function isDemoReadOnly() {
  return process.env.DEMO_READONLY === "1";
}

export default { demoToken, extractToken, tokenMatches, requireMcpToken, requireWriteToken };
