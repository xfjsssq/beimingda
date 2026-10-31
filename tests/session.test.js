/**
 * 会话与"多用户"能力 · 单测（node:test）
 *
 *   npm test      （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 这个文件钉住 2026-10-31 新增的"让站点活起来"能力：
 *   1) 匿名开户：POST /api/session **不需要演示令牌**（否则真实用户进不来）
 *   2) 我是谁：GET /api/me 带会话令牌；令牌错/缺 → 401
 *   3) 改昵称：PATCH /api/me；⛔ 纯数字 / 11 位以上连续数字被拒（避免像学号/手机号）；重名给明确提示
 *   4) 归属：写入的身份来自**会话**，body 里伪造的 handle 不生效
 *   5) 交叉可见：甲发的单，乙在列表里看得见（这是"活起来"的核心）
 *   6) 令牌头严格错开：会话走 X-Session-Token，演示/MCP 走 Authorization / X-Demo-Token
 *      —— 两套混用会让写接口全部 401（这条踩过）
 *
 * ⛔ 用例只用自己的临时库（os.tmpdir），不碰 data/*.db。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-session-${process.pid}.db`);
process.env.DEMO_TOKEN = "session-test-token";
process.env.API_WRITE_LIMIT = "1000";
try { fs.unlinkSync(process.env.DB_PATH); } catch { /* 首次运行没有旧库是正常的 */ }

const { initDb, getDb } = await import("../src/db/index.js");
const { createApp } = await import("../src/server.js");
const { seedAll } = await import("../src/services/seed.js");

initDb();
seedAll(getDb(), { reset: true });

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const DEMO = { "X-Demo-Token": process.env.DEMO_TOKEN, "content-type": "application/json" };

async function call(method, p, body, { session, demo = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (demo) headers["X-Demo-Token"] = process.env.DEMO_TOKEN;
  if (session) headers["X-Session-Token"] = session;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, env: await res.json() };
}

const openSession = async (nickname) =>
  (await call("POST", "/api/session", nickname ? { nickname } : {}, { demo: false })).env.data;

test("会话：匿名开户不需要演示令牌，且拿到 token/uid/昵称", async () => {
  const r = await call("POST", "/api/session", {}, { demo: false });
  assert.equal(r.status, 200);
  assert.equal(r.env.ok, true, JSON.stringify(r.env.error));
  assert.ok(r.env.data.token && r.env.data.token.length >= 32, "token 要有足够长度");
  assert.match(r.env.data.uid, /^u-/, "uid 由服务端签发");
  assert.ok(r.env.data.nickname, "要有昵称（不填就自动给一个）");
});

test("会话：库里的 token 只存 sha256，⛔ 不存明文", async () => {
  const s = await openSession("哈希检查同学");
  const row = getDb().prepare("SELECT token_hash FROM sessions WHERE user_id = ?").get(s.uid);
  assert.ok(row, "会话应落库");
  assert.notEqual(row.token_hash, s.token, "⛔ 不许存明文 token");
  assert.match(row.token_hash, /^[0-9a-f]{64}$/, "应是 sha256 十六进制");
});

test("/api/me：带会话令牌可用；缺令牌 401；演示令牌不能冒充会话", async () => {
  const s = await openSession("我是谁同学");
  const okRes = await call("GET", "/api/me", undefined, { session: s.token, demo: false });
  assert.equal(okRes.env.ok, true);
  assert.equal(okRes.env.data.nickname, s.nickname);
  assert.ok(okRes.env.data.stats && typeof okRes.env.data.stats.tasks_published === "number", "要带活动量");

  const none = await call("GET", "/api/me", undefined, { demo: false });
  assert.equal(none.status, 401);

  // ⛔ 把演示令牌当会话令牌用 → 必须是 401（不是 200，也不能炸成 500）
  const wrong = await call("GET", "/api/me", undefined, { session: process.env.DEMO_TOKEN, demo: false });
  assert.equal(wrong.status, 401);
});

test("改名：合法昵称生效；纯数字 / 超长 / 含 11 位以上数字串被拒", async () => {
  const s = await openSession("改名前同学");
  const ok = await call("PATCH", "/api/me", { nickname: "改好了同学" }, { session: s.token, demo: false });
  assert.equal(ok.env.ok, true, JSON.stringify(ok.env.error));
  assert.equal(ok.env.data.nickname, "改好了同学");

  for (const bad of ["20230101", "13800138000", "a", "这个昵称实在是太长了超过十二个字了吧", "带 空格 的"]) {
    const r = await call("PATCH", "/api/me", { nickname: bad }, { session: s.token, demo: false });
    assert.equal(r.env.ok, false, `「${bad}」应当被拒`);
    assert.equal(r.env.error.code, "SCHEMA_REJECTED");
  }
});

test("改名：重名给明确提示（不是 INTERNAL）", async () => {
  const a = await openSession("重名同学甲");
  const b = await openSession("重名同学乙");
  const r = await call("PATCH", "/api/me", { nickname: a.nickname }, { session: b.token, demo: false });
  assert.equal(r.env.ok, false);
  assert.equal(r.env.error.code, "SCHEMA_REJECTED");
  assert.match(r.env.error.message, /已经有人用了/, "要说清是重名，别让人猜");
});

test("归属：写入的身份来自会话，body 里伪造的 handle 不生效", async () => {
  const A = await openSession("归属甲同学");
  const task = await call("POST", "/api/tasks", {
    owner_handle: "伪造的名字",
    from_building: "快递驿站", to_building: "12号宿舍楼", station: "快递驿站",
    reward_min: 3, reward_max: 6,
    deadline_iso: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, "Z"),
  }, { session: A.token });
  assert.equal(task.env.ok, true, JSON.stringify(task.env.error));

  const detail = getDb().prepare("SELECT u.handle FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.id = ?")
    .get(task.env.data.task_id);
  assert.equal(detail.handle, A.nickname, "归属必须是会话身份，⛔ 不是 body 里那个");
});

test("交叉可见：甲发的单，乙在列表中看得见（含甲的名字与信息）", async () => {
  const A = await openSession("可见甲同学");
  const B = await openSession("可见乙同学");
  const task = await call("POST", "/api/tasks", {
    from_building: "快递驿站", to_building: "第一食堂", station: "快递驿站",
    reward_min: 4, reward_max: 8,
    deadline_iso: new Date(Date.now() + 7200e3).toISOString().replace(/\.\d+Z$/, "Z"),
  }, { session: A.token });
  assert.equal(task.env.ok, true);

  const list = await call("GET", "/api/tasks?limit=50", undefined, { session: B.token, demo: false });
  const hit = list.env.data.find((t) => t.task_id === task.env.data.task_id);
  assert.ok(hit, "乙应当看得见甲发的单");
  assert.equal(hit.owner_handle, A.nickname, "列表要显示发布者的昵称");

  // 乙表达意愿 → 归属乙（甲能看到"谁想接"）
  const interest = await call("POST", `/api/tasks/${task.env.data.task_id}/interest`, {}, { session: B.token });
  assert.equal(interest.env.ok, true, JSON.stringify(interest.env.error));
  assert.equal(interest.env.data.runner_handle, B.nickname, "意愿要记在乙名下");

  const matches = await call("GET", "/api/matches?limit=50", undefined, { session: A.token, demo: false });
  const m = matches.env.data.find((x) => x.task_id === task.env.data.task_id && x.runner_handle === B.nickname);
  assert.ok(m, "发布者要能看到「谁想接这一单」");
});

test("交叉可见：搭子墙 —— 甲发帖，乙看得见并能留言，甲读得到", async () => {
  const A = await openSession("搭子甲同学");
  const B = await openSession("搭子乙同学");
  const post = await call("POST", "/api/buddies", {
    author_handle: "伪造发帖人", kind: "study",
    text_profile: "想找人一起自习，图书馆三楼，晚上七点",
  }, { session: A.token });
  assert.equal(post.env.ok, true, JSON.stringify(post.env.error));
  const pid = post.env.data.post_id;

  const feed = await call("GET", "/api/buddies?limit=50", undefined, { session: B.token, demo: false });
  assert.ok(feed.env.data.some((p) => p.post_id === pid), "乙应当看得见甲的帖");

  const msg = await call("POST", `/api/buddies/${pid}/reply`, { message: "我周三周四晚上都在图书馆" }, { session: B.token });
  assert.equal(msg.env.ok, true, JSON.stringify(msg.env.error));

  const msgs = await call("GET", `/api/buddies/${pid}/messages`, undefined, { demo: false });
  assert.equal(msgs.env.data.length >= 1, true);
  assert.equal(msgs.env.data.at(-1).from, B.nickname, "留言要能看出是谁留的");

  // 归属校验：帖子的作者应是甲
  const author = getDb().prepare("SELECT u.handle FROM buddy_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?").get(pid);
  assert.equal(author.handle, A.nickname);
});

test("令牌头分工：会话令牌放在 X-Demo-Token 里不算数（写接口仍要 401）", async () => {
  const s = await openSession("头分工同学");
  const res = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Demo-Token": s.token },   // ⛔ 拿会话令牌冒充演示令牌
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

test.after(() => server.close());
