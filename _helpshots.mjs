
import fs from "node:fs";
const base = process.argv[2], plan = JSON.parse(process.argv[3]), out = process.argv[4];
const v = await (await fetch("http://127.0.0.1:9223/json/version")).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", () => j(new Error("ws"))); });
let seq = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await send("Target.createTarget", { url: "about:blank" });
const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
for (const d of ["Page","Runtime"]) await send(d + ".enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
let cur = "";
for (const item of plan) {
  if (cur !== item.path) { await send("Page.navigate", { url: base + item.path }, sid); await sleep(4300); cur = item.path; }
  await send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, sid); await sleep(500);
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
  if (s?.result?.data) fs.writeFileSync(`${out}/${item.name}.png`, Buffer.from(s.result.data, "base64"));
}
console.log("shots ok");
await send("Target.closeTarget", { targetId: t.result.targetId });
ws.close();
