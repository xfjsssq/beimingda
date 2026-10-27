/**
 * 独立验证 · /agent 真实剪贴板 + 导航「即将上线」降级行为（verifier 自写）
 * 跑法：VERIFY_SITE=http://127.0.0.1:3185 node verify-tmp/nav-clipboard.mjs
 */
const PORT = 9223;
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const SITE = process.env.VERIFY_SITE || "http://127.0.0.1:3181";
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
const send = (method, params = {}, sid) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (sid, expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sid)).result?.result?.value;

let pass = 0, fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 700)}`);
}

async function open(url) {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const sid = (await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`, {}, sid);
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
  await send("Page.navigate", { url }, sid);
  await sleep(2500);
  return { tid: t.result.targetId, sid };
}

// 允许剪贴板权限（浏览器级）
await send("Browser.grantPermissions", { origin: SITE, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

// ── 1) /agent 复制按钮 → 真的写进剪贴板，且粘出来是合法 JSON ──
{
  const { tid, sid } = await open(`${SITE}/agent`);
  await ev(sid, `document.getElementById('copy-btn').click()`);
  await sleep(900);
  const res = await ev(sid, `(async () => {
    const pre = document.getElementById('mcp-json');
    const shown = pre ? pre.textContent : null;
    let clip = null, clipErr = null;
    try { clip = await navigator.clipboard.readText(); } catch (e) { clipErr = String(e.message); }
    let parseErr = null;
    try { JSON.parse(clip); } catch (e) { parseErr = String(e.message); }
    const state = document.getElementById('copy-state');
    return JSON.stringify({
      shownHead: (shown || '').slice(0, 60), clipHead: (clip || '').slice(0, 60),
      clipLen: (clip || '').length, shownLen: (shown || '').length,
      sameAsShown: String(clip).split(String.fromCharCode(13)).join("") === String(shown).split(String.fromCharCode(13)).join(""), rawEqual: clip === shown, parseErr, clipErr,
      hasPlaceholder: /<DEMO_TOKEN>/.test(clip || ''),
      copyState: state ? state.textContent.trim() : null,
      parsed: (() => { try { return JSON.parse(clip); } catch { return null; } })(),
    });
  })()`);
  const r = JSON.parse(res);
  check(
    "CB-1",
    "/agent 点复制 → 剪贴板内容确实写入，且与页面展示一致、`JSON.parse` 通过、含 <DEMO_TOKEN>",
    r.clipErr === null && r.parseErr === null && r.sameAsShown === true && r.hasPlaceholder === true,
    `readText 错误=${r.clipErr} | 剪贴板长度=${r.clipLen} 页面长度=${r.shownLen} 一致(忽略 CRLF)=${r.sameAsShown} | JSON.parse=${r.parseErr === null ? "通过" : r.parseErr} | 内容=${JSON.stringify(r.clipHead)}… | 解析结果=${JSON.stringify(r.parsed)} | copy-state="${r.copyState}"`,
  );
  await send("Target.closeTarget", { targetId: tid });
}

// ── 2) 导航与首页对 /schedule 的「即将上线」降级 ─────────────
{
  const { tid, sid } = await open(`${SITE}/`);
  const navInfo = await ev(sid, `(() => {
    const links = [...document.querySelectorAll('a[data-nav], .site-nav a, nav a')].map((a) => ({
      text: (a.textContent || '').trim().replace(/\\s+/g, ' '),
      href: a.getAttribute('href'),
      dataNav: a.getAttribute('data-nav'),
      ariaDisabled: a.getAttribute('aria-disabled'),
      cls: a.className,
      title: a.getAttribute('title'),
    }));
    const cards = [...document.querySelectorAll('a,button')].filter((el) => /日程/.test(el.textContent || '')).map((el) => ({
      tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      href: el.getAttribute('href'), ariaDisabled: el.getAttribute('aria-disabled'),
      cls: el.className, title: el.getAttribute('title'),
    }));
    const ss = Object.keys(sessionStorage).filter((k) => /page|ready|avail|schedule|probe/i.test(k)).map((k) => [k, String(sessionStorage.getItem(k)).slice(0, 80)]);
    return JSON.stringify({ nav: links, scheduleCards: cards, sessionStorageKeys: ss });
  })()`);
  const n = JSON.parse(navInfo);
  const scheduleNav = (n.nav || []).filter((x) => /日程/.test(x.text));
  const scheduleCard = n.scheduleCards || [];
  const navDegraded = scheduleNav.some((x) => /即将上线/.test(x.text) || x.ariaDisabled === "true" || /soon|pending|disabled/.test(x.cls || ""));
  const cardDegraded = scheduleCard.some((x) => /即将上线/.test(x.text) || x.ariaDisabled === "true" || /soon|pending|disabled/.test(x.cls || ""));
  check(
    "NAV-1",
    "首页：导航「日程」与四卡片里的「日程提醒」都降级为「即将上线」，不再直接跳 404",
    navDegraded && cardDegraded,
    `导航里的日程项=${JSON.stringify(scheduleNav)} | 含日程的卡片/按钮=${JSON.stringify(scheduleCard)} | sessionStorage 探测缓存=${JSON.stringify(n.sessionStorageKeys)}`,
  );
  // 点一下那张卡片，看是否真的不跳 404
  const clicked = await ev(sid, `(() => {
    const el = [...document.querySelectorAll('a,button')].find((x) => /日程/.test(x.textContent || '') && /card|btn/.test(x.className || ''));
    if (!el) return 'not-found';
    el.click();
    return el.tagName.toLowerCase() + '|' + (el.getAttribute('href') || 'no-href') + '|aria-disabled=' + el.getAttribute('aria-disabled');
  })()`);
  await sleep(1500);
  const afterClick = await ev(sid, `location.pathname + ' | ' + document.title`);
  check(
    "NAV-2",
    "点首页「日程提醒」卡片：不会跳到 404 页（停在首页或弹提示）",
    !/\/schedule/.test(String(afterClick)),
    `被点元素=${clicked} | 点击后 URL=${JSON.stringify(afterClick)}`,
  );
  await send("Target.closeTarget", { targetId: tid });
}

// ── 3) /agent 页导航同样降级 ────────────────────────────────
{
  const { tid, sid } = await open(`${SITE}/agent`);
  const info = await ev(sid, `(() => {
    const nav = [...document.querySelectorAll('.site-nav a, nav a')].map((a) => ({ text: (a.textContent||'').trim().replace(/\\s+/g,' '), href: a.getAttribute('href'), ariaDisabled: a.getAttribute('aria-disabled'), cls: a.className }));
    return JSON.stringify(nav);
  })()`);
  const nav = JSON.parse(info);
  const sch = nav.filter((x) => /日程/.test(x.text));
  check(
    "NAV-3",
    "/agent 页（评委核心页）导航同样把「日程」降级为「即将上线」",
    sch.some((x) => /即将上线/.test(x.text) || x.ariaDisabled === "true" || /soon|pending|disabled/.test(x.cls || "")),
    `完整导航=${JSON.stringify(nav)}`,
  );
  await send("Target.closeTarget", { targetId: tid });
}

console.log(`\n=== 剪贴板/导航 汇总：PASS ${pass} / FAIL ${fail} ===`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
