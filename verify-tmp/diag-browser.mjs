/** 找出页面加载时 404 的具体 URL + takeout 真实溢出（verifier 诊断） */
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

async function probe(url, width) {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`, {}, sid);
  if (width) await send("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
  const t0 = events.length;
  await send("Page.navigate", { url }, sid);
  await sleep(3000);
  const bad = events.slice(t0).filter((e) => e.sessionId === sid && e.method === "Network.responseReceived" && e.params.response.status >= 400)
    .map((e) => ({ status: e.params.response.status, url: e.params.response.url, type: e.params.type }));
  const vp = await send("Runtime.evaluate", { expression: `JSON.stringify({iw: innerWidth, vv: (document.querySelector('meta[name=viewport]')||{}).content||null, sw: document.documentElement.scrollWidth, ua: navigator.userAgent.slice(0,80)})`, returnByValue: true }, sid);
  await send("Target.closeTarget", { targetId: t.result.targetId });
  return { bad, info: JSON.parse(vp.result.result.value) };
}

for (const [label, url, w] of [["index@375", `${SITE}/`, 375], ["takeout@375", `${SITE}/takeout`, 375], ["takeout@native", `${SITE}/takeout`, null], ["buddy@375", `${SITE}/buddy`, 375], ["agent@375", `${SITE}/agent`, 375]]) {
  const r = await probe(url, w);
  console.log(`---- ${label} ----`);
  console.log("  info :", JSON.stringify(r.info));
  console.log("  >=400:", JSON.stringify(r.bad));
}
ws.close();
process.exit(0);
