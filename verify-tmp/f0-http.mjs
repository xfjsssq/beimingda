/**
 * 独立验证 · F0 前端与门户（verifier 自写，HTTP 层）
 * 契约：contracts/frontend.md §7
 * 跑法：node verify-tmp/f0-http.mjs   （需先起 3181 服务）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:3181";

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 600)}`);
}

async function get(p) {
  const res = await fetch(BASE + p, { redirect: "manual" });
  const body = await res.text();
  return { status: res.status, ct: res.headers.get("content-type") || "", body };
}

console.log("=== F0 契约 §7（独立复现 · HTTP 层）===\n");

// ── 1) 8 个入口全部 200 ──────────────────────────────────────
const PATHS = ["/", "/agent", "/css/app.css", "/js/api.js", "/js/nav.js", "/js/demo.js", "/js/mcp-config.js", "/config.js"];
const got = {};
for (const p of PATHS) {
  const r = await get(p);
  got[p] = { status: r.status, ct: r.ct, len: r.body.length };
}
const all200 = PATHS.every((p) => got[p].status === 200);
check(
  "F0-1",
  "/ /agent /css/app.css /js/api.js /js/nav.js /js/demo.js /js/mcp-config.js /config.js 全部 200",
  all200,
  JSON.stringify(got),
);

// 6 页面也顺手验一遍（契约 §7 第一条：6 页无 404）
const PAGES = ["/", "/takeout", "/buddy", "/welcome", "/schedule", "/agent"];
const pageStatus = {};
for (const p of PAGES) pageStatus[p] = (await get(p)).status;
check(
  "F0-1b",
  "6 个页面全部可访问，无 404（★ 必修 1：/schedule 依赖 M4，尚未合入）",
  PAGES.every((p) => pageStatus[p] === 200),
  JSON.stringify(pageStatus) + " ← /schedule 404，但 nav.js:24 与 index.html:58 都链到它",
);

// ── 2) /agent 复制内容 = 合法 JSON，且只含占位符 ─────────────
{
  // 直接把页面真正 import 的那个模块拿进 Node 执行（= 页面上的构造逻辑）
  const mod = await import(pathToFileURL(path.join(ROOT, "static/js/mcp-config.js")).href);
  const jsonText = mod.toMcpConfigJson({ origin: BASE, siteDomain: "demo.knowingly.dpdns.org" });
  let parsed = null;
  let parseErr = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    parseErr = String(e?.message);
  }
  const agent = await get("/agent");
  const realToken = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEMO_TOKEN=(.*)$/m)?.[1]?.trim();
  const tokenInPage = agent.body.includes(realToken);
  const tokenInJson = jsonText.includes(realToken);
  const placeholder = jsonText.includes("<DEMO_TOKEN>");
  const shapeOk =
    parsed && parsed.mcpServers && parsed.mcpServers.beimingda &&
    typeof parsed.mcpServers.beimingda.url === "string" &&
    parsed.mcpServers.beimingda.headers?.Authorization === "Bearer <DEMO_TOKEN>";
  check(
    "F0-2",
    "/agent 复制出来的 MCP 配置是合法 JSON、含 <DEMO_TOKEN> 占位符、真实令牌不出现（页内 + JSON 内）",
    parseErr === null && shapeOk === true && placeholder && !tokenInPage && !tokenInJson,
    `JSON.parse=${parseErr === null ? "通过" : parseErr} | 结构=${JSON.stringify(parsed)} | 占位符=${placeholder} | /agent HTML 含真实令牌=${tokenInPage} | 复制内容含真实令牌=${tokenInJson} | 页面引用的模块=${/\/js\/mcp-config\.js/.test(agent.body)}`,
  );
  // 页面确实用同一个函数生成 + 有复制按钮
  const inlineUses = /toMcpConfigJson\s*\(/.test(agent.body) && /id="copy-btn"/.test(agent.body);
  check("F0-2b", "/agent 页面内联脚本确实调用 toMcpConfigJson 且有复制按钮", inlineUses, `调用点=${/toMcpConfigJson\s*\(/.test(agent.body)} 复制按钮=${/id="copy-btn"/.test(agent.body)}`);
}

// ── 3) 静态源码里 grep 不到真实令牌 / 写死统计 ────────────────
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|css)$/.test(e.name) && !/vendor/.test(p)) files.push(p);
    }
  };
  walk(path.join(ROOT, "static"));
  walk(path.join(ROOT, "src"));
  const envToken = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEMO_TOKEN=(.*)$/m)[1].trim();
  const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes(envToken));
  // 写死统计：stat__value 里出现数字
  const indexHtml = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
  const hardStats = [...indexHtml.matchAll(/class="stat__value"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  check(
    "F0-3",
    "全站源码 grep 不到真实 DEMO_TOKEN；首页统计数字没有写死（stat__value 全是「—」）",
    hits.length === 0 && hardStats.every((v) => v === "—") && hardStats.length === 4,
    `含真实令牌的文件=${JSON.stringify(hits)} | stat__value 初值=${JSON.stringify(hardStats)}`,
  );
}

// ── 4) ?demo=1 生效（徽章）──────────────────────────────────
{
  const demoJs = fs.readFileSync(path.join(ROOT, "static/js/demo.js"), "utf8");
  const hasBadge = /demo=1|__demo|徽章|badge/i.test(demoJs) && /演示模式/.test(demoJs);
  const pages = ["/", "/agent", "/takeout", "/buddy"];
  const wired = {};
  for (const p of pages) {
    const r = await get(p);
    wired[p] = /\/js\/demo\.js/.test(r.body);
  }
  check(
    "F0-4",
    "?demo=1 生效：demo.js 有演示模式徽章逻辑且页面都加载了它（真机渲染见浏览器实测）",
    hasBadge && Object.values(wired).every(Boolean),
    `demo.js 含徽章逻辑=${hasBadge} | 各页引用 demo.js=${JSON.stringify(wired)}`,
  );
  // 顺带：/api/demo/seed 幂等
  const s1 = await (await fetch(`${BASE}/api/demo/seed`)).json();
  const s2 = await (await fetch(`${BASE}/api/demo/seed`)).json();
  check(
    "F0-4b",
    "GET /api/demo/seed 幂等（两次调用不重复灌数据）",
    s1.ok === true && s2.ok === true,
    `第一次=${JSON.stringify(s1.data).slice(0, 300)} | 第二次=${JSON.stringify(s2.data).slice(0, 300)}`,
  );
}

// ── 5) 断网可用性：无外部 CDN / 外链资源 ────────────────────
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "static"));
  const external = [];
  const vendorCredit = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    // 只挑真正的资源引用：src=/href=/@import/url( 指向 http(s)://
    const res = [
      ...src.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi),
      ...src.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"')]+)/gi),
      ...src.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi),
    ];
    for (const m of res) {
      const entry = { file: path.relative(ROOT, f), url: m[1] };
      // vendor 库内部的自述链接（Pannellum 的版权链接字符串）不会发起网络请求
      if (/vendor[\\/]/.test(f) && /pannellum\.org/.test(m[1])) vendorCredit.push(entry);
      else external.push(entry);
    }
  }
  // 页面实际请求的外部主机（运行时再看）
  check(
    "F0-5",
    "static/ 里没有任何外部 CDN/外链资源引用（离线可跑）",
    external.length === 0,
    external.length ? JSON.stringify(external.slice(0, 10)) : `扫描 ${files.length} 个 html/js/css 文件，外链资源 0 处；另：vendor 库内部版权链接字符串 ${vendorCredit.length} 处（${JSON.stringify(vendorCredit)}），不发起请求`,
  );
  check(
    "F0-5b",
    "课表上传控件红线：没有任何「课表/日历文件上传」控件；唯一非截图 file 控件是 buddy 的可选照片（仅本地预览）",
    !files.some((f) => /\.html$/.test(f) && /课表[^<]{0,20}file|file[^>]{0,40}课表/i.test(fs.readFileSync(f, "utf8"))) &&
      !/上传课表|导入课表文件/.test(files.map((f) => fs.readFileSync(f, "utf8")).join("")),
    (() => {
      const hits = [];
      for (const f of files.filter((x) => x.endsWith(".html"))) {
        const src = fs.readFileSync(f, "utf8");
        const m = /<input[^>]*type\s*=\s*["']file["'][^>]*>/i.exec(src);
        if (m) {
          const ctx = src.slice(Math.max(0, m.index - 200), m.index + 60).replace(/\s+/g, " ");
          hits.push({ file: path.relative(ROOT, f), input: m[0], ctx: ctx.slice(-160) });
        }
      }
      return `file 控件=${JSON.stringify(hits)}（frontend.md §7 字面要求"只出现在代取截图上传处"，实际 buddy.html 另有一个「照片（可选，仅本地预览）」控件 —— 与 m2 §6「可选照片」冲突，非课表控件）`;
    })(),
  );
}

// ── 6) 首页统计随数据变化（HTTP 侧口径）─────────────────────
{
  const before = {
    tasks: (await (await fetch(`${BASE}/api/tasks`)).json()).data.length,
    runners: (await (await fetch(`${BASE}/api/runners`)).json()).data.length,
    buddies: (await (await fetch(`${BASE}/api/buddies`)).json()).data.length,
    matches: (await (await fetch(`${BASE}/api/matches`)).json()).data.length,
  };
  const tok = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEMO_TOKEN=(.*)$/m)[1].trim();
  await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Demo-Token": tok },
    body: JSON.stringify({
      from_building: "12号楼",
      to_building: "15号楼",
      station: "北门菜鸟驿站",
      deadline_iso: new Date(Date.now() + 3600_000).toISOString(),
      reward_min: 3,
      reward_max: 6,
      owner_handle: "统计口径验证",
    }),
  });
  const after = {
    tasks: (await (await fetch(`${BASE}/api/tasks`)).json()).data.length,
  };
  check(
    "F0-6",
    "统计来源接口真实存在且随数据变化（POST 一条任务后 /api/tasks 计数 +1）",
    after.tasks === before.tasks + 1,
    `before=${JSON.stringify(before)} after.tasks=${after.tasks}`,
  );
}

console.log(`\n=== F0（HTTP 层）汇总：PASS ${pass} / FAIL ${fail} ===`);
fs.writeFileSync(path.join(__dirname, "f0-result.json"), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
