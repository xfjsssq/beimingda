/**
 * /takeout 看单为主改造 · 单测（node:test）
 *
 *   npm test      （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 覆盖三块：
 *   1) 页面静态契约（不是行为测试，但改坏了会立刻红）：
 *      · 第一屏是开放任务看板；发布 / 登记收进 .toolbar 两个按钮 + createSheet 侧栏
 *      · 「查看匹配」这个独立动作必须消失；候选直接铺在卡片里（含 score / reason）
 *      · 页面上没有任何令牌输入框（令牌由服务端注入，前端自动带 X-Demo-Token）
 *      · 图标一律 vendor/tabler svg，⛔ 无 emoji；上传控件只剩一处
 *   2) service `setMatchState`：状态机与错误码
 *   3) HTTP `POST /api/matches/:id/accept` / `:id/decline`：鉴权、状态迁移、重复操作被拒
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

// 独立临时库 + 只在测试里用的假令牌
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-ui-takeout-${process.pid}.db`);
process.env.DEMO_TOKEN = "ui-takeout-token";
try {
  fs.unlinkSync(process.env.DB_PATH);
} catch {
  /* 首次运行没有旧库是正常的 */
}

const { initDb, getDb } = await import("../src/db/index.js");
const { publishTask, matchForTask, setMatchState, MATCH_STATES } = await import("../src/services/task.js");
const { registerRunner } = await import("../src/services/runner.js");

initDb();

const PAGE = fs.readFileSync(path.join(ROOT, "static", "takeout.html"), "utf8");

const NOW = Math.floor(Date.now() / 1000);
const isoIn = (min) => new Date((NOW + min * 60) * 1000).toISOString();

let handleSeq = 0;
const nextHandle = () => `看单跑腿${++handleSeq}`;

/** 造一条「任务 + 一条 pushed 撮合记录」，返回 {task_id, match_id} */
function seedTaskAndMatch() {
  getDb().prepare("UPDATE runners SET active = 0").run(); // 候选池只有本用例刚登记的那一个
  registerRunner({
    user_handle: nextHandle(),
    reachable_buildings: ["12号宿舍楼", "15号宿舍楼"],
    reward_floor: 1,
    time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(300) }],
  });
  const { task_id } = publishTask({
    from_building: "12号宿舍楼",
    to_building: "15号宿舍楼",
    station: "快递驿站",
    deadline_iso: isoIn(240),
    reward_min: 3,
    reward_max: 5,
    owner_handle: "测试同学",
  });
  const matched = matchForTask(task_id, { now: NOW, topK: 3 });
  const pushed = matched.matches.find((m) => m.state === "pushed" && m.match_id);
  assert.ok(pushed, "撮合必须至少推出一条 pushed 记录");
  return { task_id, match_id: pushed.match_id };
}

/* ============================================================ 1) 页面静态契约 */

test("/takeout：第一屏是开放任务看板，发布 / 登记收进 .toolbar 两个按钮", () => {
  const boardAt = PAGE.indexOf('id="board"');
  assert.ok(boardAt > 0, "必须有看板容器 #board");
  // 侧栏是懒建/预建在 JS 里的，看板必须出现在页面骨架中
  assert.match(PAGE, /<div class="toolbar">/);
  assert.match(PAGE, /id="btn-open-publish"/);
  assert.match(PAGE, /id="btn-open-register"/);
  assert.ok(PAGE.includes("发布代取") && PAGE.includes("登记跑腿能力"), "工具栏两个按钮文案");
  // 侧栏用 createSheet()（≤640px 变底部面板是 .sheet 的 CSS 职责）
  assert.match(PAGE, /createSheet\(\{/);
  // 看板在最前面：工具栏在用 <main> 里、看板 section 紧跟其后
  assert.ok(PAGE.indexOf('class="toolbar"') < boardAt, "工具栏在看板之前");
});

test("/takeout：干掉「查看匹配」，候选直接铺在卡片里（含 score / reason 原文）", () => {
  assert.ok(!PAGE.includes("查看匹配"), "不许再出现「查看匹配」按钮 / 文案");
  for (const text of ["接这一单", "系统已为你找到", "选 TA 接单", "已接单 · 进行中", "暂时没人顺路"]) {
    assert.ok(PAGE.includes(text), `/takeout 必须出现「${text}」`);
  }
  assert.match(PAGE, /score__num/);
  assert.match(PAGE, /reason: /);
  // 无候选时用插画空态（⛔ 不用 emoji）
  assert.match(PAGE, /\/img\/empty-state\.png/);
  assert.match(PAGE, /class="empty-art"|"empty-art"/);
});

test("/takeout：页面上没有任何令牌输入框，「演示令牌」文案消失", () => {
  assert.ok(!PAGE.includes("演示令牌"), "不许再出现「演示令牌」");
  assert.doesNotMatch(PAGE, /type="password"/, "不许有密码 / 令牌输入框");
  assert.doesNotMatch(PAGE, /id="tk"/, "旧的令牌输入框必须删掉");
  assert.doesNotMatch(PAGE, /setApiToken\s*\(/, "页面不再自己设置令牌（令牌由服务端注入）");
  assert.doesNotMatch(PAGE, /DEMO_TOKEN\s*[:=]\s*["'][^"']{6,}["']/, "页面不许硬编码令牌");
  // 内置链路仍在：/config.js 注入 → /js/api.js 自动带 X-Demo-Token
  assert.match(PAGE, /\/config\.js/);
  assert.match(PAGE, /from "\/js\/api\.js"/);
  assert.match(PAGE, /hasWriteToken\(\)/);
  assert.match(PAGE, /已由服务端配置/);
});

test("/takeout：图标走 vendor/tabler svg、⛔ 无 emoji、⛔ 无外链", () => {
  assert.match(PAGE, /\/vendor\/tabler\/icons\//, "图标必须用本地 Tabler svg");
  assert.match(PAGE, /class="icon icon--/);
  // 图标位一律 .icon + svg：把旧版用过的符号 emoji 逐个钉死
  for (const bad of ["📦", "🎯", "✅", "⚠️", "❌", "🗂️", "🔎"]) {
    assert.ok(!PAGE.includes(bad), `⛔ 页面不许用 ${bad} 当图标`);
  }
  // 通用 emoji / 图形符号区间（保留 U+26D4 ⛔ —— 它是全仓注释约定，不是界面图标）
  assert.doesNotMatch(
    PAGE,
    /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2600}-\u{26D3}\u{26D5}-\u{26FF}\u{2700}-\u{27BF}]/u,
    "⛔ 页面上不许出现 emoji",
  );
  assert.doesNotMatch(PAGE, /https?:\/\//, "⛔ 不引外部 CDN（断网可跑）");
  // 复用全站共享层
  for (const mod of ["/js/api.js", "/js/nav.js", "/js/demo.js", "/js/ui.js"]) {
    assert.ok(PAGE.includes(mod), `必须复用 ${mod}`);
  }
  const srcs = [...PAGE.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/config.js"], "外链脚本只允许 /config.js");
});

test("/takeout：截图上传控件仍在，且全页只有这一处 input[type=file]", () => {
  assert.equal((PAGE.match(/type="file"/g) || []).length, 1, "只允许一处上传控件（frontend.md §7）");
  assert.match(PAGE, /id="p-shot"/);
});

/* ============================================================ 2) service */

test("setMatchState：pushed → accepted 成功；只有 pushed 能被改；不存在 → NOT_FOUND", () => {
  assert.deepEqual([...MATCH_STATES], ["pushed", "accepted", "declined", "expired"]);

  const { task_id, match_id } = seedTaskAndMatch();
  const out = setMatchState(match_id, "accepted");
  assert.deepEqual(out, { match_id, task_id, state: "accepted" });
  assert.equal(getDb().prepare("SELECT state FROM matches WHERE id = ?").get(match_id).state, "accepted");

  // 二次改（accepted → declined）必须被拒，message 要说清当前状态
  assert.throws(
    () => setMatchState(match_id, "declined"),
    (e) => {
      assert.equal(e.code, "SCHEMA_REJECTED");
      assert.match(e.message, /accepted/, "message 必须说明当前状态");
      assert.match(e.message, /pushed/, "message 必须说明只有 pushed 能被改");
      return true;
    },
  );

  // 未知目标态
  assert.throws(() => setMatchState(match_id, "expired"), (e) => e.code === "SCHEMA_REJECTED");
  assert.throws(() => setMatchState(match_id, ""), (e) => e.code === "SCHEMA_REJECTED");

  // 记录不存在
  assert.throws(() => setMatchState("match_不存在", "accepted"), (e) => e.code === "NOT_FOUND");
  assert.throws(() => setMatchState("", "accepted"), (e) => e.code === "NOT_FOUND");
  assert.throws(() => setMatchState(null, "accepted"), (e) => e.code === "NOT_FOUND");
});

/* ============================================================ 3) HTTP */

test("HTTP /api/matches/:id/accept｜decline：鉴权 + 状态迁移 + 重复操作被拒", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = process.env.DEMO_TOKEN;
  const post = (p, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });

  try {
    const a = seedTaskAndMatch();

    // 1) 写接口必须带令牌
    const noToken = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`);
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).ok, false);

    // 2) 带令牌 → accepted，返回 {match_id, task_id, state}
    const accepted = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`, {
      "x-demo-token": token,
    }).then((r) => r.json());
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.data, { match_id: a.match_id, task_id: a.task_id, state: "accepted" });

    // 3) 再 accept 一次 → SCHEMA_REJECTED，message 说明当前状态
    const again = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`, {
      "x-demo-token": token,
    });
    assert.equal(again.status, 400);
    const againBody = await again.json();
    assert.equal(againBody.ok, false);
    assert.equal(againBody.error.code, "SCHEMA_REJECTED");
    assert.match(againBody.error.message, /accepted/);

    // 4) 只读口读得到这条 accepted（写进去的是真状态，前端刷新也准）
    const recent = await fetch(`${base}/api/matches?limit=50`).then((r) => r.json());
    assert.equal(recent.ok, true);
    assert.ok(Array.isArray(recent.data));
    const hit = recent.data.find((m) => m.match_id === a.match_id);
    assert.ok(hit, "刚接单的撮合记录必须出现在最近撮合里");
    assert.equal(hit.state, "accepted");
    assert.equal(hit.task_id, a.task_id);
    assert.ok(!("runner_id" in hit), "⛔ 只读口仍然只出昵称，不出内部 id");

    // 5) decline：另一条记录 → declined
    const b = seedTaskAndMatch();
    const declined = await post(`/api/matches/${encodeURIComponent(b.match_id)}/decline`, {
      "x-demo-token": token,
    }).then((r) => r.json());
    assert.equal(declined.ok, true);
    assert.equal(declined.data.state, "declined");
    assert.equal(declined.data.task_id, b.task_id);

    // 6) 拒单后再拒 → SCHEMA_REJECTED（只有 pushed 能被改）
    const twice = await post(`/api/matches/${encodeURIComponent(b.match_id)}/decline`, {
      "x-demo-token": token,
    }).then((r) => r.json());
    assert.equal(twice.error.code, "SCHEMA_REJECTED");
    assert.match(twice.error.message, /declined/);

    // 7) 记录不存在 → NOT_FOUND / 404
    const missing = await post(`/api/matches/${encodeURIComponent("match_不存在")}/accept`, {
      "x-demo-token": token,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    // 8) 状态机没被写坏：库里只会出现契约里那四个值
    const states = getDb().prepare("SELECT DISTINCT state FROM matches").all().map((r) => r.state);
    assert.ok(states.length > 0);
    for (const s of states) assert.ok(MATCH_STATES.includes(s), `非法状态被写进库：${s}`);
    assert.ok(states.includes("accepted") && states.includes("declined"));
  } finally {
    server.close();
  }
});
