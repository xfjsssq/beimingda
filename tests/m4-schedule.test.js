/**
 * M4 · 日程与脱敏审计 —— 单元 + HTTP 测试
 *   npm test
 *
 * 重点覆盖契约 §9 的自测清单：
 *   - additionalProperties:false 生效
 *   - 即使绕过 schema 直接调 service，scrub.js 仍拦住禁字段
 *   - 审计只记字段名，绝不含值
 *   - period_end < period_start → SCHEMA_REJECTED
 *   - 重复导入不叠加
 *   - /api/scrub/audit 可查
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-m4-${process.pid}.db`);
process.env.DEMO_TOKEN = "test-token-1234";

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { callTool, resetTools } = await import("../src/mcp/tools.js");
const { SUITE } = await import("../src/util/envelope.js")
  .then(() => ({ SUITE: null }))
  .catch(() => ({ SUITE: null }));
const { scrubScheduleItems, sanitizeTitle, BLACKLIST, ALLOWLIST } = await import("../src/services/scrub.js");
const { importSchedule, addScheduleItem, querySchedule, listScrubAudit } = await import(
  "../src/services/schedule.js"
);
const { registerScheduleTools } = await import("../src/mcp/handlers/schedule.js");
const { createApp } = await import("../src/server.js");

// 只在黑名单常量与测试里出现的标记值，用来证明「审计绝不记值」
const SENTINELS = {
  name: "张三峰",
  studentNo: "20251234",
  teacher: "李师师",
  phone: "13900001111",
};

function freshDb() {
  closeDb();
  const db = initDb({ path: process.env.DB_PATH, force: true });
  db.prepare("DELETE FROM schedule_items").run();
  db.prepare("DELETE FROM scrub_audit").run();
  db.prepare("DELETE FROM users").run();
  return db;
}

test("白名单/黑名单常量与契约一致", () => {
  assert.deepEqual([...ALLOWLIST].sort(), ["period_end", "period_start", "room", "title", "weekday", "weeks"]);
  for (const f of ["name", "realName", "studentNo", "studentId", "stuNo", "teacher", "teacherName", "phone", "idCard"]) {
    assert.ok(BLACKLIST.includes(f), `黑名单缺 ${f}`);
  }
});

test("scrub：命中黑名单/白名单外字段 → 丢弃，且只记字段名", () => {
  const { clean, dropped } = scrubScheduleItems([
    {
      weekday: 1,
      period_start: 1,
      period_end: 2,
      title: "课程A",
      room: "教学楼A-101",
      weeks: "1-16",
      name: SENTINELS.name,
      studentNo: SENTINELS.studentNo,
      teacher: SENTINELS.teacher,
      phone: SENTINELS.phone,
      whatever: "x",
    },
  ]);
  assert.equal(clean.length, 1);
  assert.deepEqual(Object.keys(clean[0]).sort(), ["period_end", "period_start", "room", "title", "weekday", "weeks"]);
  assert.deepEqual(dropped.sort(), ["name", "phone", "studentNo", "teacher", "whatever"]);
  // ⛔ 字段名里不可能出现值
  for (const v of Object.values(SENTINELS)) {
    assert.ok(!JSON.stringify(dropped).includes(v), "dropped 里出现了字段值");
  }
});

test("title 去人名：括注/前缀/干净三种情况", () => {
  assert.equal(sanitizeTitle("课程A（教师甲老师）"), "课程A");
  assert.equal(sanitizeTitle("教师乙老师-课程B"), "课程B");
  assert.equal(sanitizeTitle("课程C"), "课程C");

  // 剥空 → 整条丢弃并记 title
  const { clean, dropped } = scrubScheduleItems([
    { weekday: 1, period_start: 1, period_end: 2, title: "教师甲老师" },
  ]);
  assert.equal(clean.length, 0);
  assert.ok(dropped.includes("title"));
  assert.ok(!JSON.stringify(dropped).includes("教师甲"), "被剥掉的字符串不得进审计");
});

test("⭐ 绕过 schema 直接调 service，scrub.js 仍拦下禁字段并写审计", () => {
  const db = freshDb();
  const res = importSchedule(db, {
    user_handle: "同学A",
    items: [
      {
        weekday: 2,
        period_start: 3,
        period_end: 4,
        title: "课程A（教师甲老师）",
        room: "教学楼A-101",
        weeks: "1-16",
        name: SENTINELS.name,
        realName: SENTINELS.name,
        studentNo: SENTINELS.studentNo,
        teacher: SENTINELS.teacher,
        phone: SENTINELS.phone,
      },
    ],
  });
  assert.equal(res.imported, 1);
  for (const f of ["name", "realName", "studentNo", "teacher", "phone"]) {
    assert.ok(res.dropped_fields.includes(f), `dropped_fields 缺 ${f}`);
  }
  // 库里只有白名单字段，且 title 已剥人名
  const rows = querySchedule(db, { user_handle: "同学A" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "课程A");
  const cols = db.prepare("PRAGMA table_info(schedule_items)").all().map((c) => c.name);
  for (const banned of ["name", "studentNo", "teacher", "phone"]) {
    assert.ok(!cols.includes(banned), `schedule_items 出现禁字段 ${banned}`);
  }
});

test("⭐ scrub_audit 只存字段名，绝不含任何值", () => {
  const db = freshDb();
  importSchedule(db, {
    user_handle: "同学B",
    items: [
      {
        weekday: 3,
        period_start: 1,
        period_end: 2,
        title: "课程B",
        name: SENTINELS.name,
        studentNo: SENTINELS.studentNo,
        teacher: SENTINELS.teacher,
      },
    ],
  });
  const audit = listScrubAudit(db, 20);
  assert.ok(audit.length >= 1, "应写入一条审计");
  const latest = audit[0];
  assert.equal(latest.item_type, "schedule");
  assert.ok(Array.isArray(latest.dropped_fields));
  assert.ok(latest.dropped_fields.includes("studentNo"));
  const raw = JSON.stringify(audit);
  for (const v of Object.values(SENTINELS)) {
    assert.ok(!raw.includes(v), `审计里出现了值 ${v}`);
  }
});

test("period_end < period_start → SCHEMA_REJECTED（service 层）", () => {
  const db = freshDb();
  assert.throws(
    () =>
      importSchedule(db, {
        user_handle: "同学A",
        items: [{ weekday: 1, period_start: 5, period_end: 3, title: "课程A" }],
      }),
    /SCHEMA_REJECTED|period_end/,
  );
  assert.throws(
    () => importSchedule(db, { user_handle: "同学A", items: [{ weekday: 9, period_start: 1, period_end: 2, title: "x" }] }),
    /SCHEMA_REJECTED|weekday/,
  );
});

test("MCP schema 层：items 里多传 studentNo → SCHEMA_REJECTED", async () => {
  freshDb();
  resetTools();
  registerScheduleTools();
  const env = await callTool("schedule_import", {
    user_handle: "同学A",
    items: [{ weekday: 1, period_start: 1, period_end: 2, title: "课程A", studentNo: SENTINELS.studentNo }],
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "SCHEMA_REJECTED");
  // ⛔ 错误信息里也不该回显值
  assert.ok(!JSON.stringify(env).includes(SENTINELS.studentNo));
});

test("MCP 路径：period_end < period_start → SCHEMA_REJECTED", async () => {
  freshDb();
  resetTools();
  registerScheduleTools();
  const env = await callTool("schedule_import", {
    user_handle: "同学A",
    items: [{ weekday: 1, period_start: 4, period_end: 2, title: "课程A" }],
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "SCHEMA_REJECTED");
});

test("重复导入不叠加（先清旧数据）", () => {
  const db = freshDb();
  const items = [
    { weekday: 1, period_start: 1, period_end: 2, title: "课程A" },
    { weekday: 2, period_start: 3, period_end: 4, title: "课程B" },
  ];
  importSchedule(db, { user_handle: "同学C", items });
  importSchedule(db, { user_handle: "同学C", items });
  const rows = querySchedule(db, { user_handle: "同学C" });
  assert.equal(rows.length, 2, "重复导入后条数不应翻倍");
  // 另一个用户不受影响
  importSchedule(db, { user_handle: "同学A", items: [items[0]] });
  assert.equal(querySchedule(db, { user_handle: "同学A" }).length, 1);
  assert.equal(querySchedule(db, { user_handle: "同学C" }).length, 2);
});

test("schedule_add / query / remove 全链路", async () => {
  const db = freshDb();
  resetTools();
  registerScheduleTools();
  const add = await callTool("schedule_add", {
    user_handle: "同学A",
    weekday: 4,
    period_start: 5,
    period_end: 6,
    title: "课程C（教师丙老师）",
    room: "实验楼C-101",
    remind_before: 15,
  });
  assert.equal(add.ok, true, JSON.stringify(add));
  assert.ok(add.data.item_id);

  const q = await callTool("schedule_query", { user_handle: "同学A" });
  assert.equal(q.ok, true);
  assert.equal(q.data.items.length, 1);
  assert.equal(q.data.items[0].title, "课程C");
  assert.equal(q.data.items[0].remind_before, 15);

  const rm = await callTool("schedule_remove", { item_id: add.data.item_id });
  assert.equal(rm.ok, true);
  const again = await callTool("schedule_remove", { item_id: add.data.item_id });
  assert.equal(again.error.code, "NOT_FOUND");
  closeDb();
});

test("HTTP：GET/POST /api/schedule 与 /api/scrub/audit", async () => {
  freshDb();
  resetTools(); // 让 createApp 内部的 loadHandlers 重新注册，避免重名
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // POST 写一条（带禁字段，应被 service 层拦下并记审计）
    // 契约 core.md §4：写接口必须带 X-Demo-Token
    const writeHeaders = { "content-type": "application/json", "x-demo-token": process.env.DEMO_TOKEN };
    const post = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        user_handle: "同学A",
        weekday: 5,
        period_start: 1,
        period_end: 2,
        title: "课程A（教师甲老师）",
        name: SENTINELS.name,
        studentNo: SENTINELS.studentNo,
      }),
    });
    const postBody = await post.json();
    assert.equal(postBody.ok, true, JSON.stringify(postBody));
    assert.ok(postBody.data.item_id);

    // GET 查回
    const get = await fetch(`${base}/api/schedule?handle=${encodeURIComponent("同学A")}`);
    const getBody = await get.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.data.length, 1);
    assert.equal(getBody.data[0].title, "课程A");

    // 审计可查，且无值
    const audit = await fetch(`${base}/api/scrub/audit?limit=20`);
    const auditBody = await audit.json();
    assert.equal(auditBody.ok, true);
    assert.ok(auditBody.data.length >= 1);
    const auditRaw = JSON.stringify(auditBody);
    assert.ok(auditBody.data[0].dropped_fields.includes("studentNo"));
    for (const v of Object.values(SENTINELS)) assert.ok(!auditRaw.includes(v), `审计出现值 ${v}`);

    // 坏区间 → SCHEMA_REJECTED
    const bad = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ user_handle: "同学A", weekday: 1, period_start: 6, period_end: 2, title: "课程B" }),
    });
    const badBody = await bad.json();
    assert.equal(badBody.ok, false);
    assert.equal(badBody.error.code, "SCHEMA_REJECTED");

    // 写接口无令牌 → 401（契约 core.md §4）
    const noToken = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_handle: "同学A", weekday: 1, period_start: 1, period_end: 2, title: "课程C" }),
    });
    assert.equal(noToken.status, 401, "POST /api/schedule 无 X-Demo-Token 必须 401");

    // ⛔ 不存在任何课表上传接口
    const up = await fetch(`${base}/api/schedule/upload`, { method: "POST" });
    const upBody = await up.json();
    assert.equal(upBody.ok, false);
    assert.equal(upBody.error.code, "NOT_FOUND");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("reminder.js --dry-run 能在测试数据上算出触发时刻", () => {
  const db = freshDb();
  // 今天（Asia/Shanghai）的 weekday
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short" });
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const todayWeekday = map[fmt.format(new Date())];

  importSchedule(db, {
    user_handle: "同学A",
    items: [{ weekday: todayWeekday, period_start: 1, period_end: 2, title: "课程A" }],
  });
  db.prepare("UPDATE schedule_items SET remind_before = 15").run();
  closeDb();

  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "reminder.js"), "--dry-run"], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: process.env.DB_PATH },
    encoding: "utf8",
  });
  assert.match(out, /\[dry-run\] now=/);
  assert.match(out, /第1节 提前15分钟/);
  assert.match(out, /课程A/);
});
