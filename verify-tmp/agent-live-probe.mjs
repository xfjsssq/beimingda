/** /agent 页「实时核对 tools/list」是否真的显示 live 数量（verifier 自写） */
const PORT = 9223;
const SITE = process.env.VERIFY_SITE || "http://127.0.0.1:3185";
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;

const t = await send("Target.createTarget", { url: "about:blank" });
const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
await send("Page.navigate", { url: `${SITE}/agent` }, sid);
await sleep(4000);
const out = await ev(sid, `(() => {
  const body = document.body.innerText || '';
  const m = body.match(/实时核对[^\\n]{0,80}/);
  const probes = [...document.querySelectorAll('*')].filter((el) => /实时核对/.test(el.textContent || '') && el.children.length <= 3).map((el) => (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0, 120));
  return JSON.stringify({ matched: m ? m[0] : null, probes, hasTen: /返回\\s*10|10\\s*个/.test(body), toolNamesShown: /task_publish/.test(body) && /schedule_import/.test(body) });
})()`);
console.log(JSON.stringify(JSON.parse(out), null, 1));
await send("Target.closeTarget", { targetId: t.result.targetId });
ws.close();
process.exit(0);
