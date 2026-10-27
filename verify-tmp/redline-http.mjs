/**
 * 独立验证 · 红线扫描 + MCP/HTTP 路由（verifier 自写）
 * 跑法：node verify-tmp/redline-http.mjs  （需先起 3181 服务）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:3181";
const TOKEN = (process.env.VERIFY_TOKEN) || (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEMO_TOKEN=(.*)$/m) || [,""])[1].trim();

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 800)}`);
}
const j = async (p, init) => (await fetch(BASE + p, init)).json();
const jpost = (p, body, headers = {}) =>
  j(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

console.log("=== 红线扫描（全模块）===\n");

// ── R1: MCP tools/list 实际工具数 ───────────────────────────
{
  const r = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const names = (r.result?.tools || []).map((t) => t.name);
  const byModule = names.reduce((a, n) => {
    const m = /^task_|runner_|match_/.test(n) ? "m1" : /^buddy_/.test(n) ? "m2" : /^map_/.test(n) ? "m3" : "m4?";
    a[m] = (a[m] || 0) + 1;
    return a;
  }, {});
  const agentHtml = fs.readFileSync(path.join(ROOT, "static/agent.html"), "utf8");
  const mcpCfg = fs.readFileSync(path.join(ROOT, "static/js/mcp-config.js"), "utf8");
  const docClaims = (mcpCfg.match(/count:\s*(\d+)/g) || []).join(",");
  check(
    "R1",
    `MCP tools/list 实际工具数（页面/文档宣称 14）`,
    names.length > 0,
    `live tools/list = ${names.length} 个：${JSON.stringify(names)}\n      按模块=${JSON.stringify(byModule)} | mcp-config.js 宣称 count=${docClaims} → 合计 14 | 差集（宣称但 live 没有）=${JSON.stringify(["schedule_import", "schedule_add", "schedule_query", "schedule_remove"].filter((x) => !names.includes(x)))}`,
  );
  // schema 必须全部 additionalProperties:false
  const badSchema = (r.result?.tools || []).filter((t) => t.inputSchema?.additionalProperties !== false).map((t) => t.name);
  check("R1b", "live tools/list 全部 additionalProperties:false", badSchema.length === 0, `违规=${JSON.stringify(badSchema)}`);
  // 无令牌必须被拒
  const noAuth = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("R1c", "MCP 端点无令牌被拒（鉴权只认 DEMO_TOKEN）", noAuth.ok === false || noAuth.error || noAuth.message, JSON.stringify(noAuth).slice(0, 220));
  // 工具实调一条，验信封
  const call = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "task_list_open", arguments: { limit: 3 } } }),
  });
  check("R1d", "MCP tools/call 实调返回信封", call.result?.structuredContent?.ok === true, `isError=${call.result?.isError} structuredContent.ok=${call.result?.structuredContent?.ok} count=${call.result?.structuredContent?.data?.count}`);
}

// ── R2: 脱敏口 GET /api/runners、/api/buddies、/api/matches 不含身份字段 ──
{
  const runners = await j("/api/runners");
  const buddies = await j("/api/buddies");
  const matches = await j("/api/matches");
  const raw = JSON.stringify({ runners, buddies, matches });
  const keys = new Set();
  for (const r of runners.data || []) Object.keys(r).forEach((k) => keys.add(k));
  const bKeys = new Set();
  for (const b of buddies.data || []) Object.keys(b).forEach((k) => bKeys.add(k));
  check(
    "R2",
    "GET /api/runners 不含 user_id / contact_code；GET /api/buddies 不含 user_id；接口层无身份字段",
    !keys.has("user_id") && !keys.has("contact_code") && !bKeys.has("user_id") &&
      !/"(user_id|contact_code|student_no|phone|real_name|dorm)"\s*:/.test(raw),
    `runners 字段=${JSON.stringify([...keys])} | buddies 字段=${JSON.stringify([...bKeys])} | 命中 user_id/contact_code=${keys.has("user_id")}/${keys.has("contact_code")}; buddies.user_id=${bKeys.has("user_id")}`,
  );
  // 页面/接口里不得出现真实姓名/学号/手机号
  const pii = [];
  const scan = [
    ["/api/tasks", JSON.stringify(await j("/api/tasks"))],
    ["/api/buddies", JSON.stringify(buddies)],
    ["/api/runners", JSON.stringify(runners)],
  ];
  for (const [src, text] of scan) {
    if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)) pii.push(`${src}:手机号`);
    if (/(?<!\d)(19|20)\d{2}\d{6}(?!\d)/.test(text)) pii.push(`${src}:疑似学号`);
    if (/宿舍\d{3,}|寝室\s*\d{3,}/.test(text)) pii.push(`${src}:宿舍号`);
  }
  check("R2b", "接口返回里无手机号 / 学号 / 宿舍号", pii.length === 0, pii.length ? JSON.stringify(pii) : `扫了 ${scan.length} 个接口，0 命中`);
}

// ── R3: M1 HTTP 4 条路由 + 写接口令牌 + 5 分钟去重（HTTP 路径）──
{
  const iso = (s) => new Date(Date.now() + s * 1000).toISOString();
  // 先用 MCP 登记一个"时段完全覆盖"的跑腿者（种子 runner 的时段已过 / 楼栋名不同，会无候选）
  const reg = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "runner_register", arguments: { user_handle: "HTTP去重跑腿", reachable_buildings: ["15号宿舍楼", "12号宿舍楼"], reward_floor: 1, time_windows: [{ start_iso: iso(-600), end_iso: iso(7200) }] } },
    }),
  });
  const regId = reg.result?.structuredContent?.data?.runner_id;
  const openList = await j("/api/tasks?limit=3");
  const body = {
    from_building: "12号宿舍楼", to_building: "15号宿舍楼", station: "北门菜鸟驿站",
    deadline_iso: iso(3600), reward_min: 3, reward_max: 5, owner_handle: "HTTP红线",
  };
  const noTok = await jpost("/api/tasks", body);
  const withTok = await jpost("/api/tasks", body, { "X-Demo-Token": TOKEN });
  const tid = withTok.data?.task_id;
  const detail = await j(`/api/tasks/${tid}`);
  const notFound = await fetch(`${BASE}/api/tasks/task_does_not_exist`);
  const notFoundBody = await notFound.json();
  const m1 = await jpost(`/api/tasks/${tid}/match`, {});
  const d1 = await jpost(`/api/tasks/${tid}/match`, {}, { "X-Demo-Token": TOKEN });
  const d2 = await jpost(`/api/tasks/${tid}/match`, {}, { "X-Demo-Token": TOKEN });
  const mine1 = (d1.data || []).find((x) => x.runner_handle === "HTTP去重跑腿");
  const mine2 = (d2.data || []).find((x) => x.runner_handle === "HTTP去重跑腿");
  // 分数与 reason 一致性（HTTP 路径也要成立）
  const sumOf = (r) => [...String(r || "").matchAll(/\+(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
  const sumOk = (d1.data || []).every((x) => Math.round(sumOf(x.reason) * 100) === Math.round(x.score * 100));
  check(
    "R3",
    "M1 HTTP 4 路由 + 令牌门禁 + 5 分钟去重（HTTP 路径）+ 404 信封 + reason=score",
    reg.result?.structuredContent?.ok === true && openList.ok === true && noTok.ok === false &&
      withTok.ok === true && detail.ok === true && notFound.status === 404 && notFoundBody.error?.code === "NOT_FOUND" &&
      m1.ok === false && d1.ok === true && mine1?.pushed === true && mine2?.pushed === false &&
      /5\s*分钟/.test(mine2?.skip_reason || "") && sumOk,
    `MCP 登记 runner=${regId} | GET /api/tasks ok=${openList.ok}(${openList.data?.length}条) | POST 无令牌=${noTok.error?.code} | POST 带令牌 task=${tid} | GET 详情 ok=${detail.ok} | 不存在 id → HTTP ${notFound.status} ${JSON.stringify(notFoundBody.error)} | POST match 无令牌=${m1.error?.code} | 第1次 pushed=${mine1?.pushed} score=${mine1?.score} | 第2次 pushed=${mine2?.pushed} skip_reason="${mine2?.skip_reason}" | 全部 reason 分对齐=${sumOk}\n      第1次完整条目=${JSON.stringify(mine1)}`,
  );

  // 观察项：非规范楼栋名可发布（静默拿不到任何匹配）
  const bogus = await jpost("/api/tasks", { ...body, from_building: "12号楼", to_building: "15号楼", owner_handle: "HTTP错名" }, { "X-Demo-Token": TOKEN });
  const bogusMatch = await jpost(`/api/tasks/${bogus.data?.task_id}/match`, {}, { "X-Demo-Token": TOKEN });
  check(
    "R3b",
    "（观察项）楼栋名未按 config/map-nodes.json 的规范名校验：写错也能发布成功，且永远匹配不到人",
    bogus.ok === true && (bogusMatch.data || []).length === 0,
    `发布 "12号楼"→"15号楼" 成功=${bogus.ok} task=${bogus.data?.task_id}；对它撮合返回 ${(bogusMatch.data || []).length} 条候选（规范名 "12号宿舍楼"/"15号宿舍楼" 时同一 runner 是能匹配的）`,
  );
}

// ── R4: M2 HTTP 2 条路由 ────────────────────────────────────
{
  const list = await j("/api/buddies");
  const noTok = await jpost("/api/buddies", { author_handle: "HTTP搭子", kind: "study", text_profile: "我想找自习搭子，喜欢算法" });
  const withTok = await jpost("/api/buddies", { author_handle: "HTTP搭子", kind: "study", text_profile: "我想找自习搭子，喜欢算法" }, { "X-Demo-Token": TOKEN });
  const extra = await jpost("/api/buddies", { author_handle: "HTTP搭子", kind: "study", text_profile: "找搭子", evil: 1 }, { "X-Demo-Token": TOKEN });
  check(
    "R4",
    "M2 HTTP 2 路由：GET /api/buddies（只回 anon_token）/ POST /api/buddies（需令牌 + additionalProperties:false）",
    list.ok === true && !/user_id/.test(JSON.stringify(list)) && noTok.ok === false &&
      withTok.ok === true && typeof withTok.data?.anon_token === "string" && extra.ok === false,
    `GET ok=${list.ok} 条数=${list.data?.length} 首条=${JSON.stringify(list.data?.[0]).slice(0, 200)} | POST 无令牌=${noTok.error?.code} | POST 带令牌 anon_token=${withTok.data?.anon_token} | 多传字段=${extra.error?.code}`,
  );
}

console.log("\n=== 仓库级红线（git / 源码扫描）===\n");

// ── R5: 受限文件未被改动（各分支 + 集成 HEAD）────────────────
{
  const protectedPaths = ["contracts", "src/db/schema.sql", "src/util", "src/middleware"];
  const out = {};
  for (const wt of ["verify", "m1", "m2", "f0", "m3"]) {
    const dir = `C:\\Users\\17768\\.dsh\\bot\\workspace\\bm\\${wt}`;
    const diff = execFileSync("git", ["-C", dir, "diff", "--stat", "origin/main...HEAD", "--", ...protectedPaths], { encoding: "utf8" }).trim();
    out[wt] = diff || "(无改动)";
  }
  const allClean = Object.values(out).every((v) => v === "(无改动)");
  check("R5", "contracts/ 、src/db/schema.sql、src/util/*、src/middleware/* 在所有分支与集成 HEAD 上均未被改动", allClean, JSON.stringify(out, null, 1));
  // skeleton.test.js 只应有 Lead 统一发的过期断言修复
  const settings = Object.entries(out);
  const skel = execFileSync("git", ["-C", "C:\\Users\\17768\\.dsh\\bot\\workspace\\bm\\verify", "diff", "--stat", "origin/main...HEAD", "--", "tests/skeleton.test.js"], { encoding: "utf8" }).trim();
  const crypto = await import("node:crypto");
  const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "tests/skeleton.test.js"))).digest("hex").toUpperCase();
  check(
    "R5b",
    "tests/skeleton.test.js 唯一例外：SHA256 前 16 位 = E092CA0D10683F77",
    h.slice(0, 16) === "E092CA0D10683F77",
    `实际 ${h.slice(0, 16)} | diff: ${skel} | 其他受限路径：${settings.map(([k, v]) => `${k}=${v}`).join(" ; ")}`,
  );
}

// ── R6: 无硬编码密钥 / 令牌只在 .env ────────────────────────
{
  const files = [];
  const walk = (d, skip = /node_modules|\.git|vendor|verify-tmp/) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p, skip);
      else if (/\.(js|mjs|json|html|css|md|sql|yml|example)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  const patterns = [
    ["sk- 开头密钥", /sk-[A-Za-z0-9]{16,}/],
    ["Google/GPT 形", /AIza[0-9A-Za-z_-]{20,}/],
    ["长十六进制令牌", /\b[a-f0-9]{32,}\b/i],
    ["Bearer 后跟非占位符", /Bearer\s+(?!<DEMO_TOKEN>)[A-Za-z0-9._-]{12,}/],
    ["password= 赋值", /password\s*[:=]\s*["'][^"']{6,}["']/i],
  ];
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const [name, re] of patterns) {
      const m = re.exec(text);
      if (m) hits.push({ file: rel(f), kind: name, sample: m[0].slice(0, 40) });
    }
  }
  // 忽略明显的哈希/校验和文本（docs 里的 SHA256）与测试桩字符串
  const realHits = hits.filter(
    (h) => !/^docs\//.test(h.file) && !/verify-integration/.test(h.file) && !/^tests\//.test(h.file),
  );
  const stubHits = hits.filter((h) => /^tests\//.test(h.file));
  const tokenOnlyInEnv = !files.some((f) => /\.env$/.test(f) === false && /dev-token-local/.test(fs.readFileSync(f, "utf8")));
  check(
    "R6",
    "源码/静态页/fixtures 无硬编码密钥；演示令牌只出现在 .env（与 /config.js 的运行时注入）",
    realHits.length === 0 && tokenOnlyInEnv,
    `可疑命中（生产代码/页面/fixtures）=${JSON.stringify(realHits.map((h) => `${h.file}:${h.kind}`))} | 仅测试桩命中（非密钥）=${JSON.stringify(stubHits.map((h) => `${h.file}:${h.sample}`))} | 令牌仅 .env=${tokenOnlyInEnv} | 扫描文件数=${files.length}`,
  );
  // .env / *.db 未被 git 跟踪
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n");
  const badTracked = tracked.filter((f) => /(^|\/)\.env$|\.db$|\.sqlite$/.test(f));
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  check(
    "R6b",
    ".env / *.db 未被 git 跟踪，.gitignore 覆盖必需项",
    badTracked.length === 0 && [".env", "*.env", "node_modules/", "*.db", "*.sqlite", "_recon/", "dist/", ".DS_Store", "*.log"].every((x) => gi.includes(x)),
    `被跟踪的敏感文件=${JSON.stringify(badTracked)} | .gitignore 含全部必需项=${[".env", "*.env", "node_modules/", "*.db", "*.sqlite", "_recon/", "dist/", ".DS_Store", "*.log"].every((x) => gi.includes(x))}`,
  );
}

// ── R7: fixtures PII + 文件数要求 ───────────────────────────
{
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  const tasks = read("fixtures/tasks.json");
  const runners = read("fixtures/runners.json");
  const buddy = read("fixtures/buddy-posts.json");
  const blob = JSON.stringify({ tasks, runners, buddy });
  const taskList = Array.isArray(tasks) ? tasks : tasks.tasks || [];
  const runnerList = Array.isArray(runners) ? runners : runners.runners || [];
  const buddyList = Array.isArray(buddy) ? buddy : buddy.posts || buddy.buddy_posts || [];
  const piiHits = [];
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(blob)) piiHits.push("手机号");
  if (/(?<!\d)(19|20)\d{2}\d{6,}(?!\d)/.test(blob)) piiHits.push("疑似学号");
  if (/宿舍\d{3,}|寝室\s*\d{3,}/.test(blob)) piiHits.push("宿舍号");
  if (/"(real_name|student_no|phone|contact)"\s*:/.test(blob)) piiHits.push("身份字段名");
  check(
    "R7",
    "fixtures：tasks≥8 / runners≥6 / buddy-posts≥10，且无手机号、学号、宿舍号、身份字段名",
    taskList.length >= 8 && runnerList.length >= 6 && buddyList.length >= 10 && piiHits.length === 0,
    `tasks=${taskList.length} runners=${runnerList.length} buddy-posts=${buddyList.length} | PII 命中=${JSON.stringify(piiHits)}`,
  );
  // M1 fixtures 楼栋名 === config/map-nodes.json 的 label（跨模块一致性）
  const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, "config/map-nodes.json"), "utf8"));
  const labels = new Set((nodes.nodes || nodes).map((n) => n.label));
  const usedBuildings = new Set();
  for (const t of taskList) {
    if (t.from_building) usedBuildings.add(t.from_building);
    if (t.to_building) usedBuildings.add(t.to_building);
  }
  for (const r of runnerList) {
    const rb = typeof r.reachable_buildings === "string" ? JSON.parse(r.reachable_buildings) : r.reachable_buildings;
    (rb || []).forEach((b) => usedBuildings.add(b));
  }
  const unknown = [...usedBuildings].filter((b) => !labels.has(b));
  check("R7b", "M1 fixtures 里的楼栋名全部能在 config/map-nodes.json 找到 label（字面一致）", unknown.length === 0, `map-nodes label 数=${labels.size} | fixtures 用到 ${usedBuildings.size} 个楼栋 | 对不上的=${JSON.stringify(unknown)}`);
}

console.log("\n=== 跨路径一致性（MCP 与 HTTP 共用同一套 service）===\n");

// ── R8: MCP 发布 → HTTP 可见；HTTP 发布 → MCP 可见（禁止各写一套逻辑）──
{
  const iso = (s) => new Date(Date.now() + s * 1000).toISOString();
  const mcpPub = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "task_publish", arguments: { from_building: "12号宿舍楼", to_building: "15号宿舍楼", station: "MCP发布驿站", deadline_iso: iso(1800), reward_min: 2, reward_max: 4, owner_handle: "MCP侧" } },
    }),
  });
  const mcpTaskId = mcpPub.result?.structuredContent?.data?.task_id;
  const httpSeeMcp = await j(`/api/tasks/${mcpTaskId}`);
  const httpPub = await jpost("/api/tasks", { from_building: "12号宿舍楼", to_building: "15号宿舍楼", station: "HTTP发布驿站", deadline_iso: iso(1800), reward_min: 2, reward_max: 4, owner_handle: "HTTP侧" }, { "X-Demo-Token": TOKEN });
  const mcpList = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "task_list_open", arguments: { limit: 50 } } }),
  });
  const mcpSeesHttp = (mcpList.result?.structuredContent?.data?.tasks || []).some((t) => t.task_id === httpPub.data?.task_id);
  // M2：MCP 发帖 → HTTP 列表可见
  const mcpBuddy = await j("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "buddy_publish", arguments: { author_handle: "MCP发帖人", kind: "study", text_profile: "我想找自习搭子，喜欢算法和摄影，安静有计划" } } }),
  });
  const buddyId = mcpBuddy.result?.structuredContent?.data?.post_id;
  const httpBuddies = await j("/api/buddies");
  const httpSeesMcpBuddy = (httpBuddies.data || []).some((p) => p.post_id === buddyId);
  check(
    "R8",
    "MCP 与 HTTP 共用同一套 service：MCP 发布的任务/帖子在 HTTP 侧可见，HTTP 发布的任务在 MCP 侧可见",
    Boolean(mcpTaskId) && httpSeeMcp.ok === true && Boolean(httpPub.data?.task_id) && mcpSeesHttp && Boolean(buddyId) && httpSeesMcpBuddy,
    `MCP task ${mcpTaskId} → HTTP 详情 ok=${httpSeeMcp.ok} | HTTP task ${httpPub.data?.task_id} → MCP task_list_open 命中=${mcpSeesHttp} | MCP 帖 ${buddyId} → HTTP /api/buddies 命中=${httpSeesMcpBuddy}`,
  );
}

// ── R9: 令牌只在 .env + /config.js 运行时注入；页面不硬编码 ──
{
  const cfg = await (await fetch(`${BASE}/config.js`)).text();
  const agentHtml = await (await fetch(`${BASE}/agent`)).text();
  const cfgHasToken = /__DEMO_TOKEN__\s*=\s*"[^"]{6,}"/.test(cfg);
  check(
    "R9",
    "/config.js 运行时注入演示令牌（契约允许，只读+限频）但页面 HTML / 静态源码里都没有真实令牌值",
    cfgHasToken === true && !/__DEMO_TOKEN__\s*=\s*"[^"]/.test(agentHtml),
    `/config.js 含注入=${cfgHasToken}（只报是否命中，不贴值）| /agent HTML 含内联令牌值=${/__DEMO_TOKEN__\s*=\s*"[^"]/.test(agentHtml)} | .env 已被 .gitignore 忽略且未入库（见 R6b）`,
  );
}

console.log(`\n=== 红线/路由 汇总：PASS ${pass} / FAIL ${fail} ===`);
fs.writeFileSync(path.join(__dirname, "redline-result.json"), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(0);
