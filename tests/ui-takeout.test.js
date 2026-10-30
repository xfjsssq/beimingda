/**
 * /takeout 看单为主 + 权限模型 · 单测（node:test）
 *
 *   npm test      （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 覆盖五块：
 *   1) 页面静态契约（不是行为测试，但改坏了会立刻红）：
 *      · 功能收进左侧功能栏（桌面常驻 / 窄屏默认收起的抽屉），主区只留看板
 *      · 页头只留一句话；解释性长文案收进功能栏的「说明」
 *      · 卡片信息分层次；候选一行一个，超过 3 位折叠成「还有 N 位」
 *      · ⭐ 权限模型：只有「我发布的单」才列候选、才有「选 TA 接单」；
 *        别人的单只能「我想接这一单」表达意愿，⛔ 不许出现替别人挑人的按钮
 *      · 页面上 ⛔ 没有任何凭据字样 / 输入框（演示身份由服务端注入）
 *      · 发布可带取件照片（前端压到 ≤120KB 的 dataURL），卡片上有 96px 缩略图 + 点击放大
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

// 独立临时库 + 只在测试里用的假凭据
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
/** 取一段源码做结构断言（比整页正则精确） */
const slice = (from, to) => PAGE.slice(PAGE.indexOf(from), PAGE.indexOf(to));

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
  assert.ok(PAGE.indexOf('id="rail"') < PAGE.indexOf('id="board"'), "功能栏必须在看板之前");
  for (const id of ["view-all", "view-mine", "btn-open-publish", "btn-open-register", "b-filter"]) {
    const at = PAGE.indexOf(`id="${id}"`);
    assert.ok(at > 0, `功能栏里应有 #${id}`);
    assert.ok(at > PAGE.indexOf('id="rail"') && at < PAGE.indexOf('id="board"'), `#${id} 应在功能栏内`);
  }
  for (const text of ["全部开放任务", "我的接单", "发布代取", "登记跑腿能力"]) {
    assert.ok(PAGE.includes(text), `功能栏里应有「${text}」`);
  }
  assert.ok(!PAGE.includes('<div class="toolbar">'), "⛔ 不该再有顶部 .toolbar 按钮条");
  assert.match(PAGE, /createSheet\(\{/);
});

test("/takeout：页头只留一句话，长解释收进功能栏「说明」", () => {
  const lead = /<p class="lead">([^<]*)<\/p>/.exec(PAGE);
  assert.ok(lead, "页头应有一句短说明");
  assert.ok(lead[1].length <= 60, `页头说明要一句话（≤60 字），实际 ${lead[1].length} 字`);
  assert.ok(!PAGE.includes("page-head__tags"), "三个徽章不该再占页头（挪进功能栏说明里）");
  assert.match(PAGE, /<details[^>]*class="rail__note"/);
  assert.match(PAGE, /<summary>说明<\/summary>/);
});

test("/takeout：桌面 ≥1024 常驻左栏；窄屏默认收起、点「功能」滑入", () => {
  assert.match(
    PAGE,
    /@media \(min-width:1024px\)[\s\S]*?grid-template-columns:\s*240px minmax\(0,1fr\)/,
    "≥1024px 应是 240px 左栏 + 主区两列",
  );
  assert.match(PAGE, /@media \(min-width:1024px\)[\s\S]*?\.rail\s*\{[^}]*position:\s*sticky/,
    "≥1024px 功能栏应常驻（sticky）");
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
  for (const id of ["rail-open", "rail-close", "rail-backdrop"]) {
    assert.ok(PAGE.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(PAGE, /railFab\.addEventListener\("click", openRail\)/);
  assert.match(PAGE, /railBackdrop\.addEventListener\("click", closeRail\)/);
  assert.match(PAGE, /id="rail-open"[\s\S]*?aria-expanded="false"/, "「功能」按键默认 aria-expanded=false");
});

test("/takeout：看板卡片分层次，候选一行一个，超 3 位折叠成「还有 N 位」", () => {
  for (const cls of ["tk-card__route", "tk-card__meta", "tk-card__note", "tk-card__cands", "tk-card__foot", "tk-card__action"]) {
    assert.ok(PAGE.includes(cls), `卡片缺少层次容器 .${cls}`);
  }
  assert.match(PAGE, /\.tk-card__route\s*\{[^}]*font-size:\s*20px/, "楼栋路径应是大字（20px）");
  assert.match(PAGE, /is-cut/, "备注应支持一行省略");
  assert.match(PAGE, /CAND_SHOWN\s*=\s*3/, "候选展示上限应为 3");
  assert.match(PAGE, /list\.slice\(0,\s*CAND_SHOWN\)/);
  assert.match(PAGE, /list\.slice\(CAND_SHOWN\)/);
  assert.match(PAGE, /还有 "\s*\+\s*rest\.length\s*\+\s*"\s*位顺路的同学/, "多于 3 位应折叠成「还有 N 位」");
});

test("/takeout：权限模型 —— 只有我发布的单能挑人派单", () => {
  // 演示身份固定为同学A，且按发布者字段判断
  assert.match(PAGE, /const ME = "同学A"/, "演示身份应固定为同学A");
  assert.match(PAGE, /publisher\s*\?\?\s*t\.owner_handle/, "要兼容 publisher / owner_handle 两种字段");
  assert.match(PAGE, /const isMine = \(t\) => publisherOf\(t\) === ME/);

  // 我发布的单：卡片有 .card--mine 外观（底纹 + 主色描边）与「我发布的」徽章
  assert.match(PAGE, /\.tk-card\.card--mine\s*\{[^}]*border-left:\s*3px solid var\(--color-primary\)/);
  assert.match(PAGE, /\.badge--mine\s*\{/, "应有「我发布的」徽章样式");
  assert.ok(PAGE.includes("我发布的"), "卡片上要有「我发布的」徽章文案");

  // 派单按钮只在候选行里、表达意愿按钮只在别人单的操作位里
  const candRowSrc = slice("function candRow", "function paintCandidates");
  assert.ok(candRowSrc.includes("选 TA 接单"), "候选行里应有「选 TA 接单」");
  assert.ok(!candRowSrc.includes("我想接这一单"), "候选行里 ⛔ 不该出现「我想接这一单」");
  const actionSrc = slice("function paintAction", "function candRow");
  assert.ok(actionSrc.includes("我想接这一单"), "别人的单主按钮应是「我想接这一单」");
  assert.ok(!actionSrc.includes("选 TA 接单"), "⛔ 别人的单上不许出现「选 TA 接单」");
  assert.ok(!PAGE.includes('"接这一单"'), "旧文案「接这一单」应已下线（现在只有「我想接这一单」）");

  // 别人的单不渲染候选，只给规则说明
  assert.match(PAGE, /if \(!isMine\(t\)\) \{[\s\S]{0,240}?只有发布者能看候选/);
  assert.ok(PAGE.includes("只有发布者能看候选、挑人派单"), "别人的单要说明权限规则");
  // 撮合只对我发布的单跑（⛔ 不替别人的单撮合）
  assert.match(PAGE, /if \(!isMine\(t\)\) \{\s*\n\s*state\.matches\.delete\(t\.task_id\)/);
  assert.match(PAGE, /state\.tasks\.filter\(isMine\), 3, \(t\) => runMatch/);

  // 表达意愿 / 撤回意愿 的文案与状态
  assert.ok(PAGE.includes("已表达意愿 · 等发布者确认"));
  assert.ok(PAGE.includes("撤回意愿"));
  assert.match(PAGE, /\/api\/tasks\/" \+ encodeURIComponent\(t\.task_id\) \+ "\/interest"/, "意愿走 /interest");
  assert.match(PAGE, /runner_handle: ME/, "意愿请求要带自己的昵称");
  // 派单带上发布者身份，服务端才能校验「只有发布者能派单」
  assert.match(PAGE, /body: \{ as: ME \}/, "派单要带 as=发布者");
});

test("/takeout：页面上没有任何凭据字样与控件", () => {
  assert.ok(!PAGE.includes("令牌"), "⛔ 页面上不许再出现「令牌」字样");
  assert.ok(!PAGE.includes("已由服务端配置"), "功能栏底部那句说明也要删掉");
  assert.ok(!PAGE.includes('id="token-chip"'), "令牌状态元素必须删掉");
  assert.doesNotMatch(PAGE, /type="password"/, "不许有密码 / 凭据输入框");
  assert.doesNotMatch(PAGE, /id="tk"/, "旧的凭据输入框必须删掉");
  assert.doesNotMatch(PAGE, /setApiToken\s*\(/, "页面不再自己设置凭据");
  assert.doesNotMatch(PAGE, /DEMO_TOKEN\s*[:=]\s*["'][^"']{6,}["']/, "页面不许硬编码凭据");
  assert.ok(!PAGE.includes("hasWriteToken"), "页面不再展示凭据状态");
  assert.match(PAGE, /\/config\.js/);
  assert.match(PAGE, /from "\/js\/api\.js"/);
});

test("/takeout：发布可带取件照片（压到 ≤120KB），卡片上有 96px 缩略图并可放大", () => {
  assert.ok(PAGE.includes("取件照片（可选）"), "文件选择要写成「取件照片（可选）」");
  assert.match(PAGE, /PHOTO_MAX_BYTES = 120 \* 1024/, "上限应是 120KB");
  assert.match(PAGE, /async function compressPhoto\(/, "应有前端压缩函数");
  assert.match(PAGE, /toDataURL\("image\/jpeg"/, "压缩成 jpeg dataURL");
  assert.match(PAGE, /dataUrlBytes\(dataUrl\)/, "要按 dataURL 估算字节数");
  // 提交时放进 payload.photo
  assert.match(PAGE, /body: withPhoto \? \{ \.\.\.base, photo: photo\.dataUrl \} : base/);
  // 服务端还没放开 photo 时去掉照片重发，不让照片挡住发布
  assert.match(PAGE, /非法字段\|photo/, "要有「服务端不认 photo 就去掉重发」的兜底");
  // 表单里显示缩略预览
  assert.match(PAGE, /id="photo-out"/, "表单里要有照片预览容器");
  assert.match(PAGE, /\.photo-pick img\s*\{[^}]*width:\s*96px/, "预览缩略图 96px");
  // 卡片缩略图 + 点击放大
  assert.match(PAGE, /\.tk-photo img\s*\{[^}]*width:\s*96px/, "卡片缩略图 96px");
  assert.match(PAGE, /function photoFigure\(t\)/, "卡片照片渲染函数");
  assert.match(PAGE, /openModal\(\{ title: "取件照片"/, "点击缩略图用 openModal 放大");
  assert.match(PAGE, /typeof t\.photo === "string"/, "photo 是可选字段");
});

test("/takeout：干掉「查看匹配」，候选直接铺在卡片里（含 score / reason 原文）", () => {
  assert.ok(!PAGE.includes("查看匹配"), "不许再出现「查看匹配」按钮 / 文案");
  for (const text of ["选 TA 接单", "我想接这一单", "系统已为你找到", "已接单 · 进行中", "暂时没人顺路"]) {
    assert.ok(PAGE.includes(text), `/takeout 必须出现「${text}」`);
  }
  assert.match(PAGE, /score__num/);
  assert.match(PAGE, /reason: /);
  assert.match(PAGE, /\/img\/empty-state\.png/);
  assert.match(PAGE, /class="empty-art"|"empty-art"/);
});

test("/takeout：图标走 vendor/phosphor svg、⛔ 无 emoji、⛔ 无外链", () => {
  assert.match(PAGE, /\/vendor\/phosphor\/icons\//, "图标必须用本地 Phosphor svg");
  assert.match(PAGE, /class="icon icon--/);
  assert.doesNotMatch(PAGE, /\/vendor\/tabler\//, "旧 Tabler 图标已全站换成 Phosphor");
  for (const bad of ["📦", "🎯", "✅", "⚠️", "❌", "🗂️", "🔎"]) {
    assert.ok(!PAGE.includes(bad), `⛔ 页面不许用 ${bad} 当图标`);
  }
  assert.doesNotMatch(
    PAGE,
    /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2600}-\u{26D3}\u{26D5}-\u{26FF}\u{2700}-\u{27BF}]/u,
    "⛔ 页面上不许出现 emoji",
  );
  assert.doesNotMatch(PAGE, /https?:\/\//, "⛔ 不引外部 CDN（断网可跑）");
  for (const mod of ["/js/api.js", "/js/nav.js", "/js/demo.js", "/js/ui.js"]) {
    assert.ok(PAGE.includes(mod), `必须复用 ${mod}`);
  }
  const srcs = [...PAGE.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/config.js"], "外链脚本只允许 /config.js");
});

test("/takeout：取件照片控件仍在，且全页只有这一处 input[type=file]", () => {
  assert.equal((PAGE.match(/type="file"/g) || []).length, 1, "只允许一处上传控件（frontend.md §7）");
  assert.match(PAGE, /id="p-shot"/);
});

/* ============================================================ 2) 设计刻度 */

test("/takeout：字阶只从 12/14/16/18/20/24/30/36/48/60 取，间距只从 0/2/4/…/96 取", () => {
  const FONT_STEPS = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60];
  const SPACE_STEPS = [0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96];
  assert.ok(STYLE.length > 200, "应该能取到本页自己的 <style>");

  const fonts = [...STYLE.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(fonts.length > 0, "本页应至少有字号声明");
  for (const v of fonts) {
    if (/^var\(--size-/.test(v)) continue;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
    assert.ok(px, `字号只能写成刻度 px 或 --size-* 令牌：${v}`);
    assert.ok(FONT_STEPS.includes(Number(px[1])), `字号只允许 12/14/16/18/20/24/30/36/48/60，实际 ${v}`);
  }

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

  assert.throws(
    () => setMatchState(match_id, "declined"),
    (e) => {
      assert.equal(e.code, "SCHEMA_REJECTED");
      assert.match(e.message, /accepted/, "message 必须说明当前状态");
      assert.match(e.message, /pushed/, "message 必须说明只有 pushed 能被改");
      return true;
    },
  );

  assert.throws(() => setMatchState(match_id, "expired"), (e) => e.code === "SCHEMA_REJECTED");
  assert.throws(() => setMatchState(match_id, ""), (e) => e.code === "SCHEMA_REJECTED");
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
  const post = (p, headers = {}, body = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    const a = seedTaskAndMatch();

    const noToken = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`);
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).ok, false);

    // 派单请求会带 as=发布者（服务端未就绪时忽略，就绪后用于校验发布者身份）
    const accepted = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`, {
      "x-demo-token": token,
    }, { as: "同学A" }).then((r) => r.json());
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.data, { match_id: a.match_id, task_id: a.task_id, state: "accepted" });

    const again = await post(`/api/matches/${encodeURIComponent(a.match_id)}/accept`, {
      "x-demo-token": token,
    }, { as: "同学A" });
    assert.equal(again.status, 400);
    const againBody = await again.json();
    assert.equal(againBody.ok, false);
    assert.equal(againBody.error.code, "SCHEMA_REJECTED");
    assert.match(againBody.error.message, /accepted/);

    const recent = await fetch(`${base}/api/matches?limit=50`).then((r) => r.json());
    assert.equal(recent.ok, true);
    assert.ok(Array.isArray(recent.data));
    const hit = recent.data.find((m) => m.match_id === a.match_id);
    assert.ok(hit, "刚派单的撮合记录必须出现在最近撮合里");
    assert.equal(hit.state, "accepted");
    assert.equal(hit.task_id, a.task_id);
    assert.ok(!("runner_id" in hit), "⛔ 只读口仍然只出昵称，不出内部 id");

    const b = seedTaskAndMatch();
    const declined = await post(`/api/matches/${encodeURIComponent(b.match_id)}/decline`, {
      "x-demo-token": token,
    }).then((r) => r.json());
    assert.equal(declined.ok, true);
    assert.equal(declined.data.state, "declined");
    assert.equal(declined.data.task_id, b.task_id);

    const twice = await post(`/api/matches/${encodeURIComponent(b.match_id)}/decline`, {
      "x-demo-token": token,
    }).then((r) => r.json());
    assert.equal(twice.error.code, "SCHEMA_REJECTED");
    assert.match(twice.error.message, /declined/);

    const missing = await post(`/api/matches/${encodeURIComponent("match_不存在")}/accept`, {
      "x-demo-token": token,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    const states = getDb().prepare("SELECT DISTINCT state FROM matches").all().map((r) => r.state);
    assert.ok(states.length > 0);
    for (const s of states) assert.ok(MATCH_STATES.includes(s), `非法状态被写进库：${s}`);
    assert.ok(states.includes("accepted") && states.includes("declined"));
  } finally {
    server.close();
  }
});
