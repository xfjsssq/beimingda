/* =============================================================================
   北民大小助手 · 演示模式  static/js/demo.js
   契约：contracts/frontend.md §5、contracts/core.md §合规红线 4

   `?demo=1` 时：
     1. 页面右上角显示「演示模式」徽章
     2. 所有姓名显示为「同学A / 同学B …」（同一原始姓名映射稳定，跨页面一致）
     3. 学号/手机号形态的字符串一律打码（本来也不该出现，这是兜底防线）
     4. 触发一次幂等的演示数据灌入 GET /api/demo/seed（接口未就绪则静默跳过）

   默认关闭：不带 ?demo=1 时本模块不改变任何视觉与数据。
   决赛现场路演与抖音直播一律使用 ?demo=1。

   用法：
     import { initDemo, displayName } from "/js/demo.js";
     await initDemo();                       // 页面渲染前调用
     el.textContent = displayName(rawName);   // 渲染姓名处一律过这层
   ============================================================================= */

// 相对导入：浏览器里解析为 /js/api.js，同时让本模块在 Node 下可被单测直接 import
import { apiSafe, lastError } from "./api.js";

/** 假名映射在会话内保持稳定（同一个 raw → 同一个「同学X」） */
const ALIAS_KEY = "bm.demo.alias.map";

/** 演示数据灌入接口（幂等；由核心层提供） */
const SEED_PATH = "/api/demo/seed";

/** 徽章文案 */
const BADGE_TEXT = "演示模式";

/** 学号/手机号形态的兜底打码规则（只为"绝不出现"，不是主要防线） */
/* 不用 lookbehind（老 Android WebView 不支持），用捕获组前缀代替；
   ⚠️ 替换一律用函数形式：`"${1}xxx"` 不是合法的 replace 模式，会被当成字面量 */
const SENSITIVE_PATTERNS = [
  { re: /(^|[^\d])(1[3-9]\d{9})(?!\d)/g, repl: (m, p1) => p1 + "1XXXXXXXXXX" }, // 手机号
  { re: /(^|[^\d])(\d{15})(?!\d)/g, repl: (m, p1) => p1 + "2025XXXX" }, // 15 位（身份证长度）
  { re: /(^|[^\d])(\d{8})(?!\d)/g, repl: (m, p1) => p1 + "2025XXXX" }, // 8 位（学号形态）
];

/** 不打码的容器（配置 JSON / 代码块 / 脚本）—— 打码会破坏 JSON */
const MASK_SKIP_SELECTOR = "pre, code, script, style, textarea, [data-nomask]";

/** 进程内兜底映射：storage 不可用（隐私模式 / 非浏览器）时假名依然逐页稳定 */
let memAliasMap = {};

function readMap() {
  let stored = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(ALIAS_KEY) || "{}") || {};
  } catch {
    stored = {};
  }
  return Object.assign({}, stored, memAliasMap);
}

function writeMap(map) {
  memAliasMap = map;
  try {
    sessionStorage.setItem(ALIAS_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式：仅保留进程内映射，不影响功能 */
  }
}

function aliasLetter(seq) {
  return seq < 26 ? String.fromCharCode(65 + seq) : String(seq + 1);
}

/**
 * 取某个原始姓名的演示假名（同一个 raw 永远得到同一个假名）。
 * @param {string} raw
 * @param {number} [seq] 指定序位（不传则按首次出现顺序分配）
 */
export function aliasFor(raw, seq) {
  const key = String(raw === undefined || raw === null || raw === "" ? "匿名" : raw);
  const map = readMap();
  if (typeof seq === "number" && Number.isFinite(seq)) {
    const name = `同学${aliasLetter(seq)}`;
    if (map[key] !== name) {
      map[key] = name;
      writeMap(map);
    }
    return name;
  }
  if (map[key]) return map[key];
  const name = `同学${aliasLetter(Object.keys(map).length)}`;
  map[key] = name;
  writeMap(map);
  return name;
}

/**
 * 展示用名字：demo 模式 → 假名；正常模式 → 原样返回。
 * 页面凡是渲染姓名/昵称的地方都走这里（handle 也算）。
 */
export function displayName(raw) {
  return isDemo() ? aliasFor(raw) : String(raw === undefined || raw === null ? "" : raw);
}

/** 是否处于演示模式（?demo=1） */
export function isDemo() {
  if (typeof location === "undefined") return false;
  try {
    const v = new URLSearchParams(location.search).get("demo");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

/** 文本打码（导出以便页面在自绘内容上复用） */
export function maskSensitiveText(text) {
  let out = String(text === undefined || text === null ? "" : text);
  for (const { re, repl } of SENSITIVE_PATTERNS) out = out.replace(re, repl);
  return out;
}

/**
 * 对 DOM 做一次打码遍历。跳过 pre/code/script 等容器，
 * 避免把配置 JSON、代码示例里的数字改坏。
 */
export function maskDom(root) {
  if (!isDemo() || typeof document === "undefined") return 0;
  const scope = root && root.nodeType === 1 ? root : document.body;
  if (!scope) return 0;

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(MASK_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (!/\d/.test(node.nodeValue || "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const hits = [];
  let node = walker.nextNode();
  while (node) {
    const before = node.nodeValue;
    const after = maskSensitiveText(before);
    if (after !== before) hits.push({ node, after });
    node = walker.nextNode();
  }
  for (const hit of hits) hit.node.nodeValue = hit.after;
  return hits.length;
}

/** 保证页面上存在一个可见的演示徽章（页头里已有一个就不重复加） */
function ensureBadge() {
  if (typeof document === "undefined") return null;
  let badge = document.querySelector("[data-demo-badge]");
  if (badge) return badge;

  badge = document.createElement("span");
  badge.className = "demo-badge demo-badge--float";
  badge.setAttribute("data-demo-badge", "");
  badge.title = "当前为演示模式：数据均为虚构演示数据，姓名显示为「同学A / 同学B」";
  badge.textContent = BADGE_TEXT;
  document.body.appendChild(badge);
  return badge;
}

/** 灌演示数据（幂等；接口未就绪 → 静默返回 null） */
export async function seedDemoData() {
  return apiSafe(SEED_PATH, { timeoutMs: 4000 });
}

/**
 * 初始化演示模式。
 * @param {{ seed?: boolean, mask?: boolean }} [opts] seed 默认 true（仅 demo 模式下会请求）
 * @returns {Promise<{demo:boolean, seeded:boolean, masked:number, seedPending:boolean}>}
 */
export async function initDemo(opts = {}) {
  const demo = isDemo();
  const result = { demo, seeded: false, masked: 0, seedPending: false };

  if (!demo || typeof document === "undefined") return result;

  document.body.setAttribute("data-demo", "1");
  document.documentElement.setAttribute("data-demo", "1");
  ensureBadge();

  if (opts.seed !== false) {
    const seeded = await seedDemoData();
    // 接口未就绪（M 分支尚未落地）时不算失败：只是没有演示数据可灌
    result.seedPending = seeded === null;
    result.seeded = seeded !== null;
  }

  if (opts.mask !== false) result.masked = maskDom(document.body);
  return result;
}

/** 演示数据未就绪的原因（给页面提示用，不打印到控制台） */
export function seedStatus() {
  const e = lastError(SEED_PATH);
  return e ? { ok: false, code: e.code, message: e.message } : { ok: true, code: null, message: "" };
}

export default { isDemo, initDemo, displayName, aliasFor, maskDom, maskSensitiveText, seedDemoData, seedStatus };
