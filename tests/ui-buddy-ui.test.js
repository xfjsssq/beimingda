/**
 * /buddy 搭子模块 · 重设计后的单测（node:test）
 *
 *   npm test   （与其他测试文件各自独立进程、各自独立临时库）
 *
 * 对着用户重设计的 8 条验收口径写：
 *   1) 左侧「发帖」= 发布自己的需求（不再跳"找匹配"）
 *   2) 主区 = 帖子流：卡片上有「表达意愿」并弹留言框
 *   3) 留言与回复：详情里能看留言、发布者可回复、可直接接受
 *   4) 「我的申请」= 我发布的帖 / 我表达的意愿 / 已同意的搭子（三块）
 *   5) 详细度由用户选：只写一句话也能发；演示数据含短帖 + 保留详细帖
 *   6) 演示"真人回复"数据走服务端数据文件，⛔ 不写在页面里
 *   7) 令牌 UI 全删（页面不出现凭据输入框与相关字样）
 *   8) 红线：不显示身份字段、未互相可见不得出现 contact_code、无上传控件
 *
 * ⛔ 只读文件 + 只用自己的临时库（os.tmpdir）；不改既有测试文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-ui-buddy2-${process.pid}.db`);
process.env.DEMO_TOKEN = "ui-buddy2-token";
try { fs.unlinkSync(process.env.DB_PATH); } catch { /* 首次运行没有旧库 */ }

const { initDb } = await import("../src/db/index.js");
const { publishPost } = await import("../src/services/buddy.js");
initDb();

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGE = read("static/buddy.html");
const STYLE = (PAGE.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const MODULE = [...PAGE.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
const DEMO = JSON.parse(read("static/buddy-demo.json"));
const DEMO_FIXTURE = JSON.parse(read("fixtures/buddy-demo-conversations.json"));
const POSTS_FIXTURE = JSON.parse(read("fixtures/buddy-posts.json"));
const ICON_DIR = path.join(ROOT, "static", "vendor", "phosphor", "icons");

/* ============================================================ 1) 发帖 = 发布自己的需求 */

test("/buddy：左侧「发帖」是发布自己的需求，不再跳「找匹配」", () => {
  assert.match(PAGE, /id="navPublish"[\s\S]{0,320}?发帖/, "侧栏要有「发帖」");
  assert.match(PAGE, /id="navPublish"[\s\S]{0,400}?发布我自己的搭子需求/, "副标题要说清是发布自己的需求");
  assert.match(MODULE, /function openPublishSheet\(\)/, "发帖走 openPublishSheet");
  // ⛔ 手动浏览不做"八字匹配"：旧搜索入口/表单必须消失
  assert.doesNotMatch(PAGE, /id="seekText"/, "不该再有「描述你想要的搭子」搜索框");
  assert.doesNotMatch(PAGE, /id="navSearch"/, "侧栏不该再有「找搭子（匹配）」");
  assert.doesNotMatch(MODULE, /\/api\/buddies\/search/, "页面不再调候选匹配接口（那留给 MCP）");
  assert.match(PAGE, /接入说明/, "想用 MCP 的话给出指路");
  assert.match(PAGE, /"\/agent"/, "指到 /agent");
});

test("/buddy：发帖表单只强制「一句话」，模板一键带入，其余可选且默认收起", () => {
  assert.match(PAGE, /一句话说清要做什么（必填）/, "要有必填的一句话输入");
  assert.match(MODULE, /const description = \$\("pubText"\)\.value\.trim\(\)/, "读的是 pubText");
  assert.match(MODULE, /description\.length < 4/, "只校验这一句");
  assert.match(MODULE, /const TEMPLATES = \[/, "要有模板数组");
  for (const t of ["自习", "运动", "拼车"]) assert.ok(MODULE.includes(`label: "${t}"`), `模板缺 ${t}`);
  assert.match(MODULE, /\$\("pubText"\)\.value = t\.text/, "模板一键带入");
  assert.match(PAGE, /展开填写更多（可选）/, "更多字段的入口");
  assert.match(MODULE, /more\.hidden = true/, "更多字段默认收起");
  assert.match(MODULE, /more\.hidden = !more\.hidden/, "可展开/收起");
  for (const id of ["pubWhen", "pubSchedule", "pubInterests", "pubTraits", "pubExpect"]) {
    assert.ok(MODULE.includes(`mk("${id}"`), `可选字段缺 ${id}`);
  }
  assert.match(MODULE, /function composeText\(/, "要有 composeText 把可选字段拼成一段描述");
  assert.match(MODULE, /join\("；"\)/, "用中文分号拼接，服务端好抽画像");
});

/* ============================================================ 2) 主区 = 帖子流 + 表达意愿 */

test("/buddy：主区是帖子流，卡片带匿名标识 / 需求 / 表达意愿按钮", () => {
  assert.match(MODULE, /function postCard\(post\)/, "帖子卡片");
  assert.match(MODULE, /buddy-post__head/, "卡片头部（类型徽章 + 匿名标识）");
  assert.match(MODULE, /post\.anon_token/, "展示匿名标识");
  assert.match(MODULE, /\(post\.profile && post\.profile\.wanted\)/, "展示需求正文");
  assert.match(MODULE, /表达意愿/, "卡片上有「表达意愿」");
  assert.match(MODULE, /function openIntentSheet\(/, "点它弹留言框");
});

test("/buddy：表达意愿弹留言框，留言提交到服务端（未就绪则降级并如实标注）", () => {
  assert.match(MODULE, /ta\.id = "intentText"/, "留言框（运行时创建）");
  assert.match(MODULE, /给对方留句话（必填）/, "留言必填");
  assert.match(MODULE, /function submitConsent\(post, message\)/, "提交函数");
  assert.match(MODULE, /\/api\/buddies\/\$\{encodeURIComponent\(post\.post_id\)\}\/consent/, "调 :id/consent");
  assert.match(MODULE, /body: \{ agree: true, message, handle: getHandle\(\) \}/, "带上留言与身份");
  assert.match(MODULE, /const isMissingRoute = \(e\) =>/, "要有端点缺失判定");
  assert.match(MODULE, /no route for/i, "以 404 兜底文案判定端点未就绪");
  assert.match(MODULE, /mode: "local"/, "降级到本地演示层");
  assert.match(MODULE, /接口未就绪/, "降级时如实告诉用户这是本地演示数据");
});

/* ============================================================ 3) 留言与回复 + 接受 */

test("/buddy：帖子详情能看留言列表；发布者可回复，也可直接接受", () => {
  assert.match(MODULE, /function openThreadSheet\(post\)/, "留言详情面板");
  assert.match(MODULE, /function consentsOf\(anon\)/, "留言串合成");
  assert.match(PAGE, /留言与回复/, "入口文案");
  assert.match(MODULE, /function submitReply\(post, consentId, text\)/, "回复函数");
  assert.match(MODULE, /\/api\/buddies\/\$\{encodeURIComponent\(post\.post_id\)\}\/reply/, "调 :id/reply");
  assert.match(MODULE, /body: \{ to_consent_id: consentId, message: text, handle: getHandle\(\) \}/, "回复体");
  assert.match(MODULE, /回复这条/, "回复按钮");
  assert.match(MODULE, /function submitAccept\(post, consent\)/, "接受函数");
  assert.match(MODULE, /to_seeker: consent\.from_anon/, "接受时指向对方匿名标识");
  assert.match(MODULE, /接受这个搭子/, "接受按钮");
  assert.match(MODULE, /已找到搭子/, "接受后帖子标记已找到搭子");
  assert.match(MODULE, /local\.accepted\.push\(post\.anon_token\)/, "本地层记录已接受");
  assert.match(MODULE, /buddy-reply/, "回复用缩进样式展示");
});

/* ============================================================ 4) 我的申请三块 */

test("/buddy：「我的申请」聚合三块：我发布的帖 / 我表达的意愿 / 已同意的搭子", () => {
  for (const label of ["我发布的需求", "我表达的意愿", "已同意的搭子"]) {
    assert.ok(MODULE.includes(label), `缺分块「${label}」`);
  }
  assert.match(MODULE, /function myPosts\(\)/, "我发布的帖");
  assert.match(MODULE, /function myIntents\(\)/, "我表达的意愿");
  assert.match(MODULE, /function myMutual\(\)/, "已互相同意");
  assert.match(MODULE, /function renderMine\(host\)/, "渲染");
  assert.match(MODULE, /buddy-seg__btn/, "三块用分段控件切换");
  assert.match(MODULE, /条留言/, "① 我发布的帖要显示收到的留言条数");
  assert.match(MODULE, /const myDemoPost = \(\(demo\.my && demo\.my\.posts\)/, "① 留言来源要含「我发布的帖」收到的留言（别只看墙上帖的留言）");
  assert.match(MODULE, /role === "post"/, "① 我发布的帖用的是「收到留言 / 已找到搭子」状态，而不是「等对方回复」");
  assert.match(MODULE, /去回复 \/ 接受/, "① 要有去回复/接受的入口");
  assert.match(MODULE, /node\.reply_text/, "② 展示对方回复内容");
  assert.match(MODULE, /对方已回复/, "② 展示对方已回复状态");
  assert.match(MODULE, /已互相同意/, "②/③ 展示已被接受状态");
  assert.match(MODULE, /node\.contact_code/, "③ 互相可见时展示中转码");
  assert.match(MODULE, /中转码（双方都同意才会下发）/, "并把口径写清楚");
});

/* ============================================================ 5) 详细度由用户选 */

test("数据：保留详细帖的同时新增「只写一句话」的短帖（详细度由用户自己选）", () => {
  const posts = POSTS_FIXTURE.posts;
  assert.ok(posts.length >= 14, `帖子总数应 ≥14，实得 ${posts.length}`);
  const shorts = posts.filter((p) => p.short === true);
  assert.ok(shorts.length >= 3, `至少 3 条短帖，实得 ${shorts.length}`);
  for (const p of shorts) {
    assert.ok(p.profile.wanted.length <= 30, `短帖需求应 ≤30 字：${p.profile.wanted}`);
    assert.deepEqual(p.profile.interests, [], "短帖不该编造兴趣");
    assert.deepEqual(p.profile.must_have, [], "短帖不该编造硬性要求");
    assert.deepEqual(p.profile.deal_breaker, [], "短帖不该编造雷点");
    assert.equal(p.profile.traits.chatty, 0.5, "未提及的性格取中性值");
    assert.equal(p.profile.schedule.early_bird, 0.5, "未提及的作息取中性值");
  }
  const detailed = posts.filter((p) => !p.short && p.profile.interests.length);
  assert.ok(detailed.length >= 8, `详细帖要保留做对比，实得 ${detailed.length}`);
  assert.match(STYLE, /\.buddy-want--short/, "短需求用更大字号（视觉上区分详细度）");
  assert.match(MODULE, /wanted\.length <= 24/, "短需求判定");
});

/* ============================================================ 6) 演示"真人回复"数据 */

test("数据：演示留言/回复是服务端数据文件，页面只读、⛔ 不硬编码", () => {
  assert.match(MODULE, /const DEMO_URL = "\/buddy-demo\.json"/, "演示数据走数据文件");
  assert.match(MODULE, /await api\(DEMO_URL\)/, "页面读它");
  assert.ok(fs.existsSync(path.join(ROOT, "static", "buddy-demo.json")), "数据文件必须存在");
  for (const line of ["图书馆门口见", "我带球，你早点来先热身", "先按十一点关灯试试", "拉个时间表"]) {
    assert.ok(!PAGE.includes(line), `演示对话不许写在页面里：${line}`);
  }

  const threads = DEMO.threads || {};
  const keys = Object.keys(threads);
  assert.ok(keys.length >= 2, `至少 2 条帖子带留言，实得 ${keys.length}`);
  const withReplies = keys.filter((k) => (threads[k].consents || []).some((c) => (c.replies || []).length));
  assert.ok(withReplies.length >= 2, `至少 2 条帖子有"留言 + 回复"，实得 ${withReplies.length}`);
  const texts = withReplies.flatMap((k) => threads[k].consents.flatMap((c) => [c.text, ...(c.replies || []).map((r) => r.text)]));
  assert.ok(texts.length >= 4, "留言 + 回复条数要够");
  for (const t of texts) {
    assert.ok(String(t).length >= 6, `留言/回复要像真人说话，别太短：${t}`);
    assert.ok(!/[{}<>]/.test(String(t)), `留言不该含模板标记：${t}`);
  }
  assert.ok(keys.some((k) => (threads[k].accepted || []).length), "至少一条被接受");

  const intents = (DEMO.my && DEMO.my.intents) || [];
  assert.ok(intents.length >= 2, "「我表达的意愿」演示数据至少 2 条");
  assert.ok(intents.filter((i) => i.reply_text).length >= 2, "至少 2 条意愿收到对方回复");
  const mutual = (DEMO.my && DEMO.my.mutual) || [];
  assert.ok(mutual.length >= 1 && mutual[0].contact_code, "至少 1 对已互相同意（带中转码）");
  assert.ok(((DEMO.my && DEMO.my.posts) || []).length >= 1, "演示里要有「我发布的帖」");

  const anons = new Set(POSTS_FIXTURE.posts.map((p) => p.anon_token));
  for (const k of keys) assert.ok(anons.has(k), `演示留言挂在不存在的帖上：${k}`);
  for (const row of [...(DEMO.my.posts || []), ...intents, ...mutual]) {
    assert.ok(anons.has(row.anon_token), `演示数据引用不存在的帖：${row.anon_token}`);
  }

  assert.deepEqual(DEMO_FIXTURE.threads, DEMO.threads, "fixtures 与 static 的 threads 必须一致");
  assert.deepEqual(DEMO_FIXTURE.my, DEMO.my, "fixtures 与 static 的 my 必须一致");
});

/* ============================================================ 7) 令牌 UI 全删 */

test("/buddy：令牌 UI 全部移除，凭据只走运行时链路", () => {
  // ⚠️ 「设计令牌」是设计变量（app.css 的术语），与写入凭据无关，单独放行
  assert.ok(!/演示令牌|令牌输入|输入令牌|写入令牌|令牌只|令牌会|填令牌/.test(PAGE), "页面不许再出现凭据类「令牌」字样");
  assert.doesNotMatch(PAGE, /id="token"/, "凭据输入框必须删掉");
  assert.doesNotMatch(PAGE, /tokenState/, "凭据提示必须删掉");
  assert.doesNotMatch(PAGE, /type="password"/, "不许有凭据输入框");
  assert.doesNotMatch(MODULE, /setApiToken/, "页面不再自己设置凭据");
  assert.doesNotMatch(PAGE, /DEMO_TOKEN\s*[:=]\s*["'][^"']{6,}["']/, "不许硬编码凭据");
  assert.doesNotMatch(MODULE, /localStorage\.setItem\([^)]*[Tt]oken/, "凭据不进 localStorage");
  assert.match(PAGE, /\/config\.js/, "保留注入链路");
  assert.match(MODULE, /import \{ api, hasWriteToken \} from "\/js\/api\.js"/, "用共享 api 模块");
  assert.match(MODULE, /hasWriteToken\(\)/, "用它决定提示，而不是猜");
  assert.match(MODULE, /服务端未配置写入权限/, "未配置时给人话提示");
});

/* ============================================================ 8) 红线 + 资源 + 样式纪律 */

test("/buddy：红线 —— 不显示身份字段、未互相可见不得出现 contact_code、无上传控件", () => {
  for (const bad of ["author_id", "user_id", "院系", "班级", "学号", "宿舍号", "真实姓名", "手机号", "邮箱"]) {
    assert.ok(!MODULE.includes(bad), `渲染逻辑里不得出现 ${bad}`);
  }
  assert.match(MODULE, /node\.contact_code/, "我的申请里的中转码");
  assert.match(MODULE, /node\.reveal_status === "mutual"/, "必须有 mutual 判据");
  assert.match(MODULE, /m\.contact_code && !celebrated\.has/, "成功视觉只挑带中转码的（即互相可见的）");
  assert.doesNotMatch(MODULE, /对方已同意|对方同意了/, "⛔ 不得暗示对方是否已同意");
  assert.equal((PAGE.match(/type="file"/g) || []).length, 0, "本页不许有上传控件（frontend.md §7）");
  assert.doesNotMatch(MODULE, /photo_path/, "页面不传照片参数");
});

test("/buddy：图标只走 Phosphor、无 emoji、无外链、不自建 fetch", () => {
  assert.match(PAGE, /\/vendor\/phosphor\/icons\//, "本地 Phosphor 图标");
  assert.match(PAGE, /class="icon icon--\d+"/, "静态图标走 .icon icon--N");
  assert.match(MODULE, /icon\(/, "动态图标用 ui.js 的 icon()");
  assert.doesNotMatch(PAGE, /vendor\/tabler/, "不许残留 tabler");
  assert.doesNotMatch(
    PAGE,
    /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2600}-\u{26D3}\u{26D5}-\u{26FF}\u{2700}-\u{27BF}]/u,
    "⛔ 页面上不许出现 emoji（⛔ U+26D4 是仓库约定，允许）",
  );
  assert.doesNotMatch(PAGE, /https?:\/\//, "⛔ 不引外部 CDN");
  const srcs = [...PAGE.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/config.js"], "外链脚本只允许 /config.js");
  assert.doesNotMatch(MODULE, /\bfetch\(/, "页面不自己 fetch：一律走 /js/api.js");
  for (const mod of ["/js/api.js", "/js/nav.js", "/js/demo.js", "/js/ui.js"]) {
    assert.ok(PAGE.includes(mod), `必须复用 ${mod}`);
  }
  const exist = new Set(fs.readdirSync(ICON_DIR).map((f) => f.replace(/\.svg$/, "")));
  const used = new Set([
    ...[...PAGE.matchAll(/--icon:url\(\/vendor\/phosphor\/icons\/([a-z0-9-]+)\.svg\)/g)].map((m) => m[1]),
    ...[...MODULE.matchAll(/icon\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((n) => !exist.has(n));
  assert.deepEqual(missing, [], `图标文件缺失：${missing.join(",")}`);
});

test("/buddy：局部样式的字号与间距只用设计令牌（--size-* / --sp-*）", () => {
  const offenders = [];
  for (const m of STYLE.matchAll(/(font-size|padding|padding-[a-z]+|margin|margin-[a-z]+|gap)\s*:\s*([^;]+);/g)) {
    const prop = m[1];
    const value = m[2].trim();
    const ok = value.includes("var(--size-") || value.includes("var(--sp-") || value === "0" || (prop.startsWith("margin") && value === "auto");
    if (!ok) offenders.push(`${prop}: ${value}`);
  }
  assert.deepEqual(offenders, [], "字号 / 间距必须取自设计令牌表");
  assert.match(STYLE, /var\(--ease\)/, "动效曲线用令牌");
  assert.match(STYLE, /@media\s*\(min-width:\s*1024px\)[\s\S]*?grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/, "桌面常驻侧栏");
  assert.match(STYLE, /@media\s*\(max-width:\s*1023px\)[\s\S]*?transform:\s*translateX\(-100%\)/, "窄屏左侧滑入");
});

/* ============================================================ 9) 接口接线（现状 + 依赖） */

test("接口：一句话帖子真的能发（POST /api/buddies 走 kind + text_profile）", async () => {
  const data = await publishPost({
    author_handle: "界面发帖人",
    kind: "study",
    text_profile: "想找人一起自习，图书馆三楼，晚上七点",
  });
  assert.ok(data.post_id && data.anon_token, "返回匿名标识");
  assert.ok(data.profile.wanted.length > 0, "一句话也能抽出 wanted");
  assert.ok(data.profile.wanted.includes("自习") || data.profile.wanted.includes("图书馆"), "内容被保留");
});

test("接口：新端点（留言 / 回复）未就绪时页面必须降级而不是崩 —— 记录当前实际状态", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await fetch(`${base}/api/buddies?limit=100`).then((r) => r.json());
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.data) && list.data.length >= 1);
    for (const p of list.data) {
      assert.ok(p.post_id && p.anon_token && p.profile, "卡片渲染需要的字段");
      assert.ok(!("user_id" in p), "列表不得暴露 user_id");
    }
    const mine = await fetch(`${base}/api/buddies/mine?handle=${encodeURIComponent("界面发帖人")}`).then((r) => r.json());
    assert.equal(mine.ok, true, "我的接口可用");
    assert.ok(Array.isArray(mine.data), "当前结构 = 我发出的意愿数组（新结构由后端扩展）");

    const post = (url, body) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-token": process.env.DEMO_TOKEN },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const consent = await post(`${base}/api/buddies/x/consent`, { agree: true, message: "测试" });
    const reply = await post(`${base}/api/buddies/x/reply`, { message: "测试" });
    const notReady = (env) => env.ok === false && env.error.code === "NOT_FOUND" && /no route for/i.test(env.error.message);
    // 已就绪 or 明确 no-route，两种都算通过；但要把实际状态打出来，便于后端接上后自动生效
    assert.ok(notReady(consent) || consent.ok === true, "consent 端点状态：" + JSON.stringify(consent.error));
    assert.ok(notReady(reply) || reply.ok === true, "reply 端点状态：" + JSON.stringify(reply.error));
  } finally {
    server.close();
  }
});

test("接口：/buddy-demo.json 由服务端静态提供（演示数据不内联在页面）", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/buddy-demo.json`);
    assert.equal(res.status, 200, "演示数据文件要能被页面取到");
    const json = await res.json();
    assert.ok(json.threads && json.my, "结构：threads + my");
  } finally {
    server.close();
  }
});
