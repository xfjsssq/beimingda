/**
 * 独立验证 · F0 真机实测（Edge / CDP，375px 视口）—— verifier 自写
 * 走 Edge 通道（D:\Edge-Auto\profile + 9223），不用 Tabbit / AutoGLM。
 * 跑法：node verify-tmp/browser-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9223;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = process.env.VERIFY_SITE || "http://127.0.0.1:3181";

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 700)}`);
}

const version = await (await fetch(`${BASE}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", () => rej(new Error("ws 连不上")));
});
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) {
    events.push(m);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const i = ++seq;
    pending.set(i, res);
    const msg = { id: i, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });

const createSession = async () => {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const tid = t.result.targetId;
  const a = await send("Target.attachToTarget", { targetId: tid, flatten: true });
  const sid = a.result.sessionId;
  for (const d of ["Page", "Runtime", "Network", "Log", "DOM"]) await send(`${d}.enable`, {}, sid);
  return { tid, sid };
};

const evaluate = async (sid, expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text, value: null };
  return { value: r.result?.result?.value ?? null };
};

const closeSession = async (tid) => {
  try {
    await send("Target.closeTarget", { targetId: tid });
  } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一个页面（375px 手机视口），等 load 后返回该 session 的检查数据 */
async function visit(url, { emulatedWidth = 375, height = 812, settleMs = 1200 } = {}) {
  const { tid, sid } = await createSession();
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: emulatedWidth, height, deviceScaleFactor: 2, mobile: true },
    sid,
  );
  const t0 = events.length;
  await send("Page.navigate", { url }, sid);
  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i += 1) {
    await sleep(200);
    loaded = events.some((e) => e.method === "Page.loadEventFired" && e.sessionId === sid);
    if (!events.slice(t0).some((e) => e.method === "Page.loadEventFired" && e.sessionId === sid) && i > 25) break;
  }
  await sleep(settleMs);
  const info = await evaluate(
    sid,
    `(() => {
      const de = document.documentElement;
      const bad = [];
      const w = ${emulatedWidth};   // 设备宽度（不取 window.innerWidth：页面被撑破时 innerWidth 会被放大）
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1.5) {
          bad.push({ tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,40), right: Math.round(r.right), w: Math.round(r.width) });
          if (bad.length >= 8) break;
        }
      }
      const res = performance.getEntriesByType('resource').map((e) => e.name);
      return {
        title: document.title,
        status: document.readyState,
        innerWidth: w,
        scrollWidth: de.scrollWidth,
        bodyScrollWidth: document.body ? document.body.scrollWidth : null,
        overflowElements: bad,
        resources: res,
        text: (document.body ? document.body.innerText : '').slice(0, 300),
      };
    })()`,
  );
  const consoleErrs = events
    .slice(t0)
    .filter((e) => e.sessionId === sid)
    .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params?.entry?.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params?.type === "error"))
    .map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text || (e.params?.args || []).map((a) => a.value).join(" "));
  const badHttp = events
    .slice(t0)
    .filter((e) => e.sessionId === sid && e.method === "Network.responseReceived" && e.params.response.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url}`);
  return { tid, sid, info: info.value, err: info.error, consoleErrs, badHttp, eventsFrom: t0 };
}

const shot = async (sid, name) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sid);
  const p = path.join(__dirname, name);
  if (r.result?.data) fs.writeFileSync(p, Buffer.from(r.result.data, "base64"));
  return p;
};

console.log(`=== F0 真机实测（Edge ${version.Browser} / CDP / 375×812 / mobile）===\n`);

// ── 1) 五个存在的页面：375px 不破版 + 无外部资源 + 无 console 错误 ──
const pageList = [
  ["/", "index"],
  ["/takeout", "takeout"],
  ["/buddy", "buddy"],
  ["/welcome", "welcome"],
  ["/agent", "agent"],
];
const pageData = {};
for (const [url, name] of pageList) {
  const v = await visit(SITE + url);
  const external = (v.info?.resources || []).filter((u) => !u.startsWith(SITE) && !u.startsWith("data:") && !u.startsWith("blob:"));
  const pageHttpErr = v.badHttp.filter((x) => !/favicon\.ico|apple-touch-icon/.test(x));
  pageData[name] = { url, ...v.info, external, consoleErrs: v.consoleErrs, badHttp: v.badHttp };
  check(
    `BR-${name}`,
    `${url} 在 375px 下不破版（布局宽度=375、无溢出元素）、无外部资源、无 4xx 页面资源`,
    v.info && v.info.scrollWidth <= 375 + 1 && v.info.innerWidth === 375 &&
      (v.info.overflowElements || []).length === 0 && external.length === 0 &&
      pageHttpErr.length === 0 && v.consoleErrs.length === 0,
    `innerWidth=${v.info?.innerWidth} scrollWidth=${v.info?.scrollWidth} bodyScrollWidth=${v.info?.bodyScrollWidth}（>375 即为被撑破/缩放）溢出元素=${JSON.stringify(v.info?.overflowElements)} 外部资源=${JSON.stringify(external)} 4xx=${JSON.stringify(v.badHttp)} console错误=${JSON.stringify(v.consoleErrs)}`,
  );
  if (["index", "agent", "takeout", "buddy"].includes(name)) {
    pageData[name].shot = await shot(v.sid, `shot-375-${name}.png`);
  }
  await closeSession(v.tid);
}

// ── 2) ?demo=1 徽章 ─────────────────────────────────────────
for (const [url, name] of pageList) {
  const v = await visit(`${SITE}${url === "/" ? "/" : url}?demo=1`);
  const badge = await evaluate(
    v.sid,
    `(() => {
      const all = [...document.querySelectorAll('*')].filter((el) => /演示模式/.test(el.textContent || '') && el.children.length <= 2);
      const visible = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return { count: all.length, visible: visible.length, sample: visible[0] ? { tag: visible[0].tagName, cls: visible[0].className, text: (visible[0].textContent||'').trim().slice(0,30), rect: visible[0].getBoundingClientRect().toJSON() } : null };
    })()`,
  );
  const b = badge.value;
  pageData[name] = pageData[name] || {};
  pageData[name].demoBadge = b;
  const expectBadge = ["index", "agent", "welcome"].includes(name);
  check(
    `BR-demo-${name}`,
    `${url}?demo=1 → 演示模式徽章${expectBadge ? "（应有）" : "（本页未接 demo.js，记录现状）"}：count=${b?.count} visible=${b?.visible}`,
    expectBadge ? b && b.visible > 0 : true,
    `徽章元素数=${b?.count} 可见=${b?.visible} 样例=${JSON.stringify(b?.sample)}`,
  );
  await closeSession(v.tid);
}

// ── 3) /agent：页面上真实渲染出来的 JSON 能被 JSON.parse ────
{
  const v = await visit(`${SITE}/agent`);
  const got = await evaluate(
    v.sid,
    `(() => {
      const pre = document.getElementById('mcp-json');
      const url = document.getElementById('mcp-url');
      const btn = document.getElementById('copy-btn');
      const text = pre ? pre.textContent : null;
      let parsed = null, err = null;
      try { parsed = JSON.parse(text); } catch (e) { err = String(e.message); }
      const auth = parsed && parsed.mcpServers && parsed.mcpServers.beimingda && parsed.mcpServers.beimingda.headers && parsed.mcpServers.beimingda.headers.Authorization;
      return {
        hasPre: !!pre, hasBtn: !!btn, urlText: url ? url.textContent.trim() : null,
        raw: text, parseErr: err, parsed,
        auth, hasPlaceholder: /<DEMO_TOKEN>/.test(text || ''),
        realTokenLeak: text ? /dev-token-local/.test(text) : false,
        toolListRendered: [...document.querySelectorAll('*')].some((el) => /task_publish/.test(el.textContent||'')),
      };
    })()`,
  );
  const g = got.value;
  check(
    "BR-agent-json",
    "/agent 页面上渲染出来的 MCP 配置：页面内 JSON.parse 通过、含 <DEMO_TOKEN>、无真实令牌",
    g && g.hasPre && g.parseErr === null && g.auth === "Bearer <DEMO_TOKEN>" && g.hasPlaceholder === true && g.realTokenLeak === false,
    `JSON.parse=${g?.parseErr === null ? "通过" : g?.parseErr} | Authorization=${g?.auth} | url=${g?.urlText} | 真实令牌泄漏=${g?.realTokenLeak} | 原样文本=${JSON.stringify(g?.raw)}`,
  );
  // 点击复制按钮，看反馈（clipboard 在无头下可能被拒 → 看是否有「已复制」或选中退路）
  await evaluate(v.sid, `document.getElementById('copy-btn').click()`);
  await sleep(700);
  const fb = await evaluate(v.sid, `document.getElementById('copy-state') ? document.getElementById('copy-state').textContent.trim() : null`);
  check(
    "BR-agent-copy",
    "/agent 复制按钮点击后有反馈（已复制 / 或退路提示）",
    Boolean(fb.value && fb.value.length > 0),
    `#copy-state = ${JSON.stringify(fb.value)}`,
  );
  pageData.agent.shot2 = await shot(v.sid, "shot-375-agent-copied.png");
  await closeSession(v.tid);
}

// ── 4) 首页统计真的走 API 并随数据变化 ──────────────────────
{
  const v = await visit(`${SITE}/`);
  const read = async () =>
    (await evaluate(
      v.sid,
      `(() => {
        const pick = (id) => { const b = document.getElementById(id); const v = b && b.querySelector('.stat__value'); const s = b && b.querySelector('.stat__src'); return v ? { value: v.textContent.trim(), src: s ? s.textContent.trim() : '' } : null; };
        return { tasks: pick('stat-tasks'), runners: pick('stat-runners'), buddies: pick('stat-buddies'), score: pick('stat-score') };
      })()`,
    )).value;
  const before = await read();
  const tok = "dev-token-local";
  await fetch(`${SITE}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Demo-Token": tok },
    body: JSON.stringify({
      from_building: "12号楼",
      to_building: "15号楼",
      station: "北门菜鸟驿站",
      deadline_iso: new Date(Date.now() + 3600_000).toISOString(),
      reward_min: 3,
      reward_max: 6,
      owner_handle: "浏览器实测",
    }),
  });
  await evaluate(v.sid, `document.getElementById('refresh-stats').click()`);
  await sleep(2500);
  const after = await read();
  const num = (s) => parseInt(String(s ?? "").replace(/[^\d.-]/g, ""), 10);
  check(
    "BR-stats",
    "首页 4 个统计走真实 API：新发一条任务后刷新，开放任务数 +1（数字来自接口而非写死）",
    num(after?.tasks?.value) === num(before?.tasks?.value) + 1 &&
      /来源 \/api\//.test(after?.tasks?.src || "") && /来源 \/api\//.test(after?.runners?.src || ""),
    `before=${JSON.stringify(before)} | after=${JSON.stringify(after)} | 解析后 ${num(before?.tasks?.value)} → ${num(after?.tasks?.value)}`,
  );
  await closeSession(v.tid);
}

// ── 5) /schedule 现状（M4 未合入）──────────────────────────
{
  const v = await visit(`${SITE}/schedule`);
  check(
    "BR-schedule",
    "/schedule 现状记录（导航与首页都有该链接）",
    Boolean(v.info),
    `title=${JSON.stringify(v.info?.title)} 正文前 200 字=${JSON.stringify((v.info?.text || "").slice(0, 200))}`,
  );
  await closeSession(v.tid);
}

console.log(`\n=== 真机实测汇总：PASS ${pass} / FAIL ${fail} ===`);
console.log("截图：", Object.entries(pageData).map(([k, v]) => `${k}:${v.shot || v.shot2 || "-"}`).join("  "));
fs.writeFileSync(path.join(__dirname, "browser-result.json"), JSON.stringify({ pass, fail, results, pageData }, null, 2));
ws.close();
process.exit(fail === 0 ? 0 : 1);
