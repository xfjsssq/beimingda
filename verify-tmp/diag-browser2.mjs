/** 定位 takeout 在 375px 的溢出元素 + index 的 404 资源（verifier 诊断 2） */
const PORT = 9223;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "http://127.0.0.1:3181";
const version = await (await fetch(`${BASE}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++seq; pending.set(i, res); const msg = { id: i, method, params }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;

async function open(url, metrics) {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  for (const d of ["Page", "Runtime", "Network", "Log"]) await send(`${d}.enable`, {}, sid);
  if (metrics) await send("Emulation.setDeviceMetricsOverride", metrics, sid);
  const t0 = events.length;
  await send("Page.navigate", { url }, sid);
  await sleep(3500);
  return { tid: t.result.targetId, sid, t0 };
}

// ---- 1) index 的 404 是谁 ----
{
  const { tid, sid, t0 } = await open(`${SITE}/`, { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  const all = events.slice(t0).filter((e) => e.sessionId === sid && e.method === "Network.responseReceived")
    .map((e) => `${e.params.response.status} ${e.params.type} ${e.params.response.url}`);
  const failed = events.slice(t0).filter((e) => e.sessionId === sid && e.method === "Network.loadingFailed").map((e) => `${e.params.errorText} ${e.params.blockedReason || ""}`);
  const logErrs = events.slice(t0).filter((e) => e.sessionId === sid && e.method === "Log.entryAdded").map((e) => `[${e.params.entry.level}/${e.params.entry.source}] ${e.params.entry.text} ${e.params.entry.url || ""}`);
  const consoleErrs = events.slice(t0).filter((e) => e.sessionId === sid && e.method === "Runtime.consoleAPICalled" && e.params.type === "error").map((e) => JSON.stringify((e.params.args || []).map((a) => a.value)));
  console.log("---- index 全部响应 ----"); console.log(all.join("\n"));
  console.log("---- index loadingFailed ----"); console.log(failed.join("\n") || "(无)");
  console.log("---- index Log.entryAdded ----"); console.log(logErrs.join("\n") || "(无)");
  console.log("---- index console.error ----"); console.log(consoleErrs.join("\n") || "(无)");
  await send("Target.closeTarget", { targetId: tid });
}

// ---- 2) takeout 溢出元素（mobile:false + width 375，让溢出真实暴露）----
for (const width of [375, 360, 320]) {
  const { tid, sid } = await open(`${SITE}/takeout`, { width, height: 812, deviceScaleFactor: 1, mobile: false });
  const r = await ev(sid, `(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > W + 1) {
        out.push({ tag: el.tagName.toLowerCase(), id: el.id||'', cls: (el.className||'').toString().slice(0,50), right: Math.round(b.right), width: Math.round(b.width), text: (el.textContent||'').trim().slice(0,40) });
      }
      if (out.length >= 12) break;
    }
    return JSON.stringify({ W, iw: innerWidth, sw: document.documentElement.scrollWidth, bodySw: document.body.scrollWidth, out });
  })()`);
  console.log(`---- takeout @clientWidth=${width} (mobile:false) ----`);
  console.log(r);
  await send("Target.closeTarget", { targetId: tid });
}
ws.close();
process.exit(0);
