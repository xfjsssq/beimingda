/* =============================================================================
   北民大小助手 · 主题与氛围  static/js/theme.js

   为什么有这层：
     用户反馈"背景太单调、想自己调色调"。这里给站点加一套**可切换的主题预设**
     （色调 / 圆角 / 背景纹理 / 正文字号），右上角一个小调色盘，选择存 localStorage。

   规范约束（landing-page-design）：
     · 只覆盖 CSS 变量，不改结构；切换是 CSS 变量替换，不重排布局
     · 动效只动 color / background / box-shadow（300ms，基础曲线）
     · ⛔ 不引任何外链：背景纹理是本站 static/img 里的本地文件
   ============================================================================= */

const KEY = "beimingda.theme";

const TONES = [
  { id: "campus", label: "校园蓝", dot: "#1F4E8C" },
  { id: "teal", label: "青竹绿", dot: "#0E7C7B" },
  { id: "amber", label: "暖阳橙", dot: "#C05621" },
  { id: "violet", label: "紫罗兰", dot: "#6A4DF0" },
  { id: "morandi", label: "莫兰迪", dot: "#6B7280" },
];

const RADII = [
  { id: "sm", label: "小圆角" },
  { id: "md", label: "中圆角" },
  { id: "lg", label: "大圆角" },
];

const FONTS = [
  { id: "tight", label: "紧凑" },
  { id: "normal", label: "标准" },
  { id: "loose", label: "宽松" },
];

const BGS = [
  { id: "plain", label: "纯色" },
  { id: "texture", label: "校园纹理" },
];

const DEFAULTS = { tone: "campus", radius: "md", bg: "texture", font: "normal" };

function load() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式下写不了：本次会话内仍然生效 */
  }
}

/** 把状态写到 <html> 的 data-* 上，CSS 负责具体变量 */
export function applyTheme(state) {
  const root = document.documentElement;
  root.dataset.theme = state.tone;
  root.dataset.radius = state.radius;
  root.dataset.bg = state.bg;
  root.dataset.font = state.font;
  root.style.colorScheme = "light";
}

function row(label, items, current, onPick, render) {
  const wrap = document.createElement("div");
  wrap.className = "palette__row";
  const lab = document.createElement("span");
  lab.className = "palette__label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const opts = document.createElement("div");
  opts.className = "palette__opts";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette__opt" + (it.id === current ? " is-on" : "");
    b.setAttribute("aria-pressed", it.id === current ? "true" : "false");
    b.title = it.label;
    if (render) render(b, it);
    else b.textContent = it.label;
    b.addEventListener("click", () => onPick(it.id));
    opts.appendChild(b);
  }
  wrap.appendChild(opts);
  return wrap;
}

/**
 * 右上角调色盘：色调 / 圆角 / 背景（+ 一键恢复默认）
 * @param {{mount?: HTMLElement}} [opts]
 */
export function initTheme(opts = {}) {
  if (typeof document === "undefined") return null;
  if (document.querySelector(".palette")) return null;   // 幂等：只挂一次

  let state = load();
  applyTheme(state);

  const host = document.createElement("div");
  host.className = "palette";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "palette__toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "主题与配色");
  toggle.innerHTML =
    '<span class="icon icon--18" aria-hidden="true" style="--icon:url(/vendor/phosphor/icons/palette.svg)"></span>';

  const panel = document.createElement("div");
  panel.className = "palette__panel";
  panel.hidden = true;

  const rebuild = () => {
    panel.innerHTML = "";
    const head = document.createElement("p");
    head.className = "palette__head";
    head.textContent = "配色与氛围";
    panel.appendChild(head);
    panel.appendChild(
      row("色调", TONES, state.tone, (id) => { state = { ...state, tone: id }; commit(); }, (b, it) => {
        b.classList.add("palette__dot");
        b.style.background = it.dot;
      }),
    );
    panel.appendChild(
      row("圆角", RADII, state.radius, (id) => { state = { ...state, radius: id }; commit(); }),
    );
    panel.appendChild(
      row("背景", BGS, state.bg, (id) => { state = { ...state, bg: id }; commit(); }),
    );
    panel.appendChild(
      row("字体", FONTS, state.font, (id) => { state = { ...state, font: id }; commit(); }),
    );
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "palette__reset";
    reset.textContent = "恢复默认";
    reset.addEventListener("click", () => { state = { ...DEFAULTS }; commit(); });
    panel.appendChild(reset);
  };

  const commit = () => {
    applyTheme(state);
    save(state);
    rebuild();
  };

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  });
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (host.contains(e.target)) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
  });

  rebuild();
  host.append(toggle, panel);
  (opts.mount || document.body).appendChild(host);
  return { get state() { return { ...state }; }, apply: commit };
}

export default { initTheme, applyTheme, TONES, RADII, BGS };
