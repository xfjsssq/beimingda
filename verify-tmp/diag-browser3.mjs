/** takeout 375px 溢出的精确量化 + favicon 404 复现（verifier 诊断 3） */
const PORT = 9223;
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
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

const t = await send("Target.createTarget", { url: "about:blank" });
const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`, {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
const t0 = events.length;
await send("Page.navigate", { url: "http://127.0.0.1:3181/takeout" }, sid);
await sleep(3000);
const r = await ev(sid, `(() => {
  const de = document.documentElement;
  const win = document.querySelector('#r-windows .win');
  const rows = document.querySelectorAll('#r-windows .win').length;
  const wb = win ? win.getBoundingClientRect() : null;
  const firstInputs = [...document.querySelectorAll('#r-windows .win input')].map((i) => ({ cls: i.className, w: Math.round(i.getBoundingClientRect().width), minContent: i.style.minWidth || getComputedStyle(i).minWidth }));
  return JSON.stringify({
    deviceWidth: 375,
    layoutInnerWidth: innerWidth,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    windowRows: rows,
    winRowWidth: wb ? Math.round(wb.width) : null,
    winRowRight: wb ? Math.round(wb.right) : null,
    inputs: firstInputs,
    visualScale: window.visualViewport ? Number((window.visualViewport.width / 375).toFixed(3)) : null,
  });
})()`);
console.log("takeout@375 mobile emulation:", r);
const reqs = events.slice(t0).filter((e) => e.sessionId === sid && (e.method === "Network.responseReceived" || e.method === "Network.requestWillBeSent"))
  .map((e) => e.method === "Network.responseReceived" ? `resp ${e.params.response.status} ${e.params.response.url}` : `req  ${e.params.request.url}`);
console.log("请求清单:");
console.log([...new Set(reqs)].join("\n"));
await send("Target.closeTarget", { targetId: t.result.targetId });
ws.close();
process.exit(0);
