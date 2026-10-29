/**
 * UI · /schedule 日程课表页 改造自测（`npm test` 会跑）
 *
 * 对应改造需求（用户原话）：
 *   1. 去掉「你的昵称」输入框与「载入我的日程」按钮 —— 身份内置为演示身份「同学A」
 *   2. 首屏就是课表；顶部只留一行 .toolbar（导入课表 / 提醒设置 两个入口，都走 createSheet）
 *   3. 删掉底部「手动添加课程」整块 → 改成点课表格子直接编辑（openModal）
 *   4. 脱敏审计收成一行按钮「查看脱敏审计记录」，明细进侧栏，且只显示字段名
 *   5. 图标全部走 /vendor/phosphor/icons/*.svg（⛔ 不用 emoji）
 *
 * 本文件只做两件事：
 *   A. 静态守卫：把上面几条约定钉死（改坏立刻红）
 *   B. 行为验证：用真服务复现页面每次点击发出的写序列（点空格子 → 保存 → 改名 → 删除），
 *      并断言数据最终状态 —— 页面的 upsert 键语义与「改名 = 先删旧再新增」是这里验证的重点。
 *
 * ⛔ 不改 src/**，只测；页面里也没有任何上传控件（契约红线）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 独立临时库 + 测试令牌（必须在 import src/server.js 之前设好）
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-ui-schedule-${process.pid}.db`);
process.env.DEMO_TOKEN = "ui-schedule-test-token";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const PAGE = read("static/schedule.html");

/* =====================================================================
   A. 静态守卫
   ===================================================================== */

test("静态：昵称输入框与「载入我的日程」按钮已移除，身份内置为演示身份", () => {
  assert.doesNotMatch(PAGE, /id\s*=\s*["']handle["']/, "页面不该再有昵称输入框");
  assert.doesNotMatch(PAGE, /你的昵称/, "「你的昵称」字样必须消失");
  assert.doesNotMatch(PAGE, /载入我的日程/, "「载入我的日程」按钮必须消失");
  assert.doesNotMatch(PAGE, /bm_handle/, "不再往 localStorage 里存昵称");
  // 顶栏只剩一句演示身份（小字 + .chip），且默认值是「演示身份：同学A」
  assert.match(PAGE, /class="chip"/);
  assert.match(PAGE, /演示身份：同学A/);
  assert.match(PAGE, /"演示身份："\s*\+\s*HANDLE/, "chip 文案应由内置身份渲染");
  // 身份内置 + ?handle= 覆盖（自测用），默认值固定
  assert.match(PAGE, /const DEFAULT_HANDLE\s*=\s*"同学A"/);
  assert.match(PAGE, /get\("handle"\)/);
});

test("静态：底部「手动添加课程」整块已删除，改成点课表格子直接编辑", () => {
  assert.doesNotMatch(PAGE, /手动添加/, "「手动添加」整块必须删掉");
  assert.doesNotMatch(PAGE, /id="addForm"/, "旧的手动添加表单必须删掉");
  assert.doesNotMatch(PAGE, /id="addMsg"/, "旧的提示容器必须删掉");
  // 点格子 → 弹层：必须用 ui.js 已有的 course-grid / is-clickable / slot-add 钩子 + openModal
  assert.match(PAGE, /className\s*=\s*"course-grid"/, "课表必须用 .course-grid 类");
  assert.match(PAGE, /"is-clickable"/, "格子必须带 .is-clickable（CSS 里已有 hover / focus 样式）");
  assert.match(PAGE, /"slot-add"/, "空格子里的 + 必须用 .slot-add");
  assert.match(PAGE, /openModal\(/);
  assert.match(PAGE, /from "\/js\/ui\.js"/);
  // 弹层字段：课程名 / 教室 / 起止节次 / 周次 / 提前提醒
  for (const id of ["ed-title", "ed-room", "ed-ps", "ed-pe", "ed-weeks", "ed-rb"]) {
    assert.ok(PAGE.includes(`"${id}"`), `编辑弹层缺少字段 ${id}`);
  }
});

test("静态：顶部只留一行 .toolbar，两个入口用 createSheet 打开侧栏", () => {
  assert.equal((PAGE.match(/class="toolbar"/g) || []).length, 1, "页面上只该有一行 .toolbar");
  assert.match(PAGE, /id="importBtn"/);
  assert.match(PAGE, /id="remindBtn"/);
  assert.match(PAGE, /导入课表/);
  assert.match(PAGE, /提醒设置/);
  // 两个侧栏都走 createSheet（组件层 v2）
  assert.ok((PAGE.match(/createSheet\(/g) || []).length >= 2, "导入 / 提醒 / 审计侧栏都要用 createSheet");
});

test("合规红线：页面没有任何上传控件，也没有批量粘贴课表的输入框", () => {
  assert.ok(!/type\s*=\s*["']file["']/.test(PAGE), "⛔ 不许有 input[type=file]");
  assert.ok(!/<textarea/i.test(PAGE), "⛔ 不许有文本框批量粘贴课表");
  assert.ok(!/XMLHttpRequest|DataTransfer|dragstart|ondrop/i.test(PAGE), "⛔ 不许有任何拖放上传痕迹");
  // 上传相关的接口名一律不许出现
  assert.ok(!/\/api\/schedule\/upload/i.test(PAGE), "⛔ 契约明确不做课表上传接口");
  // 导入指引：明说只走对话（MCP）+ 可复制的示例对话
  assert.match(PAGE, /只走对话/);
  assert.match(PAGE, /帮我导入一下这学期课表/);
  assert.match(PAGE, /copyText\(/);
});

test("静态：脱敏审计收成一行按钮，明细进侧栏，且只展示字段名", () => {
  assert.match(PAGE, /查看脱敏审计记录/);
  assert.doesNotMatch(PAGE, /id="auditWrap"/, "原来那一大块审计表格必须收进侧栏，页面上不留容器");
  assert.match(PAGE, /\/api\/scrub\/audit\?limit=20/);
  assert.match(PAGE, /dropped_fields/, "审计明细只能读字段名数组");
  // 只渲染字段名：不许把审计行里的内部 id / 其它字段铺到界面上
  assert.doesNotMatch(PAGE, /row\.user_id|row\.id\b/, "审计表只显示 时间 / 类型 / 字段名");
  assert.match(PAGE, /只记字段名/);
});

test("静态：图标全部走 Phosphor svg（本地文件，且都用 .icon 写法），⛔ 不用 emoji", () => {
  // 静态 HTML 里的 style="--icon:url(...)" 与 JS 里的 icon("名字")（含三元写法）都要覆盖
  const refs = [
    ...[...PAGE.matchAll(/\/vendor\/phosphor\/icons\/([a-z0-9-]+)\.svg/g)].map((m) => m[1]),
    ...[...PAGE.matchAll(/\bicon\(\s*([^,]*?),/g)].flatMap((m) =>
      [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]),
    ),
  ];
  const required = ["user", "calendar-event", "clock", "shield-check", "plus", "pencil", "trash", "copy", "alert-triangle", "clipboard-text"];
  assert.ok(refs.length >= 5, `页面应使用多个 phosphor 图标，实际 ${refs.length} 个`);
  for (const name of new Set([...refs, ...required])) {
    assert.ok(
      fs.existsSync(path.join(ROOT, "static", "vendor", "phosphor", "icons", `${name}.svg`)),
      `图标文件不存在：static/vendor/phosphor/icons/${name}.svg`,
    );
    assert.ok(PAGE.includes(name), `页面没有用到图标 ${name}`);
  }
  // ui.js 的三态组件内置 emoji 图标，本页刻意不用它们（改用自带 phosphor 图标的 stateBox）
  assert.doesNotMatch(PAGE, /showEmpty\(|showError\(|showSuccess\(/, "别用内置 emoji 图标的三态组件");
  const emoji = PAGE.match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
  assert.equal(emoji, null, `页面里出现了 emoji：${emoji && emoji[0]}`);
});

test("静态：无外链 / 不硬编码令牌 / 写接口一律走 /js/api.js", () => {
  const external = [...PAGE.matchAll(/(?:src|href)\s*=\s*"(?:https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
  assert.deepEqual(external, [], `页面引用了外部资源：${external.join(", ")}`);
  assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(PAGE));
  assert.ok(!/cdn\.|unpkg|jsdelivr|cdnjs/i.test(PAGE));
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(PAGE));
  const bearers = [...PAGE.matchAll(/Bearer\s+([^\s"'`\\]+)/g)].map((m) => m[1]);
  assert.deepEqual(bearers, [], "⛔ 页面不许出现 Bearer 令牌字面量");
  assert.ok(!/fetch\(/.test(PAGE), "写接口统一走 /js/api.js，页面不自己 fetch");
  assert.match(PAGE, /from "\/js\/api\.js"/);
  assert.match(PAGE, /\/api\/schedule/);
  assert.match(PAGE, /"X-Demo-Token"|api\(/, "写接口令牌由 api.js 统一注入");
});

test("静态：白名单外字段（姓名 / 学号 / 教师 / 手机号）页面里一个字都不许有", () => {
  for (const bad of ["realName", "studentNo", "studentId", "stuNo", "teacherName", "idCard", "mobile"]) {
    assert.ok(!PAGE.includes(bad), `页面出现禁字段名 ${bad}`);
  }
  assert.ok(!/姓名\s*[:：]\s*[^<]/.test(PAGE), "页面不该采集姓名");
});

test("静态：375px 版式保障（容器横滑 + 页面本体不横滚 + 弹层/侧栏 ≤640px 变底部面板由 app.css 负责）", () => {
  assert.match(PAGE, /#gridWrap\s*\{[^}]*overflow-x\s*:\s*auto/);
  assert.match(PAGE, /@media\s*\(max-width:\s*640px\)/);
  // 首列冻结：横滑时「第几节」不丢
  assert.match(PAGE, /#gridWrap tr > \*:first-child\s*\{[^}]*position\s*:\s*sticky/);
  assert.ok(!/width:\s*\d{4,}px/.test(PAGE), "页面里出现固定四位像素宽度（375px 会破版）");
  // ⛔ 不改 app.css：本页样式只在页面 <style> 里（且不新增 .sheet/.modal 覆盖）
  assert.ok(!/\.sheet\s*\{|\.modal\s*\{/.test(PAGE), "侧栏/弹层样式归 app.css，页面不要另写一份");
});

test("静态：页面里没有重复的旧文案（课表界面就只有课表）", () => {
  // 旧的「先填昵称再载入」「手动添加一门课」「怎么导入课表（大段说明）」都不该留在页面正文里
  assert.doesNotMatch(PAGE, /请先填昵称/);
  assert.doesNotMatch(PAGE, /手动添加一门课/);
  assert.doesNotMatch(PAGE, /section__index">3</, "页面区块收敛成两段：课表 + 合规/审计");
  // 合规说明仍然可见（契约 §7 区块二要求显眼），但收成一句话
  assert.match(PAGE, /课表文件不要上传到这里/);
});

/* =====================================================================
   B. 行为验证：真起服务，复现页面每次点击发出的写序列
   ===================================================================== */

const { createApp } = await import("../src/server.js");

const HANDLE = "课表UI自测同学";
const TOKEN = process.env.DEMO_TOKEN;
const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

let server = null;
let base = "";

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

/** 页面「保存」按钮发出的请求：只带白名单字段 + remind_before */
async function post(payload) {
  const res = await fetch(`${base}/api/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": TOKEN },
    body: JSON.stringify(Object.assign({ user_handle: HANDLE }, payload)),
  });
  return { status: res.status, body: await res.json() };
}

/** 页面每次写库后都会重新拉一次课表 */
async function list(handle = HANDLE) {
  const env = await fetch(`${base}/api/schedule?handle=${encodeURIComponent(handle)}`).then((r) => r.json());
  assert.equal(env.ok, true);
  return env.data;
}

/** 页面「删除这节课」/「改名」前的删旧：先试契约里的 remove 路由，命中「没有这条路由」才走 MCP 退路 */
async function removeByKey(item) {
  const target = {
    weekday: item.weekday,
    period_start: item.period_start,
    period_end: item.period_end,
    title: String(item.title).trim(),
  };
  const res = await fetch(`${base}/api/schedule/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": TOKEN },
    body: JSON.stringify(Object.assign({ user_handle: HANDLE }, target)),
  });
  const body = await res.json().catch(() => null);
  if (!(res.status === 404 && body && body.error && /no route for/i.test(body.error.message || ""))) {
    assert.equal(res.status, 200, "remove 路由存在时必须成功：" + JSON.stringify(body));
    return "endpoint";
  }

  // 退路：既有 MCP 工具 schedule_import（先清空该用户旧课表再写入 → 能真正删掉一条）
  const keep = (await list()).filter(
    (x) => !(x.weekday === target.weekday && x.period_start === target.period_start &&
      x.period_end === target.period_end && String(x.title) === target.title),
  );
  const rpc = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "schedule_import",
        arguments: { user_handle: HANDLE, items: keep.map((x) => ({
          weekday: x.weekday, period_start: x.period_start, period_end: x.period_end,
          title: x.title, room: x.room, weeks: x.weeks,
        })) },
      },
    }),
  }).then((r) => r.json());
  assert.equal(rpc.result.structuredContent.ok, true, "整表替换应成功");

  // 整表替换会把 remind_before 清空 → 按新条目把提醒补回来（页面就是这么做的）
  for (const x of keep) {
    if (x.remind_before === null || x.remind_before === undefined) continue;
    const back = await post(x);
    assert.equal(back.body.ok, true);
  }
  return "import";
}

test("行为：GET /api/schedule 拿到信封里的数组（页面用 api() 解信封）", async () => {
  const rows = await list(HANDLE);
  assert.ok(Array.isArray(rows));
});

test("行为：模拟「点空格子 → 保存」后该时段出现课程；「再点它改名字」后只剩一条新名字", async () => {
  // 先铺两门原有的课（带提醒 + 教室），用来看改名流程会不会误伤别的行
  for (const it of [
    { weekday: 1, period_start: 1, period_end: 2, title: "课程A", room: "教学楼A-101", weeks: "1-16", remind_before: 15 },
    { weekday: 3, period_start: 3, period_end: 4, title: "课程B", room: "实验楼C-201", weeks: "1-16", remind_before: 30 },
  ]) {
    assert.equal((await post(it)).body.ok, true);
  }

  // ① 点周一的第 5 节空格子 → 弹层里填课程名 + 教室 → 保存
  const added = await post({ weekday: 1, period_start: 5, period_end: 5, title: "课程C", room: "实验楼C-305" });
  assert.equal(added.body.ok, true);
  let rows = await list();
  const cellOne = rows.filter((r) => r.weekday === 1 && r.period_start === 5 && r.period_end === 5);
  assert.equal(cellOne.length, 1, "该时段应只有一条");
  assert.equal(cellOne[0].title, "课程C");

  // ② 再点它 → 弹层带出原值 → 把课程名改成「课程D」（页面：先删旧、再新增）
  const editing = cellOne[0];
  const path = await removeByKey(editing);
  assert.ok(path === "endpoint" || path === "import", "删旧必须走其中一条既有通道");
  assert.equal((await post({ weekday: 1, period_start: 5, period_end: 5, title: "课程D" })).body.ok, true);

  rows = await list();
  const after = rows.filter((r) => r.weekday === 1 && r.period_start === 5 && r.period_end === 5);
  assert.equal(after.length, 1, "改名后同一时段不能留下两条（upsert 键含 title，所以必须先删旧的）");
  assert.equal(after[0].title, "课程D");
  assert.ok(!rows.some((r) => r.title === "课程C"), "旧名字的记录必须已被删除");

  // ③ 别的行没被误伤：教室、周次、提醒都还在
  const a = rows.find((r) => r.title === "课程A");
  const b = rows.find((r) => r.title === "课程B");
  assert.equal(a.room, "教学楼A-101");
  assert.equal(a.weeks, "1-16");
  assert.equal(a.remind_before, 15, "整表替换后提醒应被补回来");
  assert.equal(b.room, "实验楼C-201");
  assert.equal(b.remind_before, 30);
});

test("行为：模拟「删除这节课」后条目消失，且其它课完好", async () => {
  const before = await list();
  const victim = before.find((r) => r.title === "课程D");
  assert.ok(victim, "前置条件：课程D 应该还在");
  await removeByKey(victim);
  const after = await list();
  assert.equal(after.filter((r) => r.title === "课程D").length, 0);
  assert.ok(after.some((r) => r.title === "课程A"), "其它课不能被一起删掉");
  assert.ok(after.length === before.length - 1, `条目数应减一：${before.length} → ${after.length}`);
});

test("行为：只改教室 / 周次 / 提醒时走原位 upsert（不新增条目，也不清空别的字段）", async () => {
  const before = await list();
  const a = before.find((r) => r.title === "课程A");
  const res = await post(Object.assign({}, a, { room: "教学楼B-202", remind_before: 45 }));
  assert.equal(res.body.ok, true);
  const after = await list();
  assert.equal(after.length, before.length, "同一身份键提交只更新，不新增");
  const a2 = after.find((r) => r.title === "课程A");
  assert.equal(a2.room, "教学楼B-202");
  assert.equal(a2.weeks, "1-16", "只提交带了字段：weeks 不能被清空");
  assert.equal(a2.remind_before, 45);
});

test("行为：清空提醒（留空）能真的写回 null；夹带的禁字段进审计且只记字段名", async () => {
  const a = (await list()).find((r) => r.title === "课程A");
  assert.equal((await post(Object.assign({}, a, { remind_before: null }))).body.ok, true);
  assert.equal((await list()).find((r) => r.title === "课程A").remind_before, null, "留空应写回 null");

  // 非法区间：页面的校验会先挡住；服务端也必须拒绝（页面靠 e.message 提示）
  const bad = await post({ weekday: 2, period_start: 6, period_end: 2, title: "非法课程" });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error.code, "SCHEMA_REJECTED");

  // 审计只记字段名（侧栏要展示的形态）
  const sentinel = "李师师";
  assert.equal((await post({ weekday: 6, period_start: 1, period_end: 2, title: "课程E", teacher: sentinel })).body.ok, true);
  const audit = await fetch(`${base}/api/scrub/audit?limit=5`).then((r) => r.json());
  assert.equal(audit.ok, true);
  const row = audit.data.find((r) => (r.dropped_fields || []).includes("teacher"));
  assert.ok(row, "夹带 teacher 字段应产生一条审计记录");
  assert.deepEqual(row.dropped_fields, ["teacher"], "审计只记字段名");
  assert.ok(!JSON.stringify(audit.data).includes(sentinel), "⛔ 审计里绝不能出现字段值");
});

test("行为：MCP 端点鉴权（页面通过 api.js 拿令牌，不硬编码）", async () => {
  const noToken = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(noToken.status, 401, "没有令牌时 MCP 必须 401（页面靠 /config.js 注入的令牌）");
});
