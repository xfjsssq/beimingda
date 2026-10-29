/* =============================================================================
   北名大小助手 · 三态与通用渲染工具  static/js/ui.js

   为什么单独一个模块：
     早期各页自己写「读取中… / 还没有数据 / ❌ CODE：message」，文案、配色、
     可访问性都不统一，/schedule 甚至用 alert() 弹窗（移动端无法样式化）。
     这里收敛成一套 Loading / Empty / Error / Success 组件，6 页共用。

   硬规则：
     - 零依赖、无外部资源、无远程地址字面量（连注释都不写），断网可跑
     - 一律用 textContent 渲染外部数据；需要拼 HTML 的地方必须过 esc()
     - 动态容器自动补 role="status" + aria-live="polite"，读屏软件能感知变化
   ============================================================================= */

/** HTML 转义：凡是来自接口 / 配置文件的字符串，进 innerHTML 前必须过这层 */
export function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** 建一个元素（text 走 textContent，不解析 HTML） */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** 选择器或元素 → 元素 */
function box(target) {
  if (!target) return null;
  return typeof target === "string" ? document.querySelector(target) : target;
}

/** 把内容装进容器，并保证它是一个 live region */
function mount(target, node, live = "polite") {
  const b = box(target);
  if (!b) return null;
  b.innerHTML = "";
  if (node) b.appendChild(node);
  if (!b.hasAttribute("aria-live")) b.setAttribute("aria-live", live);
  if (!b.hasAttribute("role")) b.setAttribute("role", "status");
  return b;
}

/** 清空容器（回到初始状态） */
export function clearState(target) {
  return mount(target, null);
}

function stateNode(kind, { icon, title, hint, actionText, onAction }) {
  const wrap = el("div", "state" + (kind ? " state--" + kind : ""));
  if (icon) { const holder = el("div", "state__icon"); holder.appendChild(decorIcon(icon, 30)); wrap.appendChild(holder); }
  if (title) wrap.appendChild(el("p", "state__title", title));
  if (hint) wrap.appendChild(el("p", "state__hint", hint));
  if (actionText && typeof onAction === "function") {
    const actions = el("div", "state__action");
    const btn = el("button", "btn btn--ghost btn--sm", actionText);
    btn.type = "button";
    btn.addEventListener("click", onAction);
    actions.appendChild(btn);
    wrap.appendChild(actions);
  }
  return wrap;
}

/** 加载中：旋转指示 + 一句说明（不阻塞页面其它部分） */
export function showLoading(target, text = "正在读取…") {
  // B9：加载态用"跟真实布局同形的骨架屏"，不用转圈
  const wrap = el("div", "state state--loading");
  const sk = el("div", "skeleton");
  sk.appendChild(el("i")); sk.appendChild(el("i")); sk.appendChild(el("i"));
  wrap.appendChild(sk);
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", text);
  wrap.appendChild(el("p", "state__hint", text));
  return mount(target, wrap);
}

/** 空态：图标 + 标题 + 一句「下一步该做什么」+ 可选主按钮 */
export function showEmpty(target, opts = {}) {
  return mount(
    target,
    stateNode("", {
      icon: opts.icon || "package",
      title: opts.title || "这里还没有内容",
      hint: opts.hint || "",
      actionText: opts.actionText,
      onAction: opts.onAction,
    }),
  );
}

/** 把各种错误形态（ApiError / 信封 / 字符串）翻译成人话 */
export function errorText(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  const code = err.code || (err.error && err.error.code) || "";
  const msg = err.message || (err.error && err.error.message) || String(err);
  if (code === "QUOTA") return "触发限频（演示令牌有限流），稍等片刻再试";
  if (code === "TIMEOUT") return "请求超时，请检查服务是否在线后重试";
  if (code === "NOT_FOUND") return "对应接口还没就绪（404），不是本页报错";
  if (code === "SCHEMA_REJECTED") return msg || "请求被拒绝（鉴权或参数不合法）";
  return code ? code + "：" + msg : msg;
}

/** 失败态：标题 + 原因 + 可选「重试」按钮 */
export function showError(target, err, opts = {}) {
  return mount(
    target,
    stateNode("error", {
      icon: "alert-triangle",
      title: opts.title || "这一步没成功",
      hint: opts.hint || errorText(err),
      actionText: opts.retryText || (opts.onRetry ? "重试" : ""),
      onAction: opts.onRetry,
    }),
    "assertive",
  );
}

/** 成功态（用于发布 / 登记 / 保存后的落点提示） */
export function showSuccess(target, title, hint = "") {
  return mount(target, stateNode("ok", { icon: "circle-check", title, hint }));
}

/** 轻量行内提示（替代早期的 .msg.err / alert） */
export function showNotice(target, text, kind = "") {
  const b = box(target);
  if (!b) return null;
  b.innerHTML = "";
  const p = el("p", "notice" + (kind ? " notice--" + kind : ""), text);
  p.style.marginTop = "10px";
  if (kind === "danger") p.setAttribute("role", "alert");
  b.appendChild(p);
  if (!b.hasAttribute("aria-live")) b.setAttribute("aria-live", "polite");
  return b;
}

/** 复制文本（带非安全上下文退路），成功返回 true */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 非安全上下文会拒绝，走下面的退路 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export default {
  esc,
  el,
  icon,
  decorIcon,
  clearState,
  showLoading,
  showEmpty,
  showError,
  showSuccess,
  showNotice,
  errorText,
  copyText,
  mountTabs,
  createSheet,
  initReveals,
  initTagline,
  openModal,
  toast,
};

/* =============================================================================
   组件层 v2（2026-10-28）—— 图标 / 分栏 / 侧栏 / 弹层 / 轻提示
   设计目标：把「一屏塞满」改成「分层 + 按需展开」。
   全部零依赖、无外链；DOM 一律用 createElement/textContent 构造（外部字符串过 esc）。
   ============================================================================= */

/** 图标元素：用 CSS mask 着色，随父级文字颜色变化（一个 svg 文件适配所有场景） */
/** 已本地化的图标名（static/vendor/phosphor/icons/*.svg）。列表外的名字一律当普通文字渲染，兼容旧调用。 */
export const ICON_NAMES = new Set([
  "package", "users", "map-pin", "calendar-event", "robot", "plug-connected", "list-check", "wand", "message-chatbot", "tools", "shield-check", "copy", "check", "x", "chevron-right", "chevron-down", "plus", "pencil", "trash", "clock", "building-community", "school", "book", "walk", "truck-delivery", "bolt", "sparkles", "external-link", "refresh", "search", "send", "user", "info-circle", "alert-triangle", "circle-check", "arrow-right", "map", "route", "device-mobile", "key", "lock", "clipboard-text", "chart-bar", "sun", "moon", "palette", "paint-brush", "download-simple", "upload-simple", "eraser", "sliders-horizontal", "eye", "eye-slash", "text-t", "circle", "arrows-out", "magnifying-glass-plus", "magnifying-glass-minus", "crosshair", "drop", "tag", "star", "heart", "flag", "note-pencil", "selection", "hand-pointing", "dots-three-vertical", "caret-up", "arrow-clockwise", "share-network", "chart-line-up", "users-three", "queue", "lightbulb", "note",
]);

/** 三态里的装饰图标：认识的名字给 .icon（可着色），不认识的（例如历史遗留的 emoji）原样当文字 */
export function decorIcon(name, size = 28) {
  if (typeof name === "string" && ICON_NAMES.has(name)) return icon(name, { size });
  const n = el("span", "state__emoji", name || "");
  n.setAttribute("aria-hidden", "true");
  return n;
}
export function icon(name, { size = 18, cls = "" } = {}) {
  const n = el("span", "icon icon--" + size + (cls ? " " + cls : ""));
  n.style.setProperty("--icon", `url(/vendor/phosphor/icons/${name}.svg)`);
  n.setAttribute("aria-hidden", "true");
  return n;
}

function lockScroll(on) {
  document.body.classList.toggle("is-locked", Boolean(on));
}

/* ---------------------------------------------------------------- 分栏（tabs） */
/**
 * 把一个 role=tablist 的容器 + 若干 tabpanel 接起来。
 * 用法：
 *   const tabs = mountTabs("#agentTabs", { syncHash: true });
 *   <div class="tabs" id="agentTabs" role="tablist">
 *     <button class="tab" role="tab" aria-controls="p-manual" aria-selected="true" data-panel="p-manual">手动接入</button>
 *   </div>
 *   <section class="tabpanel" id="p-manual" role="tabpanel">…</section>
 */
export function mountTabs(root, { syncHash = false, onChange } = {}) {
  const list = box(root);
  if (!list) return null;
  const tabs = [...list.querySelectorAll('[role="tab"]')];

  const select = (tab, { focus = false, silent = false } = {}) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.dataset.panel);
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
    if (syncHash && tab.dataset.panel) {
      const url = new URL(location.href);
      url.hash = tab.dataset.panel;
      history.replaceState(null, "", url);
    }
    if (!silent && typeof onChange === "function") onChange(tab.dataset.panel, tab);
  };

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      let next = i;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = tabs.length - 1;
      select(tabs[next], { focus: true });
    });
  });

  // 初始：优先 hash，其次 aria-selected，最后第一个
  const fromHash = location.hash && tabs.find((t) => t.dataset.panel === location.hash.slice(1));
  const current = fromHash || tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
  if (current) select(current, { silent: true });

  // 浏览器前进/后退（hash 变化）也要切栏；⛔ 不写回 hash，避免 history 抖动
  if (syncHash) {
    window.addEventListener("hashchange", () => {
      const want = location.hash.slice(1);
      const target = tabs.find((t) => t.dataset.panel === want);
      if (target && target.getAttribute("aria-selected") !== "true") select(target, { silent: true });
    });
  }
  return { select: (id) => { const t = tabs.find((x) => x.dataset.panel === id); if (t) select(t); }, tabs };
}

/* ---------------------------------------------------------------- 侧栏（sheet） */
/**
 * 右侧抽屉（≤640px 自动变底部面板）。内容与按钮由调用方给，避免这里夹带业务。
 * @returns {{open:Function, close:Function, body:HTMLElement, foot:HTMLElement, root:HTMLElement}}
 */
export function createSheet({ title = "", iconName = "", body = null, footer = null, onClose } = {}) {
  const backdrop = el("div", "sheet-backdrop");
  const root = el("aside", "sheet");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", title || "面板");

  const head = el("div", "sheet__head");
  const h = el("h3", "");
  if (iconName) h.appendChild(icon(iconName, { size: 20 }));
  const titleText = el("span", "", title);
  titleText.style.marginLeft = iconName ? "8px" : "0";
  h.appendChild(titleText);
  const close = el("button", "sheet__close");
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.appendChild(icon("x", { size: 18 }));
  head.append(h, close);

  const bodyEl = el("div", "sheet__body");
  if (body) bodyEl.appendChild(body);
  const footEl = el("div", "sheet__foot");
  if (footer) footEl.appendChild(footer);
  root.append(head, bodyEl, footEl);
  document.body.append(backdrop, root);

  const closeIt = () => {
    root.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    lockScroll(false);
    if (typeof onClose === "function") onClose();
  };
  close.addEventListener("click", closeIt);
  backdrop.addEventListener("click", closeIt);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeIt(); });

  return {
    root, body: bodyEl, foot: footEl,
    open: () => { root.classList.add("is-open"); backdrop.classList.add("is-open"); lockScroll(true); },
    close: closeIt,
  };
}

/* ---------------------------------------------------------------- 弹层（modal） */
/** 居中弹层（≤640px 变底部面板）；返回 promise：resolve(true)=确认，resolve(false)=取消 */
export function openModal({ title = "", iconName = "", body = null, confirmText = "保存", cancelText = "取消", danger = false } = {}) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", title);

  const head = el("div", "modal__head");
  const h3 = el("h3", "");
  if (iconName) h3.appendChild(icon(iconName, { size: 20 }));
  const t = el("span", "", title);
  if (iconName) t.style.marginLeft = "8px";
  h3.appendChild(t);
  head.appendChild(h3);

  const bodyEl = el("div", "modal__body");
  if (body) bodyEl.appendChild(body);
  const foot = el("div", "modal__foot");
  const cancel = el("button", "btn btn--quiet", cancelText);
  cancel.type = "button";
  const ok = el("button", "btn" + (danger ? " btn--danger" : ""), confirmText);
  ok.type = "button";
  foot.append(cancel, ok);
  modal.append(head, bodyEl, foot);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("is-open"));
  lockScroll(true);

  return new Promise((resolve) => {
    const done = (val) => {
      backdrop.classList.remove("is-open");
      lockScroll(false);
      setTimeout(() => backdrop.remove(), 180);
      resolve(val);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) done(false); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); done(false); }
    });
    ok.focus();
  });
}

/* ---------------------------------------------------------------- 轻提示（toast） */
export function toast(text, kind = "") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) { wrap = el("div", "toast-wrap"); document.body.appendChild(wrap); }
  const n = el("div", "toast" + (kind ? " toast--" + kind : ""));
  n.appendChild(icon(kind === "danger" ? "alert-triangle" : kind === "ok" ? "circle-check" : "info-circle", { size: 16 }));
  n.appendChild(el("span", "", text));
  wrap.appendChild(n);
  setTimeout(() => { n.style.opacity = "0"; n.style.transition = "opacity .25s"; setTimeout(() => n.remove(), 260); }, 2600);
  return n;
}


/* =============================================================================
   B7 滚动揭示 + B11 标语逐词激活（2026-10-29）
   规范：只动 transform/opacity；用 IntersectionObserver，⛔ 不用未节流的 scroll 监听；
        每个区块只播一次；prefers-reduced-motion 下退化成直接显示。
   ============================================================================= */

/** 给所有 .reveal 区块挂观察器：进入视口 32px 后升起并淡入，只播一次 */
export function initReveals(root = document) {
  const items = [...root.querySelectorAll(".reveal")];
  if (!items.length) return 0;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    items.forEach((n) => n.classList.add("is-in"));
    return items.length;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("is-in");
      io.unobserve(e.target);          // 只播一次，回滚时不重播
    }
  }, { rootMargin: "0px 0px -32px 0px", threshold: 0.08 });
  items.forEach((n) => io.observe(n));
  return items.length;
}

/**
 * B11 标语揭示：文本里用 `|` 分隔"词"，逐词从 30% 灰升到正文色。
 * 用法：<p class="tagline-text" data-words="取快递|找搭子|认路|记 DDL">…</p>
 */
export function initTagline(root = document) {
  const nodes = [...root.querySelectorAll("[data-words]")];
  if (!nodes.length) return 0;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const n of nodes) {
    const words = String(n.dataset.words || "").split("|").filter(Boolean);
    n.textContent = "";
    const spans = words.map((w) => {
      const s = el("span", "w", w);
      n.appendChild(s);
      return s;
    });
    if (reduce || !("IntersectionObserver" in window)) { spans.forEach((s) => s.classList.add("on")); continue; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("on"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -45% 0px", threshold: 0 });
    spans.forEach((s) => io.observe(s));
  }
  return nodes.length;
}
