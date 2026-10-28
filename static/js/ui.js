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
  if (icon) wrap.appendChild(el("div", "state__icon", icon));
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
  const wrap = el("div", "state state--loading");
  wrap.appendChild(el("div", "spinner"));
  wrap.setAttribute("role", "status");
  wrap.appendChild(el("p", "state__hint", text));
  return mount(target, wrap);
}

/** 空态：图标 + 标题 + 一句「下一步该做什么」+ 可选主按钮 */
export function showEmpty(target, opts = {}) {
  return mount(
    target,
    stateNode("", {
      icon: opts.icon || "🗂️",
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
      icon: "⚠️",
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
  return mount(target, stateNode("ok", { icon: "✅", title, hint }));
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
  clearState,
  showLoading,
  showEmpty,
  showError,
  showSuccess,
  showNotice,
  errorText,
  copyText,
};
