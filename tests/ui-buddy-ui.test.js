/**
 * /buddy 搭子墙信息架构细化 · 单测（node:test）
 *
 *   npm test      （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 覆盖三块：
 *   1) 页面静态契约（不是行为测试，但改坏了会立刻红）：
 *      · 桌面 ≥1024px：左侧「功能栏」常驻（发帖 / 找搭子 / 我的申请），主区只放列表
 *      · 窄屏：功能栏默认收起，靠「功能」按钮从左侧滑入（transform: translateX(-100%)）
 *      · 卡片不单调：兴趣 chips、作息 24 小时段条、性格三项进度条、空态插画、揭示成功视觉
 *      · 图标一律 vendor/phosphor svg（.icon 写法）、⛔ 无 emoji、⛔ 无外链、⛔ 无上传控件
 *      · 令牌只走 /js/api.js 运行时链路；页面不回填、不硬编码
 *      · 候选只渲染白名单字段；contact_code 只在 reveal_status === "mutual" 时出现
 *      · 局部样式里的字号 / 间距只用设计令牌 --size-* / --sp-*
 *   2) 页面用到的本地静态资源真的存在（图标名写错会立刻红，而不是上线后变空白）
 *   3) 页面实际请求的 3 个 URL（含查询参数名）在后端真的可用（HTTP 走统一信封）
 *
 * ⛔ 用例只读文件 + 只用自己的临时库（os.tmpdir），不碰 data/*.db。
 * ⛔ 不改既有测试文件；本文件只覆盖 static/buddy.html 与它依赖的接口。
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
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-ui-buddy-${process.pid}.db`);
process.env.DEMO_TOKEN = "ui-buddy-token";
try {
  fs.unlinkSync(process.env.DB_PATH);
} catch {
  /* 首次运行没有旧库是正常的 */
}

const { initDb } = await import("../src/db/index.js");
const { publishPost } = await import("../src/services/buddy.js");
initDb();

const PAGE = fs.readFileSync(path.join(ROOT, "static", "buddy.html"), "utf8");
const STYLE = (PAGE.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const MODULE = [...PAGE.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join("\n");
const ICON_DIR = path.join(ROOT, "static", "vendor", "phosphor", "icons");

const STUDY_TEXT =
  "大二 工科 想找一起刷算法题和摄影的同学；作息偏夜猫；周末有空；周三1-2节有课";

/* ============================================================ 1) 静态契约 */

test("/buddy：桌面 ≥1024px 是「左功能栏 + 右主区」两栏，功能栏常驻", () => {
  // 两栏骨架
  assert.match(STYLE, /\.buddy-layout\s*\{[^}]*display:\s*grid/, "布局必须是 grid");
  assert.match(
    STYLE,
    /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*?\.buddy-layout\s*\{[^}]*grid-template-columns:\s*248px\s+minmax\(0,\s*1fr\)/,
    "≥1024px 必须是「固定宽功能栏 + 自适应主区」",
  );
  // 常驻：吸顶而不是抽屉
  assert.match(
    STYLE,
    /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*?\.buddy-rail\s*\{[^}]*position:\s*sticky/,
    "桌面功能栏应 sticky 常驻",
  );
  // 桌面隐藏抽屉开关与遮罩
  assert.match(STYLE, /\.buddy-rail__backdrop,\s*\.buddy-rail__toggle\s*\{\s*display:\s*none/, "桌面隐藏抽屉控件");
  // 三个功能都在侧栏里（按钮存在且有可读文案）
  assert.match(PAGE, /id="navPublish"[\s\S]{0,400}?发帖/, "侧栏缺「发帖」");
  assert.match(PAGE, /id="navSearch"[\s\S]{0,400}?找搭子/, "侧栏缺「找搭子」");
  assert.match(PAGE, /id="navMine"[\s\S]{0,400}?我的申请/, "侧栏缺「我的申请」");
  assert.match(PAGE, /<nav class="buddy-rail__nav"[^>]*aria-label="搭子功能"/, "功能栏应是 nav + aria-label");
});

test("/buddy：主区只留搭子帖列表（旧的 1/2/3/4 区块编号不再铺在页面上）", () => {
  assert.match(PAGE, /<section class="buddy-main"/, "主区容器");
  assert.match(PAGE, /id="listHost"/, "列表容器必须在主区");
  // 旧的「区块一/二/三/四」编号式排版已移除
  assert.doesNotMatch(PAGE, /class="section__index"/, "主区不应再是 4 个平铺区块");
  assert.doesNotMatch(PAGE, /<section class="section">\s*<h2 class="section__title">\s*<span class="section__index"/);
  // 三个功能改为从侧栏打开的面板（createSheet），不是页面上的大表单
  for (const fn of ["openPublishSheet", "openSearchSheet", "openMineSheet"]) {
    assert.ok(MODULE.includes(fn), `缺少功能入口 ${fn}`);
  }
  assert.match(MODULE, /createSheet\(/, "功能面板用共享层 createSheet 抽屉");
  assert.equal((MODULE.match(/createSheet\(/g) || []).length, 3, "发帖 / 找搭子 / 我的申请 三个抽屉");
});

test("/buddy：窄屏（<1024px）功能栏默认收起、从左侧滑入、可用 Esc 关掉", () => {
  assert.match(STYLE, /@media\s*\(max-width:\s*1023px\)/, "需要窄屏断点");
  assert.match(
    STYLE,
    /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.buddy-rail\s*\{[^}]*position:\s*fixed[\s\S]*?transform:\s*translateX\(-100%\)/,
    "窄屏默认必须移出屏幕（收起）",
  );
  assert.match(STYLE, /\.buddy-rail\.is-open\s*\{\s*transform:\s*none/, "点开后滑入");
  assert.match(PAGE, /id="btnRail"[\s\S]{0,300}?>[\s\S]{0,200}?功能/, "需要一个「功能」按钮");
  assert.match(PAGE, /id="btnRail"[^>]*aria-expanded="false"/, "开关要有可访问性状态");
  assert.match(PAGE, /aria-controls="buddyRail"/, "开关要指向功能栏");
  assert.match(PAGE, /id="railBackdrop"/, "遮罩");
  assert.match(MODULE, /classList\.add\("is-open"\)/, "打开抽屉");
  assert.match(MODULE, /classList\.remove\("is-open"\)/, "关闭抽屉");
  assert.match(MODULE, /e\.key === "Escape"[\s\S]{0,40}closeRail/, "Esc 关闭抽屉");
});

test("/buddy：卡片不再单调 —— 兴趣 chips / 作息 24 小时段条 / 性格三项进度条 / 忙时 chips", () => {
  // 兴趣标签
  assert.match(MODULE, /chip-row/, "兴趣用 chip-row");
  assert.match(MODULE, /chip chip--brand/, "兴趣高亮 chip");
  assert.match(MODULE, /未提及兴趣/, "未提及兴趣要如实说明（不编造）");
  // 作息小时段条
  assert.match(STYLE, /\.buddy-hours\s*\{[^}]*grid-template-columns:\s*repeat\(24,\s*minmax\(0,\s*1fr\)\)/, "24 小时段条");
  assert.match(MODULE, /for \(let h = 0; h < 24; h \+= 1\)/, "逐小时渲染");
  assert.match(MODULE, /early_bird/, "段条由画像 early_bird 推导");
  assert.match(MODULE, /作息倾向/, "段条要有可读结论");
  // 性格三项
  for (const [label, key] of [["话多", "chatty"], ["计划", "planner"], ["整洁", "tidy"]]) {
    assert.match(MODULE, new RegExp(`meterRow\\("${label}"`), `缺性格进度条 ${label}`);
    assert.ok(MODULE.includes(`traits.${key}`), `缺画像字段 ${key}`);
  }
  // 硬性要求 / 雷点（一票否决的可视化解释）
  assert.match(MODULE, /必须：/, "硬性要求 chip");
  assert.match(MODULE, /雷点：/, "雷点 chip");
  // 设计系统组件复用（不是自己造轮子）
  assert.match(MODULE, /meter meter--primary/, "进度条用设计系统的 .meter");
  assert.match(MODULE, /buddy-hours__ticks/, "段条要有刻度");
});

test("/buddy：空态用设计系统插画，双选揭示给明确的成功视觉（不是一行文字）", () => {
  // 空态插画
  assert.match(MODULE, /empty-art/, "空态用 .empty-art");
  assert.match(MODULE, /\/img\/empty-state\.png/, "空态插画路径");
  assert.ok(fs.existsSync(path.join(ROOT, "static", "img", "empty-state.png")), "插画文件必须存在");
  // 揭示成功视觉：容器 + 插画 + 光环动画 + 中转码 + 复制按钮 + 轻提示
  assert.match(STYLE, /\.buddy-reveal\b/, "成功视觉容器");
  assert.match(STYLE, /@keyframes\s+buddyRing/, "光环动画");
  assert.match(PAGE, /id="revealHost"/, "成功视觉落点");
  assert.match(MODULE, /\/img\/agent-connect\.png/, "成功视觉用「联系上了」插画");
  assert.ok(fs.existsSync(path.join(ROOT, "static", "img", "agent-connect.png")), "插画文件必须存在");
  assert.match(MODULE, /双方都点头了/, "成功文案");
  assert.match(MODULE, /buddy-reveal__code/, "中转码要突出显示");
  assert.match(MODULE, /toast\(/, "同时给轻提示");
  // 只能对「已互相可见」的候选庆祝
  assert.match(
    MODULE,
    /c\.reveal_status === "mutual" && !celebrated\.has\(c\.anon_token\)/,
    "只有 mutual 且没庆祝过的才给成功视觉",
  );
  // 减少动态偏好下不播放动画
  assert.match(STYLE, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,200}buddy-reveal__burst/, "尊重 reduced-motion");
});

test("/buddy：「我的申请」用时间线 + 状态徽章（不再只有一张表）", () => {
  assert.match(MODULE, /el\("ol",\s*"steps buddy-timeline"\)/, "时间线用设计系统 .steps");
  assert.match(MODULE, /step__num/, "时间线序号");
  for (const s of ["已互相可见", "待对方同意", "我已拒绝"]) {
    assert.ok(MODULE.includes(s), `状态徽章缺「${s}」`);
  }
  assert.match(MODULE, /badge badge--ok/, "互相可见 = 成功徽章");
  assert.match(MODULE, /badge badge--warn/, "待对方同意 = 提醒徽章");
  // 分数口径差异要如实说明（不假装两处一致）
  assert.match(MODULE, /表决那一刻估算/);
  assert.match(MODULE, /是否揭示只由双选状态机决定，与分数无关/);
});

test("/buddy：图标走 Phosphor .icon 写法、⛔ 无 emoji、⛔ 无外链、⛔ 无上传控件", () => {
  assert.match(PAGE, /\/vendor\/phosphor\/icons\//, "图标必须用本地 Phosphor svg");
  assert.match(PAGE, /class="icon icon--\d+"/, "静态图标走 .icon icon--N");
  assert.match(MODULE, /icon\(/, "动态图标用 ui.js 的 icon()");
  assert.doesNotMatch(PAGE, /vendor\/tabler/, "tabler 目录已废弃，不许残留");
  assert.doesNotMatch(
    PAGE,
    /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2600}-\u{26D3}\u{26D5}-\u{26FF}\u{2700}-\u{27BF}]/u,
    "页面上不许出现 emoji（⛔ U+26D4 是仓库注释约定，允许）",
  );
  assert.doesNotMatch(PAGE, /https?:\/\//, "⛔ 不引外部 CDN（断网可跑）");
  const srcs = [...PAGE.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/config.js"], "外链脚本只允许 /config.js");
  assert.equal((PAGE.match(/type="file"/g) || []).length, 0, "本页不许有文件上传控件（frontend.md §7）");
  assert.doesNotMatch(PAGE, /\bfetch\(/, "页面不自己 fetch：一律走 /js/api.js 解信封");
  for (const mod of ["/js/api.js", "/js/nav.js", "/js/demo.js", "/js/ui.js"]) {
    assert.ok(PAGE.includes(mod), `必须复用 ${mod}`);
  }
});

test("/buddy：令牌只走运行时链路，页面不回填、不硬编码", () => {
  assert.match(PAGE, /\/config\.js/, "令牌可由 /config.js 注入");
  assert.match(MODULE, /from "\/js\/api\.js"/, "用共享 api 模块");
  assert.match(MODULE, /hasWriteToken\(\)/, "用 hasWriteToken 决定提示，而不是猜");
  assert.match(MODULE, /setApiToken\(/, "允许演示时手动补令牌");
  // 不回填令牌输入框（投屏时不露令牌）
  assert.match(MODULE, /\$\("token"\)\.value = ""/, "令牌输入框必须清空回填");
  assert.doesNotMatch(MODULE, /localStorage\.setItem\(\s*["'][^"']*token/i, "令牌不进 localStorage");
  assert.doesNotMatch(PAGE, /DEMO_TOKEN\s*[:=]\s*["'][^"']{6,}["']/, "页面不许硬编码令牌");
  assert.match(PAGE, /type="password"/, "令牌输入框用 password");
});

test("/buddy：候选只渲染白名单字段，contact_code 只在 mutually revealed 时出现", () => {
  // 反推身份的字段一个都不许出现
  for (const bad of ["author_id", "user_id", "院系", "班级", "学号", "宿舍号", "真实姓名", "手机号", "邮箱"]) {
    assert.ok(!MODULE.includes(bad), `模块脚本里不得出现 ${bad}`);
  }
  assert.match(MODULE, /anon_token/, "只暴露匿名标识");
  // contact_code 的两处出现都必须先判断 mutual
  assert.match(MODULE, /if \(mutual && c\.contact_code\)/, "候选卡：必须 mutual 才渲染中转码");
  assert.match(MODULE, /buddy-reveal__code/, "成功视觉里的中转码");
  assert.match(MODULE, /reveal_status === "mutual"/, "判据是 reveal_status");
  // 单方面同意时不能出现「对方已同意」的暗示
  assert.doesNotMatch(MODULE, /对方已同意|对方同意了/, "⛔ 不得暗示对方是否已同意");
  // 照片相关：本页不涉及照片
  assert.doesNotMatch(MODULE, /photo_path/, "页面不传照片参数");
});

test("/buddy：局部样式的字号与间距只用设计令牌（--size-* / --sp-*）", () => {
  const offenders = [];
  for (const m of STYLE.matchAll(/(font-size|padding|padding-[a-z]+|margin|margin-[a-z]+|gap)\s*:\s*([^;]+);/g)) {
    const prop = m[1];
    const value = m[2].trim();
    const ok =
      value.includes("var(--size-") ||
      value.includes("var(--sp-") ||
      value === "0" ||
      (prop.startsWith("margin") && value === "auto");
    if (!ok) offenders.push(`${prop}: ${value}`);
  }
  assert.deepEqual(offenders, [], "字号 / 间距必须取自设计令牌表");
  // 圆角与动效也用令牌
  assert.match(STYLE, /border-radius:\s*var\(--radius-card\)|border-radius:\s*var\(--r-/);
  assert.match(STYLE, /var\(--ease\)/);
});

/* ============================================================ 2) 本地资源 */

test("/buddy：页面用到的每个 Phosphor 图标与插画都真的落地了", () => {
  assert.ok(fs.existsSync(ICON_DIR), "图标目录必须存在");
  const exist = new Set(fs.readdirSync(ICON_DIR).map((f) => f.replace(/\.svg$/, "")));
  const used = new Set([
    ...[...PAGE.matchAll(/--icon:url\(\/vendor\/phosphor\/icons\/([a-z0-9-]+)\.svg\)/g)].map((m) => m[1]),
    ...[...MODULE.matchAll(/icon\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size >= 6, `至少该用到 6 个不同图标，实得 ${used.size}`);
  const missing = [...used].filter((n) => !exist.has(n));
  assert.deepEqual(missing, [], `图标文件缺失：${missing.join(",")}（写错名字会渲染成空白）`);
  // 插画
  for (const img of ["empty-state.png", "agent-connect.png", "hero-campus.png"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "static", "img", img)), `插画缺失 ${img}`);
  }
});

/* ============================================================ 3) 页面请求的接口 */

test("/buddy：页面调用的 3 个 URL（含参数名）后端可用且走统一信封", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 页面 boot() 会先发这个（带 limit=100）
    const pub = await publishPost({ author_handle: "界面同学A", kind: "study", text_profile: STUDY_TEXT });
    const listRes = await fetch(`${base}/api/buddies?limit=100`).then((r) => r.json());
    assert.equal(listRes.ok, true, "GET /api/buddies?limit=100 必须可用");
    assert.ok(Array.isArray(listRes.data) && listRes.data.length >= 1);
    assert.ok(listRes.data.some((p) => p.post_id === pub.post_id));
    assert.ok(!JSON.stringify(listRes.data).includes("user_id"), "列表不得暴露 user_id");
    for (const p of listRes.data) {
      assert.ok(p.profile && p.profile.kind, "卡片可视化依赖 profile");
      assert.ok(p.anon_token, "卡片展示匿名标识");
    }

    // 候选（页面参数名：kind / handle / top_k / text）
    const searchRes = await fetch(
      `${base}/api/buddies/search?kind=study&handle=${encodeURIComponent("界面同学B")}&top_k=5&text=${encodeURIComponent(STUDY_TEXT)}`,
    ).then((r) => r.json());
    assert.equal(searchRes.ok, true, "候选接口必须可用（参数名要与页面一致）");
    assert.ok(Array.isArray(searchRes.data));
    const cand = searchRes.data[0];
    assert.ok(cand, "应至少命中 1 个候选");
    for (const key of ["post_id", "anon_token", "kind", "score", "reason", "reveal_status", "parts"]) {
      assert.ok(key in cand, `候选缺字段 ${key}（卡片要渲染它）`);
    }
    assert.ok(!Object.hasOwn(cand, "contact_code"), "未双选成功时不得出现 contact_code 键");

    // 我的申请（页面参数名：handle）
    const mineRes = await fetch(`${base}/api/buddies/mine?handle=${encodeURIComponent("界面同学B")}`).then((r) => r.json());
    assert.equal(mineRes.ok, true, "我的申请接口必须可用");
    assert.ok(Array.isArray(mineRes.data));
    for (const row of mineRes.data) {
      assert.ok("reveal_status" in row && "score" in row && "created_at" in row, "时间线需要的字段");
      assert.ok(!Object.hasOwn(row, "contact_code"), "我的申请不下发中转码");
    }
  } finally {
    server.close();
  }
});
