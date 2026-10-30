
import fs from "node:fs";
const base = process.argv[2], jobs = JSON.parse(process.argv[3]), out = process.argv[4];
const v = await (await fetch("http://127.0.0.1:9223/json/version")).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", () => j(new Error("ws"))); });
let seq = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (m, p = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;
const t = await send("Target.createTarget", { url: "about:blank" });
const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
for (const d of ["Page","Runtime"]) await send(d + ".enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
let cur = "";
for (const job of jobs) {
  const [name, path, sel] = job;
  if (cur !== path) { await send("Page.navigate", { url: base + path }, sid); await sleep(4200); cur = path; }
  const boxes = await ev(sid, `(() => { const sels = ${JSON.stringify(sel)}.split(",").map(s=>s.trim());
    return JSON.stringify(sels.map(s => { const el=document.querySelector(s); if(!el) return null; const r=el.getBoundingClientRect();
      return { x: Math.max(0,Math.round(r.left)), y: Math.max(0,Math.round(r.top)), w: Math.round(r.width), h: Math.round(r.height) }; })); })()`);
  fs.writeFileSync(`${out}/${name}.json`, boxes);
}
console.log("boxes ok");
await send("Target.closeTarget", { targetId: t.result.targetId });
ws.close();
