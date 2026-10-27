/**
 * F0 · 前端与门户 自测（node:test）
 *   npm test
 *
 * 覆盖 contracts/frontend.md §7 自测清单里可以由机器判定的部分：
 *   1. 我负责的两页（/ 与 /agent）以及全部共用静态资源都能 200 取到，JS 是 correct MIME
 *   2. 首页统计数字不写死（初始一律「—」），走真实 API 封装
 *   3. /agent 复制出来的 MCP 配置是合法 JSON、令牌是 <DEMO_TOKEN> 占位符、URL 不硬编码域名
 *   4. ?demo=1 演示模式机制存在（徽章 + 假名 + 打码）
 *   5. 无外部 CDN、无课表上传控件、无真实令牌
 *   6. api.js 行为：解信封 / 写接口带 X-Demo-Token / 未就绪安全降级返回 null
 *   7. nav.js 的 6 页导航与当前页高亮
 *   8. 14 个工具名与 docs/MCP-TOOLS.md 完全一致
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATIC = path.join(ROOT, "static");

// 独立临时库 + 测试令牌（在 import src/server.js 之前设好）
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-f0-${process.pid}.db`);
process.env.DEMO_TOKEN = "f0-test-token-1234";

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readStatic = (rel) => fs.readFileSync(path.join(STATIC, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const { createApp } = await import("../src/server.js");
const mcpConfig = await import("../static/js/mcp-config.js");
const nav = await import("../static/js/nav.js");
const demo = await import("../static/js/demo.js");

/* ------------------------------------------------------------------ 1. 交付物齐备 */
test("F0：7 个交付文件齐备且非空", () => {
  const files = [
    "static/css/app.css",
    "static/js/api.js",
    "static/js/nav.js",
    "static/js/demo.js",
    "static/js/mcp-config.js",
    "static/index.html",
    "static/agent.html",
  ];
  for (const f of files) {
    assert.ok(exists(f), `缺少交付文件 ${f}`);
    assert.ok(fs.statSync(path.join(ROOT, f)).size > 400, `${f} 内容过少，像是占位`);
  }
});

/* ------------------------------------------------------------------ 2. 视觉规范 */
test("契约 §4 视觉规范：颜色 / 12px 圆角 / 768px 断点 / 字体栈都在 app.css 里", () => {
  const css = readStatic("css/app.css");
  for (const token of ["#1f4e8c", "#2e8b76", "#c0392b", "#f5f7fa"]) {
    assert.ok(css.toLowerCase().includes(token), `app.css 缺颜色 ${token}`);
  }
  assert.match(css, /--radius-card:\s*12px/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /PingFang SC/);
  assert.match(css, /Microsoft YaHei/);
  assert.match(css, /Consolas/);
  // ≤768px 时导航收成底部 tab（position: fixed + bottom: 0）
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(mobileBlock, /\.site-nav\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(mobileBlock, /bottom:\s*0/);
  // 卡片单列
  assert.match(mobileBlock, /grid-template-columns:\s*1fr/);
  // 不许出现固定四位像素宽度（375px 下会破版）
  assert.ok(!/width:\s*\d{4,}px/.test(css), "app.css 里出现固定四位像素宽度");
});

/* ------------------------------------------------------------------ 3. 首页 4 区块 + 统计不写死 */
test("首页：4 个区块齐全，4 个统计初始值一律是「—」（⛔ 不写死数字）", () => {
  const html = readStatic("index.html");
  // 区块一 ~ 区块四的标题锚点
  assert.match(html, /id="hero-title"/);
  assert.match(html, /id="features"/);
  assert.match(html, /id="stats"/);
  assert.match(html, /id="agent-title"/);
  // 四张功能卡片 → 四个模块页
  for (const href of ["/takeout", "/buddy", "/welcome", "/schedule"]) {
    assert.ok(html.includes(`href="${href}"`), `首页缺功能卡片链接 ${href}`);
  }
  // 统计块：值必须是「—」占位，且带 stat--pending
  const ids = ["stat-tasks", "stat-runners", "stat-buddies", "stat-score"];
  for (const id of ids) {
    const re = new RegExp(`id="${id}"[\\s\\S]{0,220}?<div class="stat__value">([^<]*)</div>`);
    const m = html.match(re);
    assert.ok(m, `首页找不到统计块 ${id}`);
    assert.equal(m[1].trim(), "—", `${id} 的初始值必须是「—」，不许写死数字`);
  }
  // 统计确实走 API 封装（而不是本页自己 fetch）
  assert.match(html, /from "\/js\/api\.js"/);
  assert.match(html, /apiSafe\(/);
  assert.match(html, /\/api\/tasks/);
  assert.match(html, /\/api\/buddies/);
  assert.ok(!/fetch\(/.test(html), "首页不该自己写 fetch，统一走 /js/api.js");
  // 首页也要带演示模式与导航
  assert.match(html, /from "\/js\/nav\.js"/);
  assert.match(html, /from "\/js\/demo\.js"/);
});

/* ------------------------------------------------------------------ 4. ⭐ /agent 页 */
test("/agent：6 个区块齐全（含一键复制按钮与四步接入）", () => {
  const html = readStatic("agent.html");
  assert.match(html, /id="block1-title"/);
  assert.match(html, /id="block2-title"/);
  assert.match(html, /id="block3-title"/);
  assert.match(html, /id="block4-title"/);
  assert.match(html, /id="block5-title"/);
  assert.match(html, /id="block6-title"/);
  assert.match(html, /id="copy-btn"/);
  assert.match(html, /navigator\.clipboard/);
  assert.match(html, /id="mcp-json"/);
  // 四步接入：~/.workbuddy/mcp.json + 信任（文案在 js/mcp-config.js 里，页面负责渲染）
  const cfgSrc = readStatic("js/mcp-config.js");
  assert.match(cfgSrc, /~\/\.workbuddy\/mcp\.json/);
  assert.match(cfgSrc, /信任/);
  assert.match(html, /SETUP_STEPS/);
  // 不许有课表上传控件
  assert.ok(!/type="file"/.test(html), "/agent 页不该出现文件上传控件");
});

test("/agent：复制出来的 MCP 配置是合法 JSON、令牌为占位符、URL 不硬编码域名", () => {
  const json = mcpConfig.toMcpConfigJson({ origin: "https://demo.example.org", mode: "origin" });
  const parsed = JSON.parse(json); // ⛔ 不合法这里就炸了
  assert.deepEqual(Object.keys(parsed), ["mcpServers"]);
  const server = parsed.mcpServers.beimingda;
  assert.ok(server, "配置里必须有 mcpServers.beimingda");
  assert.equal(server.url, "https://demo.example.org/mcp");
  assert.equal(server.headers.Authorization, "Bearer <DEMO_TOKEN>");
  assert.ok(json.includes("<DEMO_TOKEN>"), "令牌必须是占位符");
  assert.ok(!/dpdns|knowingly/.test(json), "配置里不许出现硬编码的真实域名");
  // 两空格缩进、可直接粘贴
  assert.ok(json.includes('\n  "mcpServers"'));

  // 端点解析规则：默认跟随当前站点；取不到站点才退回服务端注入的域名
  assert.equal(mcpConfig.resolveMcpUrl({ origin: "http://127.0.0.1:3000", siteDomain: "", mode: "origin" }), "http://127.0.0.1:3000/mcp");
  assert.equal(mcpConfig.resolveMcpUrl({ origin: "", siteDomain: "demo.example.org", mode: "origin" }), "https://demo.example.org/mcp");
  assert.equal(mcpConfig.resolveMcpUrl({ origin: "http://127.0.0.1:3000", siteDomain: "demo.example.org", mode: "site" }), "https://demo.example.org/mcp");
  assert.equal(mcpConfig.resolveMcpUrl({ origin: "", siteDomain: "", mode: "origin" }), "");
  // 尾斜杠容错
  assert.equal(mcpConfig.resolveMcpUrl({ origin: "http://127.0.0.1:3000/", mode: "origin" }), "http://127.0.0.1:3000/mcp");
});

test("/agent：14 个工具名与 docs/MCP-TOOLS.md 完全一致（防文档漂移）", () => {
  const doc = readText("docs/MCP-TOOLS.md");
  const section = doc.split("## 14 个工具")[1].split("## 返回格式")[0];
  // 工具表是「3 列」：| `工具名` | 作用 | 关键约束 |（协议方法表只有 2 列，不会被匹配）
  const inDoc = [...section.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`[^|]*\|[^|]*\|[^|]*\|/gm)].map((m) => m[1]);
  const inCode = mcpConfig.toolNames();
  assert.equal(inDoc.length, 14, `docs 里解析到 ${inDoc.length} 个工具，应为 14`);
  assert.equal(mcpConfig.toolCount(), 14);
  assert.deepEqual([...inCode].sort(), [...inDoc].sort(), "前端工具清单与 docs/MCP-TOOLS.md 不一致");
  for (const g of mcpConfig.TOOLS_BY_MODULE) {
    assert.equal(g.tools.length, g.count, `${g.module} 的数量标注与实际不符`);
  }
  // 示例对话与四步指引照抄契约，条数固定
  assert.equal(mcpConfig.SAMPLE_DIALOGUES.length, 5);
  assert.equal(mcpConfig.SETUP_STEPS.length, 4);
});

/* ------------------------------------------------------------------ 5. 无外部 CDN / 无硬编码密钥 */
test("全站不依赖外部 CDN（断网可跑）：静态页里没有任何外链资源", () => {
  const htmlFiles = fs.readdirSync(STATIC).filter((f) => f.endsWith(".html"));
  assert.ok(htmlFiles.length >= 2, "至少要有所属本分支的两个页面");
  for (const f of htmlFiles) {
    const html = readStatic(f);
    const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
    assert.deepEqual(external, [], `${f} 引用了外部资源：${external.join(", ")}`);
    assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(html), `${f} 里 @import 了外部样式`);
  }
  const jsFiles = fs.readdirSync(path.join(STATIC, "js")).filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length >= 4);
  for (const f of jsFiles) {
    const js = readStatic(path.join("js", f));
    assert.ok(!/cdn\.|unpkg|jsdelivr|cdnjs/i.test(js), `js/${f} 引用了 CDN`);
    assert.ok(!/https?:\/\/(?!\$\{)/.test(js.replace(/https:\/\/\$\{domain\}/g, "")), `js/${f} 里出现外层 http(s) 地址`);
  }
});

test("全站不出现真实令牌，也不出现别的密钥形态", () => {
  const envFile = path.join(ROOT, ".env");
  let realToken = "";
  if (fs.existsSync(envFile)) {
    const m = /^\s*DEMO_TOKEN\s*=\s*(\S+)\s*$/m.exec(fs.readFileSync(envFile, "utf8"));
    realToken = m ? m[1] : "";
  }
  const targets = [
    "static/index.html",
    "static/agent.html",
    "static/js/api.js",
    "static/js/nav.js",
    "static/js/demo.js",
    "static/js/mcp-config.js",
  ];
  for (const f of targets) {
    const text = readText(f);
    if (realToken.length >= 6) {
      assert.ok(!text.includes(realToken), `${f} 里出现了 .env 中的真实 DEMO_TOKEN`);
    }
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), `${f} 里出现疑似 API key`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{12,}/.test(text), `${f} 里出现 Bearer + 疑似真令牌`);
    // 只允许占位符形态（或运行时拼接的模板变量）
    const bearers = [...text.matchAll(/Bearer\s+([^\s"'`\\]+)/g)]
      .map((m) => m[1])
      .filter((b) => !b.startsWith("${"));
    for (const b of bearers) assert.equal(b, "<DEMO_TOKEN>", `${f} 里的 Bearer 必须是占位符，实际是 ${b}`);
  }
  // 写接口令牌来源必须是「服务端注入 / 本机会话」，不许写死
  const api = readText("static/js/api.js");
  assert.match(api, /__DEMO_TOKEN__/);
  assert.match(api, /X-Demo-Token/);
});

/* ------------------------------------------------------------------ 6. api.js 行为 */
test("api.js：解信封 / 写接口带 X-Demo-Token / 未就绪安全降级（行为级，用 stub fetch）", async () => {
  const calls = [];
  const realFetch = globalThis.fetch; // 用完必须还原：后面的 HTTP 用例要真发请求
  const makeRes = (body, status = 200, ctype = "application/json") => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => ctype },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  try {
    globalThis.window = { __DEMO_TOKEN__: "injected-from-server" };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/ok") return makeRes({ ok: true, data: { hello: 1 }, error: null });
    if (url === "/api/boom") return makeRes({ ok: false, data: null, error: { code: "SCHEMA_REJECTED", message: "参数不对" } });
    if (url === "/api/down") throw new Error("ECONNREFUSED");
    return makeRes("oops", 500, "text/plain");
  };

  const apiMod = await import("../static/js/api.js");

  // 1) 成功：返回 data（信封被解开）
  assert.deepEqual(await apiMod.api("/api/ok"), { hello: 1 });
  // 2) 读接口不带令牌
  assert.equal(calls[0].init.headers["X-Demo-Token"], undefined);
  // 3) 写接口自动带令牌（来自服务端注入的 window.__DEMO_TOKEN__）
  await apiMod.api("/api/ok", { method: "POST", body: { a: 1 } });
  assert.equal(calls[1].init.headers["X-Demo-Token"], "injected-from-server");
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(calls[1].init.body, JSON.stringify({ a: 1 }));
  // 4) 失败信封 → 抛带 code 的 ApiError
  await assert.rejects(() => apiMod.api("/api/boom"), (e) => {
    assert.equal(e.name, "ApiError");
    assert.equal(e.code, "SCHEMA_REJECTED");
    assert.equal(e.message, "参数不对");
    return true;
  });
  // 5) 未就绪安全降级：apiSafe / apiList 返回 null，不抛
  assert.equal(await apiMod.apiSafe("/api/down"), null);
  assert.equal(await apiMod.apiSafe("/api/nope"), null);
  assert.equal(await apiMod.apiList("/api/nope"), null);
  assert.equal(apiMod.lastError("/api/down").code, "INTERNAL");
  // 6) 裸数组也认（兼容模块先直接 res.json(array) 的写法）
  globalThis.fetch = async () => makeRes([{ id: 1 }]);
  assert.deepEqual(await apiMod.apiList("/api/any"), [{ id: 1 }]);
  // 7) 裸数据兜底：没有 ok 字段的对象原样返回
  globalThis.fetch = async () => makeRes({ version: "1.0.0" });
  assert.deepEqual(await apiMod.api("/api/raw"), { version: "1.0.0" });
  // 8) 非 JSON + 500 → 抛 INTERNAL 并带状态码
  globalThis.fetch = async () => makeRes("oops", 500, "text/plain");
  await assert.rejects(() => apiMod.api("/api/plain"), (e) => {
    assert.equal(e.code, "INTERNAL");
    assert.equal(e.status, 500);
    return true;
  });

  // 9) MCP JSON-RPC：兼容 text/event-stream 回法 + Bearer 令牌
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"task_publish"},{"name":"buddy_search"}]}}\n\n';
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return makeRes(sse, 200, "text/event-stream");
  };
  assert.deepEqual(await apiMod.mcpToolNames(), ["task_publish", "buddy_search"]);
  const last = calls[calls.length - 1];
  assert.equal(last.url, "/mcp");
  assert.equal(last.init.headers.Authorization, "Bearer injected-from-server");
  // 无令牌 / 失败时返回 null（页面回退到内置清单）
  globalThis.fetch = async () => makeRes("401", 401, "text/plain");
  assert.equal(await apiMod.mcpToolNames(), null);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete globalThis.sessionStorage;
  }
});

/* ------------------------------------------------------------------ 7. nav.js */
test("nav.js：6 页导航 + 当前页判定（含 .html / 无扩展名 / 未知路径）", () => {
  assert.equal(nav.PAGES.length, 6);
  assert.deepEqual(
    nav.PAGES.map((p) => p.href),
    ["/", "/takeout", "/buddy", "/welcome", "/schedule", "/agent"],
  );
  for (const p of nav.PAGES) assert.ok(p.id && p.label && p.icon, `导航项 ${p.href} 元信息不全`);
  assert.equal(nav.currentPageId("/"), "index");
  assert.equal(nav.currentPageId("/index.html"), "index");
  assert.equal(nav.currentPageId("/agent"), "agent");
  assert.equal(nav.currentPageId("/agent.html"), "agent");
  assert.equal(nav.currentPageId("/welcome/"), "welcome");
  assert.equal(nav.currentPageId("/nope"), "");
  // 只产出 <a href>，不去 fetch 别的页面（其他模块页暂时 404 也不影响本页）
  const src = readText("static/js/nav.js");
  assert.ok(!/fetch\(/.test(src), "nav.js 不该 fetch 其他页面");
  assert.match(src, /aria-current="page"/);
});

/* ------------------------------------------------------------------ 8. demo.js */
test("demo.js：?demo=1 判定、稳定假名、学号/手机号打码", () => {
  assert.match(readText("static/js/demo.js"), /"1"/);
  // 打码：手机号与 8 位学号被替换，10 位时间戳不动
  assert.equal(demo.maskSensitiveText("联系 13812345678"), "联系 1XXXXXXXXXX");
  assert.equal(demo.maskSensitiveText("学号 20251234 已登记"), "学号 2025XXXX 已登记");
  assert.equal(demo.maskSensitiveText("deadline 1793030400"), "deadline 1793030400");
  // 假名稳定：同一个原始姓名永远得到同一个「同学X」，不同人不同名
  const a1 = demo.aliasFor("甲");
  const b1 = demo.aliasFor("乙");
  assert.equal(demo.aliasFor("甲"), a1);
  assert.notEqual(a1, b1);
  assert.match(a1, /^同学[A-Z]$/);
  // 非 demo 模式 displayName 原样返回
  assert.equal(demo.displayName("甲"), "甲");
  assert.equal(demo.isDemo(), false);
});

/* ------------------------------------------------------------------ 9. HTTP 层（真起服务） */
test("HTTP：/ 与 /agent 及全部共用资源 200，JS 的 MIME 必须是 javascript", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const pages = ["/", "/agent"];
    for (const p of pages) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `${p} 应 200`);
      const html = await r.text();
      assert.ok(html.includes("北名大小助手"), `${p} 内容不对`);
    }

    const assets = ["/css/app.css", "/js/api.js", "/js/nav.js", "/js/demo.js", "/js/mcp-config.js", "/config.js"];
    for (const a of assets) {
      const r = await fetch(base + a);
      assert.equal(r.status, 200, `${a} 应 200`);
      const ct = r.headers.get("content-type") || "";
      if (a.endsWith(".js")) {
        assert.match(ct, /javascript/i, `${a} 的 MIME 必须是 javascript（否则 ES module 不加载），实际 ${ct}`);
      }
      const minLen = a === "/config.js" ? 20 : 200; // /config.js 是几行注入语句，本来就短
      assert.ok((await r.text()).length > minLen, `${a} 内容过少`);
    }

    // 6 页路由里本分支没交付的 4 页允许 404（各模块分支负责），但导航链接必须已在 HTML 里
    const home = await fetch(`${base}/`).then((r) => r.text());
    for (const href of ["/takeout", "/buddy", "/welcome", "/schedule", "/agent"]) {
      assert.ok(home.includes(href), `首页导航缺 ${href}`);
    }
  } finally {
    server.close();
  }
});
