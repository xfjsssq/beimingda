/**
 * 页面级静态回归守卫（`npm test` 会跑）
 *
 * 背景：真机上出现过一类「接口返回统一信封 {ok,data,error}，页面却把结果直接当数组用」的 bug ——
 * `/welcome` 曾因此**一个点位都画不出来**，而 `npm run smoke` / `npm run verify` 只查 HTTP 200，
 * 抓不到 DOM 层的问题（是靠人工/浏览器走查才发现的）。
 *
 * 这里用**静态断言**把几条容易复发的约定钉死：改页面时若破坏约定，`npm test` 立刻红。
 * ⛔ 这些断言只读文件、不起服务，跑得很快；真正的行为验证在 tests/*-*.test.js 与浏览器走查里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGES = ["index", "takeout", "buddy", "welcome", "schedule", "agent"];

test("页面：都引 /config.js（令牌与站点域名只从服务端注入，⛔ 页面不硬编码）", () => {
  for (const p of PAGES) {
    const html = read(`static/${p}.html`);
    assert.match(html, /\/config\.js/, `static/${p}.html 没有引用 /config.js`);
  }
});

test("页面：/welcome 取 /api/map/nodes 必须解信封（否则地图上画不出点位）", () => {
  const html = read("static/welcome.html");
  // 必须走解信封的封装
  assert.match(
    html,
    /getApiData\(\s*["']\/api\/map\/nodes["']/,
    "/welcome 取 /api/map/nodes 必须走 getApiData() 解信封",
  );
  // 不允许再出现「直接把接口结果当数组」的旧写法
  assert.doesNotMatch(
    html,
    /getJson\(\s*["']\/api\/map\/nodes["']/,
    "不要再用 getJson 直接取 /api/map/nodes（它返回的是信封，不是数组）",
  );
  // 解包实现必须是「信封 ok:true 取 .data」的语义
  assert.match(html, /body\.ok\s*===\s*true/);
  assert.match(html, /body\.data/);
});

test("页面：/takeout 与 /buddy 必须接入 ?demo=1 演示模式（路演与直播一律用 ?demo=1）", () => {
  for (const p of ["takeout", "buddy"]) {
    const html = read(`static/${p}.html`);
    assert.match(html, /\/js\/demo\.js/, `static/${p}.html 没有接入 /js/demo.js`);
  }
});

test("合规：全站只有 /takeout 有文件上传控件（代取截图），其余页面不许有", () => {
  for (const p of PAGES) {
    const html = read(`static/${p}.html`);
    const hasFileInput = /type\s*=\s*["']file["']/.test(html);
    if (p === "takeout") assert.ok(hasFileInput, "takeout 负责截图上传，应保留上传控件");
    else assert.ok(!hasFileInput, `static/${p}.html 不应有 input[type=file]（frontend.md §7）`);
  }
});

test("页面：首页统计不探测不存在的接口（空实例上不许打 404 噪音）", () => {
  const html = read("static/index.html");
  const probeLists = [...html.matchAll(/paths:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(probeLists.length > 0, "首页应有统计探测清单");
  for (const list of probeLists) {
    assert.doesNotMatch(list, /\/api\/stats/, "首页不应探测不存在的 /api/stats");
  }
});

test("页面：/schedule 的周课表在窄屏用可滚动容器（不许把课程名压成逐字竖排）", () => {
  const html = read("static/schedule.html");
  assert.match(html, /#gridWrap\s*\{[^}]*overflow-x\s*:\s*auto/);
});

test("接口：页面依赖的 /api/map/nodes 必须返回「信封 + data 是数组」", async () => {
  process.env.DB_PATH = path.join(
    (await import("node:os")).tmpdir(),
    `beimingda-page-regress-${process.pid}.db`,
  );
  process.env.DEMO_TOKEN = process.env.DEMO_TOKEN || "page-regress-token";
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = await fetch(`${base}/api/map/nodes`).then((r) => r.json());
    assert.equal(body.ok, true);
    assert.equal(body.error, null);
    assert.ok(Array.isArray(body.data), "/api/map/nodes 的 data 必须是数组");
  } finally {
    server.close();
  }
});
