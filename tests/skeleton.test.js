/**
 * T0 骨架单测（node:test）
 *   npm test
 * 模块分支请在自己的 tests/*.test.js 里补本模块的断言，不要改本文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 用例用独立临时库
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-test-${process.pid}.db`);
process.env.DEMO_TOKEN = "test-token-1234";

const { ok, err, CODES, AppError, toEnvelope, assertNoExtraKeys } = await import("../src/util/envelope.js");
const { toTs, toIso, isFutureIso } = await import("../src/util/time.js");
const { validateArgs, registerTool, resetTools, callTool, listToolSchemas } = await import("../src/mcp/tools.js");
const { createApp } = await import("../src/server.js");

test("信封：ok / err 形状固定", () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, data: { a: 1 }, error: null });
  assert.deepEqual(err(CODES.NOT_FOUND, "x"), {
    ok: false,
    data: null,
    error: { code: "NOT_FOUND", message: "x" },
  });
});

test("信封：AppError 归一化 + 非法错误码回落 INTERNAL", () => {
  const e = new AppError(CODES.SCHEMA_REJECTED, "bad");
  assert.deepEqual(toEnvelope(e), {
    ok: false,
    data: null,
    error: { code: "SCHEMA_REJECTED", message: "bad" },
  });
  assert.equal(new AppError("NOPE", "x").code, "INTERNAL");
  assert.equal(toEnvelope(new Error("boom")).error.code, "INTERNAL");
});

test("信封：assertNoExtraKeys 拦住多余字段", () => {
  assert.doesNotThrow(() => assertNoExtraKeys({ a: 1 }, ["a"]));
  assert.throws(() => assertNoExtraKeys({ a: 1, b: 2 }, ["a"]), /SCHEMA_REJECTED|非法字段/);
});

test("时间：Unix 秒 ↔ ISO 往返", () => {
  const iso = "2026-10-30T20:00:00.000Z";
  const ts = toTs(iso);
  assert.equal(typeof ts, "number");
  assert.equal(toIso(ts), iso);
  assert.equal(toTs("not-a-date"), null);
  assert.equal(toIso(null), null);
  assert.equal(isFutureIso("2030-01-01T00:00:00Z", ts), true);
});

test("schema.sql：9 张表 + 关键索引齐全", () => {
  const sql = fs.readFileSync(path.join(ROOT, "src/db/schema.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(tables, [
    "buddy_consents",
    "buddy_posts",
    "map_nodes",
    "matches",
    "runners",
    "schedule_items",
    "scrub_audit",
    "tasks",
    "users",
  ]);
  assert.match(sql, /idx_tasks_status_deadline/);
  assert.match(sql, /idx_matches_task/);
  assert.match(sql, /idx_sched_user_weekday/);
  assert.match(sql, /UNIQUE\(post_id, seeker_id\)/);
  // ⛔ 不许出现可存真实身份的字段
  for (const banned of ["student_no", "student_id", "phone", "mobile", "id_card", "real_name"]) {
    assert.ok(!sql.includes(banned), `schema 里出现禁字段 ${banned}`);
  }
});

test("MCP 工具注册表：additionalProperties 强制为 false", () => {
  resetTools();
  assert.throws(
    () =>
      registerTool("m-test", { name: "bad_tool", inputSchema: { type: "object" } }, async () => ({})),
    /additionalProperties/,
  );
  registerTool(
    "m-test",
    {
      name: "ok_tool",
      description: "demo",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    },
    async (args) => ({ echoed: args.a }),
  );
  assert.equal(listToolSchemas().length, 1);
  resetTools();
});

test("MCP 参数校验：required / 多余字段 / 类型", () => {
  const schema = {
    inputSchema: {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    },
  };
  assert.equal(validateArgs(schema, { a: "x" }).valid, true);
  assert.equal(validateArgs(schema, {}).valid, false);
  assert.equal(validateArgs(schema, { a: "x", b: 1 }).valid, false);
  assert.equal(validateArgs(schema, "not-object").valid, false);
});

test("callTool：未知工具 → NOT_FOUND，handler 抛错 → 信封", async () => {
  resetTools();
  const nf = await callTool("nope", {});
  assert.equal(nf.error.code, "NOT_FOUND");

  registerTool(
    "m-test",
    {
      name: "boom",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const { reject } = await import("../src/util/envelope.js");
      reject(CODES.SCHEMA_REJECTED, "nope");
    },
  );
  const env = await callTool("boom", {});
  assert.deepEqual(env, { ok: false, data: null, error: { code: "SCHEMA_REJECTED", message: "nope" } });
  resetTools();
});

test("HTTP：health 信封 + 404 信封 + MCP 鉴权", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.ok(health.data.version);

    const missing = await fetch(`${base}/api/nope`).then((r) => r.json());
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "NOT_FOUND");

    const unauth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauth.status, 401);

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DEMO_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }).then((r) => r.json());
    assert.deepEqual(list.result.tools, []);

    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DEMO_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    }).then((r) => r.json());
    assert.equal(init.result.serverInfo.name, "beimingda");
  } finally {
    server.close();
  }
});

test("数据库：初始化 + 外键开启 + 幂等建表", async () => {
  const { initDb, getDb } = await import("../src/db/index.js");
  initDb();
  const db = getDb();
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  initDb(); // 再跑一次不应抛
  const t = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get();
  assert.equal(t.name, "tasks");
});
