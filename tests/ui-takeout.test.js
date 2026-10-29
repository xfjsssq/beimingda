/**
 * /takeout 看单为主改造 · 单测（node:test）
 *
 *   npm test      （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 覆盖四块：
 *   1) 页面静态契约（不是行为测试，但改坏了会立刻红）：
 *      · 功能收进左侧功能栏（桌面常驻 / 窄屏默认收起的抽屉），主区只留看板
 *      · 页头只留一句话；解释性长文案收进功能栏的「说明」
 *      · 卡片信息分层次；候选一行一个，超过 3 位折叠成「还有 N 位」
 *      · 「查看匹配」这个独立动作必须消失；候选直接铺在卡片里（含 score / reason）
 *      · 页面上没有任何令牌输入框（令牌由服务端注入，前端自动带 X-Demo-Token）
 *      · 图标一律 vendor/phosphor svg，⛔ 无 emoji；上传控件只剩一处
 *   2) 设计刻度：字阶只从 12/14/16/18/20/24/30/36/48/60 取，间距只从 0/2/4/8/12/16/24/32/40/48/64/80/96 取
 *   3) service `setMatchState`：状态机与错误码
 *   4) HTTP `POST /api/matches/:id/accept` / `:id/decline`：鉴权、状态迁移、重复操作被拒
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
/** 本页自己的 <style>（设计刻度只检查这一段，共享 app.css 不归本模块管） */
const STYLE = (PAGE.match(/<style>([\s\S]*?)<\/style>/) || [null, ""])[1];

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

test("/takeout：功能收进左侧功能栏，主区只留看板", () => {
  assert.ok(PAGE.includes('id="rail"'), "必须有左侧功能栏 #rail");
  assert.ok(PAGE.includes('class="shell"'), "必须有壳容器 .shell");
  assert.ok(PAGE.includes('id="board"'), "必须有看板容器 #board");
  // 功能栏在看板之前（左栏 → 主区）
  assert.ok(PAGE.indexOf('id="rail"') < PAGE.indexOf('id="board"'), "功能栏必须在看板之前");
  // 功能都在功能栏里
  for (const id of ["view-all", "view-mine", "btn-open-publish", "btn-open-register", "b-filter", "token-chip"]) {
    const at = PAGE.indexOf(`id="${id}"`);
    assert.ok(at > 0, `功能栏里应有 #${id}`);
    assert.ok(at > PAGE.indexOf('id="rail"') && at < PAGE.indexOf('id="board"'), `#${id} 应在功能栏内`);
  }
  for (const text of ["全部开放任务", "我的接单", "发布代取", "登记跑腿能力"]) {
    assert.ok(PAGE.includes(text), `功能栏里应有「${text}」`);
  }
  // 旧版顶部工具栏已撤掉（功能不再横着堆在看板上方）
  assert.ok(!PAGE.includes('<div class="toolbar">'), "⛔ 不该再有顶部 .toolbar 按钮条");
  // 侧栏表单仍然用 createSheet()（窄屏自动变底部面板）
  assert.match(PAGE, /createSheet\(\{/);
});

test("/takeout：页头只留一句话，长解释收进功能栏「说明」", () => {
  const lead = /<p class="lead">([^<]*)<\/p>/.exec(PAGE);
  assert.ok(lead, "页头应有一句短说明");
  assert.ok(lead[1].length <= 60, `页头说明要一句话（≤60 字），实际 ${lead[1].length} 字`);
  assert.ok(!PAGE.includes("page-head__tags"), "三个徽章不该再占页头（挪进功能栏说明里）");
  // 说明是收束起来的（details/summary），默认折叠
  assert.match(PAGE, /<details[^>]*class="rail__note"/);
  assert.match(PAGE, /<summary>说明<\/summary>/);
});

test("/takeout：桌面 ≥1024 常驻左栏；窄屏默认收起、点「功能」滑入", () => {
  // 桌面：两列栅格，左栏 240px，常驻（sticky）
  assert.match(
    PAGE,
    /@media \(min-width:1024px\)[\s\S]*?grid-template-columns:\s*240px minmax\(0,1fr\)/,
    "≥1024px 应是 240px 左栏 + 主区两列",
  );
  assert.match(PAGE, /@media \(min-width:1024px\)[\s\S]*?\.rail\s*\{[^}]*position:\s*sticky/,
    "≥1024px 功能栏应常驻（sticky）");
  // 窄屏：默认在屏幕外 + 抽屉遮罩；右下角「功能」按键负责展开
  assert.match(
    PAGE,
    /@media \(max-width:1023px\)[\s\S]*?transform:\s*translateX\(-100%\)/,
    "窄屏默认应收起（translateX(-100%)）",
  );
  assert.match(PAGE, /\.rail\.is-open\s*\{\s*transform:\s*none/, "展开态应是 .rail.is-open");
  assert.match(PAGE, /@media \(max-width:1023px\)[\s\S]*?\.rail-fab\s*\{[^}]*position:\s*fixed/,
    "窄屏应有固定的「功能」按键");
  assert.match(PAGE, /@media \(min-width:1024px\)[\s\S]*?\.rail-fab[^{]*\{[^}]*display:\s*none/,
    "≥1024px 应隐藏「功能」按键");
  // DOM 与 JS 都在：按键 / 关闭 / 遮罩 / Esc
  for (const id of ["rail-open", "rail-close", "rail-backdrop"]) {
    assert.ok(PAGE.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(PAGE, /railFab\.addEventListener\("click", openRail\)/);
  assert.match(PAGE, /railBackdrop\.addEventListener\("click", closeRail\)/);
  assert.match(PAGE, /id="rail-open"[\s\S]*?aria-expanded="false"/, "「功能」按键默认 aria-expanded=false");
});

test("/takeout：看板卡片分层次，候选一行一个，超 3 位折叠成「还有 N 位」", () => {
  // 卡片层次：路径大字 / 小字信息 / 备注 / 候选入口 / 底部操作
  for (const cls of ["tk-card__route", "tk-card__meta", "tk-card__note", "tk-card__cands", "tk-card__foot", "tk-card__action"]) {
    assert.ok(PAGE.includes(cls), `卡片缺少层次容器 .${cls}`);
  }
  assert.match(PAGE, /\.tk-card__route\s*\{[^}]*font-size:\s*20px/, "楼栋路径应是大字（20px）");
  assert.match(PAGE, /is-cut/, "备注应支持一行省略");
  // 候选：一行一个 + 超过 3 位折叠
  assert.match(PAGE, /CAND_SHOWN\s*=\s*3/, "候选展示上限应为 3");
  assert.match(PAGE, /list\.slice\(0,\s*CAND_SHOWN\)/);
  assert.match(PAGE, /list\.slice\(CAND_SHOWN\)/);
  assert.match(PAGE, /还有 "\s*\+\s*rest\.length\s*\+\s*"\s*位顺路的同学/, "多于 3 位应折叠成「还有 N 位」");
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

test("/takeout：图标走 vendor/phosphor svg、⛔ 无 emoji、⛔ 无外链", () => {
  assert.match(PAGE, /\/vendor\/phosphor\/icons\//, "图标必须用本地 Phosphor svg");
  assert.match(PAGE, /class="icon icon--/);
  assert.doesNotMatch(PAGE, /\/vendor\/tabler\//, "旧 Tabler 图标已全站换成 Phosphor");
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

/* ============================================================ 2) 设计刻度 */

test("/takeout：字阶只从 12/14/16/18/20/24/30/36/48/60 取，间距只从 0/2/4/…/96 取", () => {
  const FONT_STEPS = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60];
  const SPACE_STEPS = [0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96];
  assert.ok(STYLE.length > 200, "应该能取到本页自己的 <style>");

  // 字阶：要么是刻度里的 px，要么是共享的 --size-* 令牌
  const fonts = [...STYLE.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(fonts.length > 0, "本页应至少有字号声明");
  for (const v of fonts) {
    if (/^var\(--size-/.test(v)) continue;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
    assert.ok(px, `字号只能写成刻度 px 或 --size-* 令牌：${v}`);
    assert.ok(FONT_STEPS.includes(Number(px[1])), `字号只允许 12/14/16/18/20/24/30/36/48/60，实际 ${v}`);
  }

  // 间距：gap / padding / margin 里的 px 必须在刻度里（0 与 var(--sp-*) 天然合法）
  const decls = [
    ...STYLE.matchAll(
      /(?:^|[;{])\s*(gap|row-gap|column-gap|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left)\s*:\s*([^;}]+)/gm,
    ),
  ];
  assert.ok(decls.length > 0, "本页应至少有间距声明");
  for (const [, prop, value] of decls) {
    for (const px of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
      assert.ok(
        SPACE_STEPS.includes(Number(px[1])),
        `间距只能用 0/2/4/8/12/16/24/32/40/48/64/80/96，${prop}: ${value.trim()} 用了 ${px[0]}`,
      );
    }
  }
});

/* ============================================================ 3) service */

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

/* ============================================================ 4) HTTP */

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
