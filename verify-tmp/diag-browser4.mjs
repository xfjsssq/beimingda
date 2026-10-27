/** 找出 takeout 在 375px 下把布局撑到 459px 的元凶（verifier 诊断 4） */
const version = await (await fetch("http://127.0.0.1:9223/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
const send = (method, params = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;

for (const [label, url] of [["takeout", "http://127.0.0.1:3181/takeout"], ["buddy", "http://127.0.0.1:3181/buddy"], ["agent", "http://127.0.0.1:3181/agent"], ["welcome", "http://127.0.0.1:3181/welcome"]]) {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`, {}, sid);
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, screenWidth: 375, screenHeight: 812 }, sid);
  await send("Page.navigate", { url }, sid);
  await sleep(2500);
  const r = await ev(sid, `(() => {
    const de = document.documentElement;
    const all = [...document.querySelectorAll('body *')].map((el) => {
      const b = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), id: el.id || '', cls: (el.className || '').toString().slice(0, 44),
        w: Math.round(b.width), right: Math.round(b.right),
        sw: el.scrollWidth, cw: el.clientWidth,
        ox: getComputedStyle(el).overflowX,
        text: (el.textContent || '').trim().slice(0, 30) };
    });
    const widest = [...all].sort((a, b) => b.w - a.w).slice(0, 6);
    const selfOverflow = all.filter((e) => e.sw > e.cw + 1).slice(0, 8);
    return JSON.stringify({ iw: innerWidth, docSw: de.scrollWidth, bodySw: document.body.scrollWidth, widest, selfOverflow });
  })()`);
  console.log(`==== ${label} @375 ====`);
  const j = JSON.parse(r);
  console.log(`  innerWidth=${j.iw} docScrollWidth=${j.docSw} bodyScrollWidth=${j.bodySw}`);
  console.log("  最宽的 6 个元素:");
  for (const w of j.widest) console.log("   ", JSON.stringify(w));
  console.log("  自身内容溢出的元素:", JSON.stringify(j.selfOverflow));
  await send("Target.closeTarget", { targetId: t.result.targetId });
}
ws.close();
process.exit(0);
