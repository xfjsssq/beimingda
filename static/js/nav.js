/* =============================================================================
   北名大小助手 · 共用导航  static/js/nav.js
   契约：contracts/frontend.md §1（冻版 6 页）、§7（6 页可访问、无 404）

   行为：
     - 生成 / 复用页头导航，6 页链接：/ · /takeout · /buddy · /welcome · /schedule · /agent
     - 当前页高亮（aria-current="page" + 视觉样式）
     - ≤768px 由 CSS 收成「底部 tab bar」（无需 JS 判断，见 static/css/app.css 第 12 节）
     - ⛔ 只发 HEAD 做存在性探测、不看响应体：**不拉取其他页面内容**
     - **优雅降级**：目标页还没合进来（HTTP 404）时，入口渲染成弱化 +「即将上线」，
       真地址从 href 摘到 data-soon-href，点击给一句提示而**不会吃 404**；
       模块合并后探测到 200 自动恢复成普通链接，**无需改代码**
     - ⛔ 无外部依赖、无 CDN，断网可跑

   用法：
     import { mountNav } from "/js/nav.js";
     mountNav();                       // 自动插入到 body 开头（若页面已有页头则原地填充）
                                       // 内部异步做一次页面存在性探测并自动降级
     // 想让别的入口共享同一套判断（例如首页「进入日程表」）：
     //   <a class="btn" href="/schedule" data-page-check="/schedule">进入日程表</a>
     // 探测结果按 sessionStorage 缓存，同一会话只探一次（5 分钟 TTL，模块合入后自愈）
   ============================================================================= */

/** 冻版 6 页（顺序即导航顺序） */
export const PAGES = [
  { id: "index", href: "/", label: "首页", icon: "🏠", iconName: "home", desc: "功能聚合门户" },
  { id: "takeout", href: "/takeout", label: "代取", icon: "📦", iconName: "package", desc: "代取撮合看板" },
  { id: "buddy", href: "/buddy", label: "搭子", icon: "🤝", iconName: "users", desc: "搭子墙" },
  { id: "welcome", href: "/welcome", label: "导览", icon: "🗺️", iconName: "map-pin", desc: "迎新地图与全景" },
  { id: "schedule", href: "/schedule", label: "日程", icon: "⏰", iconName: "calendar-event", desc: "课表与提醒" },
  { id: "agent", href: "/agent", label: "Agent", icon: "🔌", iconName: "plug-connected", desc: "接入 WorkBuddy（评委页）" },
];

/** 导航就绪事件（demo.js 等模块可监听，避免执行顺序耦合） */
export const NAV_READY_EVENT = "bm:nav-ready";

/** 页面还没合进来时，入口上显示的字样 */
export const SOON_TEXT = "即将上线";

/** 探测结果的会话缓存键 */
const AVAIL_KEY = "bm.nav.availability";

/** 单个 HEAD 探测超时（毫秒）—— 探测不该拖慢页面 */
const PROBE_TIMEOUT_MS = 3000;

/** 缓存有效期：到期后下次加载重探，模块合入后无需新开标签页 */
const AVAIL_TTL_MS = 5 * 60 * 1000;

/**
 * 当前页面 id（用于高亮）。容忍 "/", "", "/index", "/agent", "/agent.html" 等写法。
 * @param {string} [pathname]
 * @returns {string} 未匹配到任何页面时返回 ""
 */
export function currentPageId(pathname) {
  const p = String(pathname === undefined && typeof location !== "undefined" ? location.pathname : pathname || "");
  const seg = p
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop();
  if (!seg || seg === "index" || seg === "index.html") return "index";
  const id = seg.replace(/\.html$/i, "");
  return PAGES.some((page) => page.id === id) ? id : "";
}

/* ---------------------------------------------------------------------------
   一、页面存在性探测（只发 HEAD，只看状态码，不读响应体）
   --------------------------------------------------------------------------- */

/**
 * 状态码 → 结论。
 *   ok      ：页面在（200~399）→ 正常链接
 *   soon    ：404 / 410 / 501 → 弱化 +「即将上线」
 *   unknown ：网络失败 / 超时 / 5xx / 401 等 → **不下结论**，保持正常链接
 *             （绝不因为一次探测失败就把入口降级）
 * @param {number|null|undefined} status
 * @returns {"ok"|"soon"|"unknown"}
 */
export function classifyStatus(status) {
  if (!status || typeof status !== "number") return "unknown";
  if (status === 404 || status === 410 || status === 501) return "soon";
  if (status >= 200 && status < 400) return "ok";
  return "unknown";
}

function readCache() {
  try {
    return JSON.parse(sessionStorage.getItem(AVAIL_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeCache(obj) {
  try {
    sessionStorage.setItem(AVAIL_KEY, JSON.stringify(obj));
  } catch {
    /* 隐私模式：降级成"每次加载探一次"，不影响功能 */
  }
}

/**
 * 单个探针：HEAD 请求，只看状态码，⛔ 不读 body（不拉整页内容）。
 * @returns {Promise<number|null>} 状态码；网络失败/超时 → null
 */
async function probeOne(href, { fetcher, timeoutMs }) {
  const f = fetcher || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return null;

  const init = { method: "HEAD", cache: "no-store", redirect: "follow", credentials: "same-origin" };
  let timer = null;
  if (typeof AbortController !== "undefined") {
    const ctrl = new AbortController();
    init.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  try {
    const res = await f(href, init);
    return res && typeof res.status === "number" ? res.status : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 批量探测页面是否已上线（带会话缓存）。
 * @param {string[]} paths
 * @param {{fetcher?:Function, timeoutMs?:number, force?:boolean}} [opts]
 *        fetcher 可注入（便于单测）；force=true 忽略缓存重探
 * @returns {Promise<Record<string, "ok"|"soon"|"unknown">>}
 */
export async function probePages(paths, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  const now = Date.now();
  const cache = readCache();
  const out = {};
  const todo = [];

  for (const href of [...new Set((paths || []).filter(Boolean))]) {
    const hit = cache[href];
    if (!opts.force && hit && now - (hit.at || 0) < AVAIL_TTL_MS) {
      out[href] = hit.state;
      continue;
    }
    todo.push(href);
  }

  await Promise.all(
    todo.map(async (href) => {
      const status = await probeOne(href, { fetcher: opts.fetcher, timeoutMs });
      const state = classifyStatus(status);
      out[href] = state;
      // 只缓存「确定的结论」：unknown（超时/网络抖动）不落缓存，下次再试
      if (state !== "unknown") cache[href] = { state, status, at: now };
    }),
  );

  writeCache(cache);
  return out;
}

/** 同步读缓存结论（页面想在首帧就判断可用它） */
export function availabilitySync() {
  const now = Date.now();
  const cache = readCache();
  const out = {};
  for (const [href, hit] of Object.entries(cache)) {
    if (hit && now - (hit.at || 0) < AVAIL_TTL_MS) out[href] = hit.state;
  }
  return out;
}

/** 该页面是否确定还没上线（缓存结论为 soon） */
export function isPageDown(href) {
  return availabilitySync()[String(href)] === "soon";
}

/* ---------------------------------------------------------------------------
   二、弱化渲染 + 轻提示（不隐藏、也不是死链）
   --------------------------------------------------------------------------- */

/** 收集需要做存在性判断的元素：导航项 + 任何带 data-page-check 的按钮/链接 */
export function collectCheckTargets(root) {
  const scope = root && root.querySelectorAll ? root : typeof document !== "undefined" ? document : null;
  if (!scope) return [];
  const targets = [];
  scope.querySelectorAll("[data-page-check]").forEach((el) => {
    targets.push({ el, href: el.getAttribute("data-page-check") });
  });
  scope.querySelectorAll(".site-nav .nav-link[href], .site-nav .nav-link[data-soon-href]").forEach((el) => {
    targets.push({ el, href: el.getAttribute("href") || el.getAttribute("data-soon-href") });
  });
  return targets.filter((t) => t.href);
}

/**
 * 把入口标成「即将上线」：
 *   - 保留元素、不 display:none（评委仍能看到 6 个模块都在规划里）
 *   - 真地址从 href 摘到 data-soon-href → 点击**不会**产生 404
 *   - 点击 / 回车给一句轻提示，说明对应模块还没合入
 */
export function markSoon(el, href) {
  if (!el) return el;
  const labelEl = el.querySelector(".nav-link__label");
  const label = (labelEl ? labelEl.textContent : el.textContent || "").trim();

  el.classList.add("is-soon");
  el.setAttribute("aria-disabled", "true");
  el.setAttribute("data-soon-for", href);
  el.dataset.soonLabel = label;

  if (el.tagName === "A" && el.hasAttribute("href")) {
    el.setAttribute("data-soon-href", el.getAttribute("href")); // 记住真地址
    el.removeAttribute("href"); // 摘掉 href：既点不动，也不会真的吃 404
  }
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");

  if (!el.querySelector(".soon-tag")) {
    const tag = document.createElement("span");
    tag.className = "soon-tag";
    tag.textContent = SOON_TEXT;
    el.appendChild(tag);
  }

  const baseTitle = (el.getAttribute("title") || "").replace(/（[^）]*即将上线[^）]*）$/, "");
  el.setAttribute("title", `${baseTitle ? baseTitle + " " : ""}（${SOON_TEXT}：对应模块尚未合入）`);

  if (el.dataset.soonBound !== "1") {
    el.dataset.soonBound = "1";
    el.addEventListener("click", (e) => {
      if (!el.classList.contains("is-soon")) return; // 模块合入后会恢复成普通链接
      e.preventDefault();
      e.stopPropagation();
      notifySoon(el);
    });
    el.addEventListener("keydown", (e) => {
      if (!el.classList.contains("is-soon")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        notifySoon(el);
      }
    });
  }
  return el;
}

/** 恢复成普通入口（探测到 200 时调用；模块合入后自动生效） */
export function clearSoon(el) {
  if (!el || !el.classList.contains("is-soon")) return el;
  el.classList.remove("is-soon");
  el.removeAttribute("aria-disabled");
  el.removeAttribute("data-soon-for");
  const tag = el.querySelector(".soon-tag");
  if (tag) tag.remove();
  const real = el.getAttribute("data-soon-href");
  if (real && el.tagName === "A") {
    el.setAttribute("href", real);
    el.removeAttribute("data-soon-href");
  }
  return el;
}

/** 轻提示：一句话说明这个入口为什么点不动（2.6s 自动消失） */
export function notifySoon(el) {
  if (typeof document === "undefined") return;
  const label = (el && el.dataset && el.dataset.soonLabel) || "该功能";
  let tip = document.querySelector(".nav-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "nav-tip";
    tip.setAttribute("role", "status");
    tip.setAttribute("aria-live", "polite");
    document.body.appendChild(tip);
  }
  tip.textContent = `${label}${SOON_TEXT} —— 对应模块正在接入，先试试已经上线的功能吧`;
  tip.classList.add("on");
  clearTimeout(notifySoon._timer);
  notifySoon._timer = setTimeout(() => tip.classList.remove("on"), 2600);
}

/**
 * 对页面里所有入口做一次存在性探测并应用降级 / 恢复。
 * mountNav() 会自动调用它；内容区后加载完也可以再跑一次。
 * @returns {Promise<Record<string, "ok"|"soon"|"unknown">>}
 */
export async function decorateAvailability(opts = {}) {
  if (typeof document === "undefined") return {};
  const root = opts.root || document;
  const targets = collectCheckTargets(root);
  if (!targets.length) return {};
  const map = await probePages(
    targets.map((t) => t.href),
    opts,
  );
  for (const t of targets) {
    if (map[t.href] === "soon") markSoon(t.el, t.href);
    else clearSoon(t.el);
  }
  return map;
}

/* ---------------------------------------------------------------------------
   三、渲染
   --------------------------------------------------------------------------- */

/** 单个导航项 HTML */
function linkHTML(page, activeId) {
  const active = page.id === activeId;
  return (
    `<a class="nav-link" href="${page.href}" data-nav="${page.id}"` +
    ` title="${page.desc}"${active ? ' aria-current="page"' : ""}>` +
    `<span class="icon icon--18 nav-link__icon" aria-hidden="true" style="--icon:url(/vendor/phosphor/icons/${page.iconName || "home"}.svg)"></span>` +
    `<span class="nav-link__label">${page.label}</span>` +
    `</a>`
  );
}

/** 页头 HTML（含演示模式徽章占位；徽章显示由 body[data-demo="1"] 控制） */
export function navHTML(activeId) {
  return (
    `<div class="site-header__inner">
        <button class="nav-handle" id="navHandle" type="button" aria-expanded="false" aria-controls="siteNav" aria-label="展开导航栏"><span class="icon icon--18" aria-hidden="true" style="--icon:url(/vendor/phosphor/icons/caret-up.svg)"></span></button>` +
    `<a class="brand" href="/">` +
    `<img class="brand__logo" src="/img/school-logo.png" alt="北方民族大学校徽" width="28" height="25" />` +
    `<span class="brand__text">北名大小助手</span>` +
    `<span class="brand__tag">赛道 17</span>` +
    `</a>` +
    `<nav class="site-nav" aria-label="主导航">${PAGES.map((p) => linkHTML(p, activeId)).join("")}</nav>` +
    `<span class="demo-badge" data-demo-badge title="当前为演示模式：数据均为虚构演示数据，姓名显示为「同学A / 同学B」">演示模式</span>` +
    `</div>`
  );
}

/**
 * 挂载导航。
 * @param {{ target?: string|Element, pathname?: string, check?: boolean }} [opts]
 *        check=false 可关掉存在性探测（默认开）
 * @returns {Element|null} 页头元素（这次探测的 Promise 挂在它的 `availability` 属性上）
 */
export function mountNav(opts = {}) {
  if (typeof document === "undefined") return null;

  const activeId = currentPageId(opts.pathname);
  const explicit = typeof opts.target === "string" ? document.querySelector(opts.target) : opts.target || null;
  let host = explicit || document.querySelector("[data-site-header]") || document.querySelector(".site-header");

  let created = false;
  if (!host) {
    host = document.createElement("header");
    host.className = "site-header";
    host.setAttribute("data-site-header", "");
    created = true;
  }

  // 已有页头就只更新导航与徽章，不重复堆叠
  host.innerHTML = navHTML(activeId);

  if (created) {
    document.body.insertBefore(host, document.body.firstChild);
  }

  // B7 导航收缩：手机端把手点开/再点收起，按住往上滑也能收起；桌面端靠 CSS :hover / :focus-within 展开
  const handle = host.querySelector("#navHandle");
  const rootEl = document.documentElement;
  const setOpen = (open) => {
    rootEl.dataset.nav = open ? "open" : "closed";
    handle?.setAttribute("aria-expanded", open ? "true" : "false");
    handle?.setAttribute("aria-label", open ? "收起导航栏" : "展开导航栏");
  };
  rootEl.dataset.nav = rootEl.dataset.nav || "closed";
  handle?.addEventListener("click", () => setOpen(rootEl.dataset.nav !== "open"));
  let touchY = 0;
  host.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  host.addEventListener("touchmove", (e) => {
    if (rootEl.dataset.nav !== "open") return;
    if (touchY - e.touches[0].clientY > 40) setOpen(false);   // 上滑 40px 收起
  }, { passive: true });

  // 点「品牌」或「当前页」不再重复加载（用户反馈：点了没反应才对，不该重新弹一下）
  host.querySelectorAll("a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      try {
        const target = new URL(a.getAttribute("href"), location.href).pathname.replace(/\/+$/, "") || "/";
        const here = location.pathname.replace(/\/+$/, "") || "/";
        if (target === here) { e.preventDefault(); a.blur(); }
      } catch { /* 非普通路径：交给浏览器 */ }
    });
  });

  // 当前页高亮后再兜一层：非 JS 场景（直接在 HTML 里写死链接）也不会错
  host.querySelectorAll(".nav-link").forEach((a) => {
    if (a.dataset.nav === activeId) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  // 页面存在性探测：异步、只发 HEAD、失败不影响导航可用
  if (opts.check !== false) {
    host.availability = decorateAvailability(opts).catch(() => ({}));
  }

  try {
    // B7/B11：滚动揭示 + 标语逐词（走共享层，六个页面共用，各页不用改）
    // 右上角调色盘（色调 / 圆角 / 背景），选择存 localStorage
    import("/js/theme.js").then((t) => t.initTheme?.()).catch(() => {});
    import("/js/ui.js")
      .then((ui) => { ui.initReveals?.(); ui.initTagline?.(); ui.initCardPicker?.(); })
      .catch(() => {});   // 环境不支持 IntersectionObserver 时静默降级

    document.dispatchEvent(new CustomEvent(NAV_READY_EVENT, { detail: { activeId } }));
  } catch {
    /* 老浏览器不支持 CustomEvent 构造：忽略，不影响导航可用 */
  }

  return host;
}

export default {
  PAGES,
  SOON_TEXT,
  mountNav,
  navHTML,
  currentPageId,
  classifyStatus,
  probePages,
  availabilitySync,
  isPageDown,
  collectCheckTargets,
  markSoon,
  clearSoon,
  notifySoon,
  decorateAvailability,
  NAV_READY_EVENT,
};
