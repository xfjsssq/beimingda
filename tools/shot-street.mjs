import fs from "node:fs";
const base = process.argv[2];
const outDir = process.argv[3];
const v = await (await fetch("http://127.0.0.1:9223/json/version")).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", () => j(new Error("ws"))); });
let seq = 0; const pending = new Map(); const bad = []; const errs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) bad.push(m.params.response.url.replace(base, "") + " " + m.params.response.status);
  if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params.exceptionDetails.text || "").slice(0, 120));
});
const send = (method, params = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;
const shot = async (sid, name) => { const s = await send("Page.captureScreenshot", { format: "png" }, sid); fs.writeFileSync(`${outDir}/${name}`, Buffer.from(s.result.data, "base64")); };

const t = await send("Target.createTarget", { url: "about:blank" });
const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`, {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
await send("Page.navigate", { url: base + "/welcome?demo=1" }, sid);
await sleep(300);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
await send("Page.reload", {}, sid);
await sleep(3400);

const state1 = await ev(sid, `(() => ({
  markers: document.querySelectorAll('.marker').length,
  hud: !!document.getElementById('viewSeg'),
  scenes: Object.keys((window.__man) || {}).length,
  sw: document.documentElement.scrollWidth
}))()`);
await shot(sid, "01-map-hud-1440.png");
console.log("① 地图与 HUD:", JSON.stringify(state1));

// 打开 3D 街景
await ev(sid, `document.querySelector('#viewSeg [data-view="street"]').click()`);
await sleep(3500);
const state2 = await ev(sid, `(() => ({
  overlayOn: document.getElementById('panoOverlay').classList.contains('on'),
  fallbackHidden: document.getElementById('streetFallback').hidden,
  pick: [...document.querySelectorAll('#streetPick button')].map(b => b.textContent),
  title: document.getElementById('panoTitle').textContent,
  canvas: document.querySelectorAll('#pano canvas').length,
  imgs: document.querySelectorAll('#pano img').length,
  hotspots: document.querySelectorAll('.pnlm-hotspot').length
}))()`);
await shot(sid, "02-street-1440.png");
console.log("② 3D 街景:", JSON.stringify(state2));

// 切到第二个场景
await ev(sid, `[...document.querySelectorAll('#streetPick button')][1]?.click()`);
await sleep(3000);
const state3 = await ev(sid, `(() => ({ title: document.getElementById('panoTitle').textContent,
  pressed: [...document.querySelectorAll('#streetPick button')].map(b => b.getAttribute('aria-pressed')),
  hotspots: document.querySelectorAll('.pnlm-hotspot').length }))()`);
await shot(sid, "03-street-scene2-1440.png");
console.log("③ 切场景:", JSON.stringify(state3));

// 拖动一次（模拟环视）
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 700, y: 500, button: "left", clickCount: 1 }, sid);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1000, y: 500, button: "left" }, sid);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1000, y: 500, button: "left", clickCount: 1 }, sid);
await sleep(1200);
await shot(sid, "04-street-dragged-1440.png");

// 375 视口再看一眼
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, screenWidth: 375, screenHeight: 812 }, sid);
await sleep(1500);
const state4 = await ev(sid, `(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }))()`);
await shot(sid, "05-street-375.png");

console.log("④ 375:", JSON.stringify(state4));
console.log("httpErrors:", JSON.stringify([...new Set(bad)]));
console.log("pageExceptions:", JSON.stringify(errs));
await send("Target.closeTarget", { targetId: t.result.targetId });
ws.close();
