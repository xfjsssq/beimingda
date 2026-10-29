/**
 * 手动标注工具页 · 静态回归 + 路由可达（`npm test` 会跑）
 *
 * 交付物：`static/tools/annotate.html`（开发用工具页，不属于 6 个交付页面，也不进导航）
 * 需求要点（逐条钉在这里，改页面破坏约定就红）：
 *   1. 底图 /map/campus-map.jpg，可缩放（滚轮 + 滑动条）与拖动平移
 *   2. 点一下落一个标注点 → 面板填颜色（6~8 个预设色，用 CSS 变量）/ 备注 / 类别
 *   3. 已有标注可拖动改位置、可删除、可改颜色与备注
 *   4. 导出/导入：复制 JSON、粘贴导入 JSON、下载 annotations.json（Blob）
 *   5. 只存内存 + localStorage["beimingda.annotations"]，⛔ 不发请求、不写服务器
 *   6. 复用 /css/app.css、/js/ui.js（icon/toast/createSheet/openModal）、/config.js，⛔ 零外链
 *
 * ⛔ 只读文件 + 起一个临时服务的只读 GET；不改任何源码。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "static/tools/annotate.html";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const html = read(PAGE);
/** 只取本页自己的 <style> 段落（app.css 的刻度不在这里断言） */
const styleBlock = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

/** 设计刻度：字号与间距只允许用这些值（取自 app.css 自身在用的值域） */
const FONT_SIZES = new Set([11, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28]);
const SPACINGS = new Set([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 40, 44, 48, 52]);

test("标注页：引用 /css/app.css、/js/ui.js、/config.js 与底图 /map/campus-map.jpg", () => {
  assert.match(html, /<link[^>]+href="\/css\/app\.css"/, "必须复用全站样式");
  assert.match(html, /from "\/js\/ui\.js"/, "必须复用组件层 /js/ui.js");
  assert.match(html, /<script src="\/config\.js"><\/script>/, "必须引 /config.js");
  assert.match(html, /src="\/map\/campus-map\.jpg"/, "底图必须是学校《校园楼宇编号示意图》");
  // 外链脚本只有 /config.js，模块导入只有 /js/ui.js（本页是开发工具，不接导航模块）
  const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/config.js"], "只允许引 /config.js");
  const imports = [...html.matchAll(/from "(\/js\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["/js/ui.js"], "只允许复用 /js/ui.js");
  for (const api of ["icon(", "toast(", "createSheet(", "openModal("]) {
    assert.ok(html.includes(api), `必须用 /js/ui.js 的 ${api.slice(0, -1)}()`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, "static/map/campus-map.jpg")), "底图文件必须存在");
});

test("标注页：零外链、零请求（数据只在本机，⛔ 不发请求 / 不写服务器）", () => {
  assert.doesNotMatch(html, /https?:\/\//, "页面里不许出现任何 http(s) 绝对地址");
  assert.doesNotMatch(html, /(src|href)="\/\//, "不许出现协议相对地址");
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|sendBeacon|EventSource|WebSocket/, "不许发任何请求");
  assert.doesNotMatch(html, /type\s*=\s*["']file["']/, "不许有文件上传控件（frontend.md §7：只有 takeout 有）");
});

test("标注页：缩放三件套（滚轮 + 滑动条 + ＋－按钮）", () => {
  assert.match(html, /<input id="zoomRange" type="range"/, "必须有滑动条（移动端好操作）");
  assert.match(html, /min="60" max="400"/, "滑动条要有明确量程");
  assert.match(html, /addEventListener\("wheel"/, "必须支持滚轮缩放");
  assert.match(html, /\{\s*passive:\s*false\s*\}/, "滚轮要 preventDefault，避免整页跟着滚");
  assert.match(html, /id="zoomIn"/);
  assert.match(html, /id="zoomOut"/);
  assert.match(html, /function setZoom\(/);
  assert.match(html, /function fitView\(/);
  assert.match(html, /function renderView\(/);
});

test("标注页：拖动平移（pointer 事件 + touch-action:none，移动端不被浏览器手势抢走）", () => {
  assert.match(styleBlock, /\.viewport\s*\{[^}]*touch-action:\s*none/, "画布要声明 touch-action:none");
  assert.match(html, /addEventListener\("pointerdown"/);
  assert.match(html, /addEventListener\("pointermove"/);
  assert.match(html, /addEventListener\("pointerup"/);
  assert.match(html, /CLAMP|clampView|function clampView\(/, "平移要有夹取，避免把图拖没");
});

test("标注页：点一下落点 + 面板三件套（8 个预设色用 CSS 变量 / 备注 / 6 类类别）", () => {
  assert.match(html, /export function addPoint\(/, "点击落点要有 addPoint()");
  // 落点后自动弹面板
  assert.match(html, /openEditor\(/, "落点 / 点选都要能被编辑");

  // ① 颜色：8 个预设，色块用 CSS 变量，导出用等价 hex
  const pinVars = [...html.matchAll(/--pin-\d:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
  assert.ok(pinVars.length >= 6 && pinVars.length <= 8, `预设色数量应在 6~8 之间，实际 ${pinVars.length}`);
  assert.equal(new Set(pinVars).size, pinVars.length, "预设色不许重复");
  assert.match(html, /cssVar: "--pin-\d"/, "色块必须走 CSS 变量");
  assert.match(html, /class="swatches"|el\("div", "swatches"\)/, "要有色块容器");
  assert.match(html, /dataset\.color = c\.hex|b\.dataset\.color/, "色块要带 data-color 便于自动化");

  // ② 备注
  assert.match(html, /label", "field__label", "备注（可空，≤ 60 字）"/, "要有备注输入");
  // ③ 类别下拉：宿舍楼 / 食堂 / 教学 / 校门 / 服务 / 其它
  for (const label of ["宿舍楼", "食堂", "教学", "校门", "服务", "其它"]) {
    assert.ok(html.includes(label), `类别里缺少「${label}」`);
  }
  assert.match(html, /CATEGORIES\.map|for \(const c of CATEGORIES\)/, "类别要从 CATEGORIES 渲染（不写死两处）");
  assert.match(html, /el\("select"\)|createElement\("select"\)/, "类别用下拉");
});

test("标注页：已有标注可拖动改位置 / 删除 / 改色改备注", () => {
  assert.match(html, /drag\.mode === "pin"[\s\S]{0,400}toPercent\(/, "拖动标注点要按光标位置重算百分比");
  assert.match(html, /export function updatePoint\(/, "要有 updatePoint()");
  assert.match(html, /export function removePoint\(/, "要有 removePoint()");
  assert.match(html, /drag\.id = pinEl\.dataset\.id|drag\.id = e\.target/, "拖动要按 id 定位被拖的点");
  assert.match(html, /points\.find\(\(x\) => x\.id === drag\.id\)|find\(\(x\) => x\.id === id\)/, "要按 id 找到被拖的点");
  assert.match(html, /data-del/, "列表里要有删除按钮");
  assert.match(html, /Delete.*Backspace|Backspace.*Delete/, "支持键盘删除");
});

test("标注页：导出（复制 JSON / 下载 annotations.json）字段恰好五个", () => {
  assert.match(html, /export function exportJson\(/, "要有 exportJson()");
  const fn = html.slice(html.indexOf("export function exportJson("), html.indexOf("/** 解析 + 校验 + 整体替换"));
  for (const key of ["x_pct:", "y_pct:", "color:", "note:", "category:"]) {
    assert.ok(fn.includes(key), `导出 JSON 缺少字段 ${key}`);
  }
  assert.doesNotMatch(fn, /^\s*id:/m, "⛔ 内部 id 不许写进导出 JSON（格式固定为五个字段）");
  assert.match(html, /copyText\(/, "复制走 /js/ui.js 的 copyText()（含非安全上下文退路）");
  assert.match(html, /new Blob\(/, "下载要用 Blob");
  assert.match(html, /download = "annotations\.json"|a\.download = "annotations\.json"/, "下载文件名必须是 annotations.json");
  assert.match(html, /URL\.createObjectURL\(/, "下载要用 createObjectURL");
});

test("标注页：导入（粘贴 JSON → 解析 → 回填画布，脏数据要挡掉）", () => {
  assert.match(html, /export function importJson\(/, "要有 importJson()");
  assert.match(html, /JSON\.parse\(/, "导入要解析 JSON");
  assert.match(html, /Array\.isArray\(list\)/, "必须校验 points 是数组");
  assert.match(html, /function normalizePoint\(/, "导入的点要过归一/校验");
  assert.match(html, /HEX_RE\.test/, "颜色要按 #RRGGBB 校验");
  assert.match(html, /skipped/, "要如实报出跳过的无效条数");
  assert.match(html, /el\("textarea"\)/, "导入面板要有 textarea");
  assert.match(html, /createSheet\(\{\s*title:\s*"粘贴导入 JSON"/, "导入用 createSheet 面板");
});

test("标注页：只存内存 + localStorage（键名 beimingda.annotations），清空要二次确认", () => {
  assert.match(html, /const STORE_KEY = "beimingda\.annotations"/, "localStorage 键名必须一致");
  assert.match(html, /localStorage\.getItem\(STORE_KEY\)/, "启动要读本机存储");
  assert.match(html, /localStorage\.setItem\(STORE_KEY/, "改动要写本机存储");
  assert.match(html, /localStorage\.setItem\(STORE_KEY, exportJson\(\)\)/, "存的就是导出格式（同一份序列化）");
  assert.match(html, /openModal\(/, "清空要二次确认（用 ui.js 的 openModal）");
  assert.match(html, /catch\s*\{[\s\S]{0,120}return \[\]/, "读盘失败要兜底成空数组，不许白屏");
});

test("标注页：字号与间距只用设计刻度", () => {
  const fontSizes = [...styleBlock.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(fontSizes.length > 0);
  for (const v of fontSizes) assert.ok(FONT_SIZES.has(v), `字号 ${v}px 不在设计刻度里`);
  const spacingDecls = [...styleBlock.matchAll(/(?:padding|margin|gap)(?:-[a-z]+)?:\s*([^;]+);/g)];
  assert.ok(spacingDecls.length > 0);
  for (const decl of spacingDecls) {
    for (const m of decl[1].matchAll(/([0-9.]+)px/g)) {
      const v = Number(m[1]);
      assert.ok(SPACINGS.has(v), `间距 ${v}px 不在设计刻度里（${decl[0].trim()}）`);
    }
  }
  // 颜色一律走 app.css 令牌或页面自己的 --pin-* 变量
  assert.match(styleBlock, /--pri:\s*var\(--color-primary\)/, "主色必须引用 app.css 令牌");
  assert.match(styleBlock, /--card:\s*var\(--color-card\)/, "卡片底色必须引用 app.css 令牌");
});

test("标注页：静态路由可达（/tools/annotate 与底图都能 200）", async () => {
  process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-annotate-${process.pid}.db`);
  process.env.DEMO_TOKEN = process.env.DEMO_TOKEN || "annotate-test-token";
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/tools/annotate`);
    const body = await page.text();
    assert.equal(page.status, 200, "/tools/annotate 应可通过静态资源无扩展名访问");
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.ok(body.includes('id="zoomRange"'), "返回的就是标注页本体");

    const img = await fetch(`${base}/map/campus-map.jpg`);
    assert.equal(img.status, 200, "底图必须能取到");
    assert.match(img.headers.get("content-type") || "", /image\/jpeg/);
  } finally {
    server.close();
  }
});
