#!/usr/bin/env node
/**
 * 端到端冒烟自检（T0 交付项）—— 面试/自测用，一条命令跑完关键验收点。
 *
 *   npm run smoke
 *
 * 覆盖：
 *   1. GET /api/health 返回统一信封
 *   2. POST /mcp initialize 返回协议版本
 *   3. POST /mcp tools/list（工具数量随模块合入增长，M1 5 / M2 3 / M3 2 / M4 4 = 14）
 *   4. POST /mcp 错 token → 401
 *   5. 静态页与 /config.js 可访问
 *   6. schema.sql 的表清单与契约一致
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 独立临时库，避免污染开发库
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-smoke-${process.pid}.db`);
process.env.DEMO_TOKEN = process.env.DEMO_TOKEN || "smoke-token";

const { createApp } = await import("../src/server.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const callMcp = async (payload, token = process.env.DEMO_TOKEN) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

try {
  // 1. health
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check(
    "GET /api/health 走统一信封",
    health.ok === true && !!health.data?.version && !!health.data?.time,
    JSON.stringify(health.data),
  );

  // 2. initialize
  const init = await callMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "smoke", version: "1" } },
  }).then((r) => r.json());
  check(
    "POST /mcp initialize",
    init?.result?.serverInfo?.name === "beimingda" && !!init?.result?.protocolVersion,
    init?.result?.protocolVersion,
  );

  // 3. tools/list
  const list = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }).then((r) => r.json());
  const toolNames = (list?.result?.tools ?? []).map((t) => t.name);
  check(
    "POST /mcp tools/list 返回工具数组（数量随模块合入增长，M1 5 / M2 3 / M3 2 / M4 4 = 14）",
    Array.isArray(list?.result?.tools),
    `${toolNames.length} 个工具：${toolNames.join(",") || "（暂无）"}`,
  );

  // 4. 错 token
  const bad = await callMcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "wrong-token");
  check("POST /mcp 错 token → 401", bad.status === 401, `HTTP ${bad.status}`);

  // 5. 静态与 config.js
  const idx = await fetch(`${base}/`);
  check("GET / 静态页可访问", idx.status === 200, `HTTP ${idx.status}`);
  const cfg = await fetch(`${base}/config.js`);
  const cfgText = await cfg.text();
  check(
    "GET /config.js 注入前端配置（不硬编码 tk）",
    cfg.status === 200 && cfgText.includes("__TILE_KEY__"),
  );

  // 6. schema 表清单与契约一致
  const sql = fs.readFileSync(path.join(ROOT, "src/db/schema.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  const expected = [
    "buddy_consents",
    "buddy_messages",
    "buddy_posts",
    "map_nodes",
    "matches",
    "runners",
    "schedule_items",
    "scrub_audit",
    "sessions",
    "tasks",
    "thread_messages",
    "threads",
    "users",
  ].sort();
  check(
    "schema.sql 表清单与 contracts/core.md §2 一致",
    JSON.stringify(tables) === JSON.stringify(expected),
    tables.join(","),
  );

  // 7. 密钥没被硬编码
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "data"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|json|sql)$/.test(e.name) && !p.includes("fixtures")) srcFiles.push(p);
    }
  };
  walk(ROOT);
  const hardcoded = srcFiles.filter((f) => {
    if (f.includes(`${path.sep}tests${path.sep}`)) return false; // 单测里写的是测试假 token
    if (f.endsWith("smoke.js")) return false; // 自检脚本自己含示例 token
    const t = fs.readFileSync(f, "utf8");
    return /(sk-[A-Za-z0-9]{16,}|tvly-|DEMO_TOKEN\s*[:=]\s*["'][^"']{6,}["'])/.test(t);
  });
  check("全仓无硬编码密钥", hardcoded.length === 0, hardcoded.join(","));
} finally {
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
// 用 exitCode 而不是 process.exit()，避免带着未关闭句柄强杀进程
process.exitCode = failed.length ? 1 : 0;
