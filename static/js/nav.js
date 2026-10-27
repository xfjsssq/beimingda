/* =============================================================================
   北名大小助手 · 共用导航  static/js/nav.js
   契约：contracts/frontend.md §1（冻版 6 页）

   行为：
     - 生成 / 复用页头导航，6 页链接：/ · /takeout · /buddy · /welcome · /schedule · /agent
     - 当前页高亮（aria-current="page" + 视觉样式）
     - ≤768px 由 CSS 收成「底部 tab bar」（无需 JS 判断，见 static/css/app.css 第 12 节）
     - ⛔ 只用 <a href> 链接，不 fetch 其他页面 ——
       其他 4 个页面由各自分支并行开发，暂时 404 也不影响本页
     - ⛔ 无外部依赖、无 CDN，断网可跑

   用法：
     import { mountNav } from "/js/nav.js";
     mountNav();                       // 自动插入到 body 开头（若页面已有页头则原地填充）
   ============================================================================= */

/** 冻版 6 页（顺序即导航顺序） */
export const PAGES = [
  { id: "index", href: "/", label: "首页", icon: "🏠", desc: "功能聚合门户" },
  { id: "takeout", href: "/takeout", label: "代取", icon: "📦", desc: "代取撮合看板" },
  { id: "buddy", href: "/buddy", label: "搭子", icon: "🤝", desc: "搭子墙" },
  { id: "welcome", href: "/welcome", label: "导览", icon: "🗺️", desc: "迎新地图与全景" },
  { id: "schedule", href: "/schedule", label: "日程", icon: "⏰", desc: "课表与提醒" },
  { id: "agent", href: "/agent", label: "Agent", icon: "🔌", desc: "接入 WorkBuddy（评委页）" },
];

/** 导航就绪事件（demo.js 等模块可监听，避免执行顺序耦合） */
export const NAV_READY_EVENT = "bm:nav-ready";

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

/** 单个导航项 HTML */
function linkHTML(page, activeId) {
  const active = page.id === activeId;
  return (
    `<a class="nav-link" href="${page.href}" data-nav="${page.id}"` +
    ` title="${page.desc}"${active ? ' aria-current="page"' : ""}>` +
    `<span class="nav-link__icon" aria-hidden="true">${page.icon}</span>` +
    `<span class="nav-link__label">${page.label}</span>` +
    `</a>`
  );
}

/** 页头 HTML（含演示模式徽章占位；徽章显示由 body[data-demo="1"] 控制） */
export function navHTML(activeId) {
  return (
    `<div class="site-header__inner">` +
    `<a class="brand" href="/">` +
    `<span class="brand__mark" aria-hidden="true">北</span>` +
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
 * @param {{ target?: string|Element, pathname?: string, header?: boolean }} [opts]
 * @returns {Element|null} 页头元素
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

  // 当前页高亮后再兜一层：非 JS 场景（直接在 HTML 里写死链接）也不会错
  host.querySelectorAll(".nav-link").forEach((a) => {
    if (a.dataset.nav === activeId) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  try {
    document.dispatchEvent(new CustomEvent(NAV_READY_EVENT, { detail: { activeId } }));
  } catch {
    /* 老浏览器不支持 CustomEvent 构造：忽略，不影响导航可用 */
  }

  return host;
}

export default { PAGES, mountNav, navHTML, currentPageId, NAV_READY_EVENT };
