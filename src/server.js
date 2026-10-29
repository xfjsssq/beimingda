/**
 * HTTP 入口与路由注册（冻版骨架）
 *   - 托管 static/（零构建静态站点）
 *   - /api/* 走 HTTP API 路由，单 IP 60 次/分钟
 *   - /mcp   走 MCP Streamable HTTP 端点，工具调用 30 次/分钟
 *   - 无扩展名路径映射：/takeout → static/takeout.html（6 页路由约定）
 *   - 密钥只从 process.env 读
 *
 * 启动：npm start        （无 .env 亦可跑，缺 DEMO_TOKEN 时写接口 401）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { initDb, dbPath } from "./db/index.js";
import { apiLimiter } from "./middleware/ratelimit.js";
import { createApiRouter } from "./api/routes.js";
import { createMcpRouter } from "./mcp/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATIC_DIR = path.join(ROOT, "static");

/** 极简 .env 读取（避免额外依赖；已被 .gitignore 忽略） */
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
      val = val.slice(1, -1);                       // 带引号：原样取值，不剥注释
    } else {
      val = val.replace(/\s+#.*$/, "").trim();      // 不带引号：剥掉行尾 ` # 注释`，避免把说明当成密钥
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** 6 个页面的无扩展名路由 → 对应 html（页面本体由 F0/各模块分支提供） */
const PAGES = ["index", "takeout", "buddy", "welcome", "schedule", "agent"];

export function createApp() {
  loadDotEnv();
  initDb();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  // favicon：浏览器会固定请求 /favicon.ico，重定向到我们自己的 SVG 图标。
  //   不加的话每页 console 都会有一条 404 噪音（独立验证员在真机走查里报过）。
  app.get("/favicon.ico", (req, res) => res.redirect(301, "/favicon.svg"));

  // 前端配置注入：地图 key 等只在这里透出，⛔ 页面里不许硬编码
  //   ⚠️ __DEMO_TOKEN__ 是「演示令牌」，按 contracts/core.md §4 它本就是公开给评委的
  //      （只读 + 限频 + 短周期轮换，泄露无风险）。注入它只为让页面上的写接口
  //      （发布代取任务 / 发搭子帖）零操作可用；⛔ 页面不许把它回显到界面上。
  //   ⚠️ __AMAP_KEY__ 是高德 Web端(JS API) key：域名白名单填 knowingly.dpdns.org，
  //      演示域名 demo.knowingly.dpdns.org 作为其子域已实测通过；未配置时前端自动回退截图底图。
  //      若控制台启用了「安全密钥」，把 AMAP_SECURITY_CODE 一起配上（实测本项目可留空）。
  app.get("/config.js", (req, res) => {
    const amapKey = process.env.AMAP_JS_KEY || "";
    const amapSec = process.env.AMAP_SECURITY_CODE || "";
    res.type("application/javascript").send(
      `window.__TILE_KEY__=${JSON.stringify(process.env.TILE_PROVIDER_KEY || "")};` +
        `window.__SITE_DOMAIN__=${JSON.stringify(process.env.SITE_DOMAIN || "")};` +
        `window.__DEMO_TOKEN__=${JSON.stringify(process.env.DEMO_TOKEN || "")};` +
        `window.__AMAP_KEY__=${JSON.stringify(amapKey)};` +
        `window.__AMAP_SECURITY_CODE__=${JSON.stringify(amapSec)};` +
        `window.__APP_VERSION__=${JSON.stringify(process.env.npm_package_version || "0.1.0")};\n`,
    );
  });

  // HTTP API
  app.use("/api", apiLimiter, createApiRouter());

  // MCP 远程端点（必须零配置可接入：POST /mcp）
  app.use("/mcp", createMcpRouter());

  // 无扩展名页面路由（/takeout → static/takeout.html）
  for (const page of PAGES) {
    app.get(`/${page === "index" ? "" : page}`, (req, res, next) => {
      const file = path.join(STATIC_DIR, `${page}.html`);
      if (!fs.existsSync(file)) return next();
      res.sendFile(file);
    });
  }

  // 静态资源（static/css、static/js、static/vendor、pano/ 等）
  app.use(express.static(STATIC_DIR, { extensions: ["html"] }));
  app.use("/pano", express.static(path.join(ROOT, "pano")));

  // 404：接口/ MCP 仍然回统一信封；浏览器请求给一个品牌化的 404 页面（B10 交付项）
  app.use((req, res) => {
    const wantsHtml = !req.path.startsWith("/api") && !req.path.startsWith("/mcp") &&
      String(req.get("accept") || "").includes("text/html");
    const file404 = path.join(STATIC_DIR, "404.html");
    if (wantsHtml && fs.existsSync(file404)) return res.status(404).sendFile(file404);
    res
      .status(404)
      .json({ ok: false, data: null, error: { code: "NOT_FOUND", message: "not found" } });
  });

  // 兜底错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    const isJson = req.path.startsWith("/api") || req.path.startsWith("/mcp");
    const payload = { ok: false, data: null, error: { code: "INTERNAL", message: e?.message } };
    if (isJson) return res.status(500).json(payload);
    return res.status(500).send(payload.error.message || "internal error");
  });

  return app;
}

function main() {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  const server = app.listen(port, () => {
    const mask = (v) => (v ? "set" : "MISSING");
    console.log(
      [
        `[beimingda] listening on http://127.0.0.1:${port}`,
        `[beimingda] db            : ${dbPath()}`,
        `[beimingda] DEMO_TOKEN    : ${mask(process.env.DEMO_TOKEN)}`,
        `[beimingda] TILE_PROVIDER : ${mask(process.env.TILE_PROVIDER_KEY)}`,
        `[beimingda] MCP endpoint  : POST /mcp`,
        `[beimingda] health        : GET /api/health`,
      ].join("\n"),
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

export default { createApp, main };
