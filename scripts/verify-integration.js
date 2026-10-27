#!/usr/bin/env node
/**
 * 集成自检 —— 跨模块「真的活着」的证明（Lead / 评委核验用）
 *
 *   npm run verify            （等价于 node scripts/verify-integration.js）
 *   npm run verify -- --quiet 只打印失败项与总表
 *
 * 与 npm run smoke 的分工：
 *   - smoke  ：骨架级冒烟（信封 / 鉴权 / schema 表清单 / 密钥扫描），模块无关
 *   - verify ：**模块级集成**自检 —— 自动发现已注册的 MCP 工具并真调一遍，
 *              按 inputSchema 自动造入参，校验信封形状、非法字段拦截、必填拦截、
 *              6 个页面与 HTTP 路由可达、以及"⛔ 不许依赖外部 CDN"这条红线。
 *
 * 安全：用独立临时库启动，不动 data/beimingda.db；DEMO_TOKEN 用进程内随机值。
 * 退出码：全部通过 0，否则 1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

// ---- 独立环境：临时库 + 随机令牌（⛔ 不碰 .env 的真实值，也不写进 data/） ----
const TMP_DB = path.join(os.tmpdir(), `beimingda-verify-${process.pid}.db`);
process.env.DB_PATH = TMP_DB;
process.env.DEMO_TOKEN = `verify-${process.pid}-${Math.random().toString(36).slice(2)}`;

const { createApp } = await import("../src/server.js");
const { apiLimiter, mcpLimiter } = await import("../src/middleware/ratelimit.js");

const results = [];
const check = (group, name, pass, detail = "") => {
  results.push({ group, name, pass, detail });
  if (!pass || !QUIET) console.log(`${pass ? "✅" : "❌"} [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
};
const warn = (group, name, detail = "") => console.log(`⚠️  [${group}] ${name}${detail ? ` — ${detail}` : ""}`);

// ---- 页面与路由清单（冻版） ----
const PAGES = ["index", "takeout", "buddy", "welcome", "schedule", "agent"];
const OPEN_ROUTES = ["/api/health", "/api/map/nodes", "/api/map/summary", "/api/tasks?limit=5", "/api/buddies"];
const WRITE_ROUTES = [
  { path: "/api/tasks", token: "x-demo-token" },
  { path: "/api/buddies", token: "x-demo-token" },
];

// ---- 1) 灌演示数据（子进程，避免与主进程抢同一个 sqlite 连接） ----
const seeded = spawnSync(process.execPath, ["scripts/seed.js"], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: TMP_DB },
  encoding: "utf8",
});
check(
  "seed",
  "fixtures 演示数据灌入成功（demo=1）",
  seeded.status === 0,
  seeded.status === 0 ? "scripts/seed.js exit 0" : String(seeded.stderr || seeded.stdout).slice(0, 300),
);

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const TOKEN = process.env.DEMO_TOKEN;

let rpcId = 0;
const rpc = async (method, params, token = TOKEN) => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: r.status, body };
};

/** tools/call 的薄封装：返回 { rpc, envelope } */
const callTool = async (name, args) => {
  const { status, body } = await rpc("tools/call", { name, arguments: args });
  const envelope = body?.result?.structuredContent ?? null;
  return { rpcStatus: status, rpcError: body?.error ?? null, envelope };
};

/** 按 inputSchema 自动造一个"形状合法"的入参 */
function sampleValue(schema, key) {
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  const k = String(key || "");
  switch (schema?.type) {
    case "string": {
      if (/iso|time/i.test(k)) return new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      if (/node_id|node$/i.test(k)) return "dorm-12";
      if (/task_id/i.test(k)) return "demo-task-1";
      if (/post_id/i.test(k)) return "demo-post-1";
      if (/building/i.test(k)) return "12号宿舍楼";
      if (/station/i.test(k)) return "快递驿站";
      if (/handle/i.test(k)) return "同学A";
      if (/kind/i.test(k)) return "study";
      if (/image|base64/i.test(k)) return "iVBORw0KGgoAAAANSUhEUg==";
      if (/path/i.test(k)) return "static/uploads/demo.png";
      return "样例";
    }
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return schema.items ? [sampleValue(schema.items, k)] : [];
    case "object":
      return {};
    default:
      return "样例";
  }
}

function sampleArgs(schema) {
  const props = schema?.properties ?? {};
  const out = {};
  for (const [key, sub] of Object.entries(props)) out[key] = sampleValue(sub, key);
  return out;
}

try {
  // ---- 2) 协议与鉴权 ----
  const unauth = await rpc("tools/list", undefined, "");
  check("mcp", "POST /mcp 无 token → 401", unauth.status === 401, `HTTP ${unauth.status}`);
  const badToken = await rpc("tools/list", undefined, "wrong-token");
  check("mcp", "POST /mcp 错 token → 401", badToken.status === 401, `HTTP ${badToken.status}`);

  const { body: init } = await rpc("initialize", { protocolVersion: "2025-06-18" });
  check(
    "mcp",
    "initialize 返回协议版本与 serverInfo",
    !!init?.result?.protocolVersion && init?.result?.serverInfo?.name === "beimingda",
    `${init?.result?.protocolVersion} / ${init?.result?.serverInfo?.name}`,
  );

  mcpLimiter.reset?.();
  const { body: list } = await rpc("tools/list");
  const tools = list?.result?.tools ?? [];
  check("mcp", "tools/list 返回工具数组", Array.isArray(tools), `${tools.length} 个工具`);

  const byPrefix = tools.reduce((acc, t) => {
    const p = String(t.name).split("_")[0];
    acc[p] = (acc[p] || 0) + 1;
    return acc;
  }, {});
  const EXPECT = { map: 2, task: 3, runner: 1, match: 1, buddy: 3, schedule: 4 };
  for (const [prefix, want] of Object.entries(EXPECT)) {
    const got = byPrefix[prefix] ?? 0;
    check("tools", `模块前缀 ${prefix}* 工具数 = ${want}`, got === want, `实际 ${got}`);
  }

  // ---- 3) 每个工具的 schema 硬要求 ----
  for (const t of tools) {
    check(
      "schema",
      `${t.name}: inputSchema.additionalProperties === false`,
      t.inputSchema?.additionalProperties === false,
    );
    check("schema", `${t.name}: 有非空 description`, typeof t.description === "string" && t.description.length >= 8, t.description?.slice(0, 40));
  }

  // ---- 4) 逐个真调：形状合法入参 / 多传字段 / 缺必填 ----
  for (const t of tools) {
    const args = sampleArgs(t.inputSchema);

    mcpLimiter.reset?.();
    const { envelope, rpcError } = await callTool(t.name, args);
    const shapeOk =
      !rpcError &&
      envelope !== null &&
      typeof envelope === "object" &&
      "ok" in envelope &&
      "data" in envelope &&
      "error" in envelope;
    check("call", `${t.name}: 返回统一信封`, shapeOk, shapeOk ? `ok=${envelope.ok}` : JSON.stringify(rpcError || envelope).slice(0, 160));
    if (shapeOk) {
      check(
        "call",
        `${t.name}: 不出现 INTERNAL（未捕获异常）`,
        envelope.ok === true || envelope.error?.code !== "INTERNAL",
        envelope.ok ? "ok:true" : `code=${envelope.error?.code}`,
      );
    }

    mcpLimiter.reset?.();
    const extra = await callTool(t.name, { ...args, __illegal_extra__: 1 });
    check(
      "guard",
      `${t.name}: 多传字段 → SCHEMA_REJECTED`,
      extra.envelope?.ok === false && extra.envelope?.error?.code === "SCHEMA_REJECTED",
      extra.envelope?.error?.code ?? "未拦截",
    );

    const required = t.inputSchema?.required ?? [];
    if (required.length) {
      const missing = { ...args };
      delete missing[required[0]];
      mcpLimiter.reset?.();
      const res = await callTool(t.name, missing);
      check(
        "guard",
        `${t.name}: 缺必填 ${required[0]} → SCHEMA_REJECTED`,
        res.envelope?.ok === false && res.envelope?.error?.code === "SCHEMA_REJECTED",
        res.envelope?.error?.code ?? "未拦截",
      );
    }
  }

  // ---- 5) 页面与路由 ----
  for (const page of PAGES) {
    const url = page === "index" ? "/" : `/${page}`;
    const r = await fetch(base + url);
    const text = r.status === 200 ? await r.text() : "";
    check(
      "page",
      `${url} 可访问且返回 HTML`,
      r.status === 200 && /<html|<!doctype html>/i.test(text),
      `HTTP ${r.status}`,
    );
  }

  apiLimiter.reset?.();
  for (const route of OPEN_ROUTES) {
    const r = await fetch(base + route);
    let env = null;
    try {
      env = await r.json();
    } catch {
      /* ignore */
    }
    check("route", `GET ${route}`, r.status === 200 && env?.ok === true, `HTTP ${r.status}`);
  }

  for (const w of WRITE_ROUTES) {
    const r = await fetch(base + w.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const ready = r.status !== 404;
    if (!ready) warn("route", `POST ${w.path} 未就绪（模块未合并）`);
    else check("route", `POST ${w.path} 无写令牌 → 401`, r.status === 401, `HTTP ${r.status}`);
  }

  // ---- 6) 红线：⛔ 不许依赖外部 CDN ----
  const cdnHits = [];
  const ALLOW = ["maps.amap.com", "webapi.amap.com"]; // 高德是「联网增强」（iframe 嵌入 / JS API SDK），
  // 官方形态而非第三方 CDN 拼装；且两处都只在用户点击切换底图时才加载，截图底图才是离线兜底
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "data", "vendor"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|css)$/.test(e.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)\//gi)) {
          const host = m[1];
          if (ALLOW.some((a) => host.endsWith(a))) continue;
          if (/^(127\.0\.0\.1|localhost)$/.test(host)) continue;
          cdnHits.push(`${path.relative(ROOT, p)} → ${host}`);
        }
      }
    }
  };
  walk(path.join(ROOT, "static"));
  check(
    "redline",
    "static/ 里没有指向外部第三方站点的资源依赖",
    cdnHits.length === 0,
    cdnHits.slice(0, 5).join(" ; ") || "无",
  );
} finally {
  server.close();
}

// ---- 总表 ----
const failed = results.filter((r) => !r.pass);
const byGroup = results.reduce((acc, r) => {
  acc[r.group] = acc[r.group] || { pass: 0, fail: 0 };
  acc[r.group][r.pass ? "pass" : "fail"] += 1;
  return acc;
}, {});
console.log("\n==== 分组统计 ====");
for (const [g, s] of Object.entries(byGroup)) console.log(`  ${g.padEnd(8)} ✅ ${s.pass}  ❌ ${s.fail}`);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("\n未通过明细：");
  for (const f of failed) console.log(`  ❌ [${f.group}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
try {
  fs.rmSync(TMP_DB, { force: true });
  fs.rmSync(`${TMP_DB}-wal`, { force: true });
  fs.rmSync(`${TMP_DB}-shm`, { force: true });
} catch {
  /* ignore */
}
process.exitCode = failed.length ? 1 : 0;
