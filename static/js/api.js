/* =============================================================================
   北名大小助手 · 统一 API 封装  static/js/api.js
   契约：contracts/core.md §3（统一信封 {ok,data,error}）、§4（鉴权）

   规则（全站前端只走这一层，⛔ 页面里不许各写 fetch）：
     1. 自动解 `{ok,data,error}` 信封：ok=true 返回 data；ok=false 抛 ApiError（带 code）
     2. 读接口开放；写接口（POST/PUT/PATCH/DELETE）自动带 `X-Demo-Token`
        —— 令牌只从「服务端注入处」取（/config.js 注入的 window.__DEMO_TOKEN__），
           ⛔ 本文件、任何页面、任何脚本里都不许出现真实令牌字面量
     3. 「接口未就绪」安全降级：apiSafe() / apiList() 返回 null，绝不把异常抛到控制台炸掉整页
        （M1/M2/M4 的 /api/tasks、/api/buddies、/api/schedule 会与本分支并行开发）
     4. 全部请求同源、带超时；⛔ 不请求任何外部域名（断网可跑）

   用法：
     import { api, apiSafe, apiList } from "/js/api.js";
     const list  = await apiList("/api/tasks");            // 未就绪 → null
     const hello = await api("/api/health");               // 失败 → 抛 ApiError
     await api("/api/tasks", { method: "POST", body: {...} }); // 写接口自动带令牌
   ============================================================================= */

/** 写接口（需要 X-Demo-Token）的 HTTP 方法 */
import { sessionToken } from "./session.js";   // ⚠️ 必须相对导入：/js/... 在 Node 测试里解析成 C:\js\... 会炸

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 写接口令牌头（契约 contracts/core.md §4） */
const TOKEN_HEADER = "X-Demo-Token";

/** 会话令牌头（2026-10-31）：代表"我是谁"。与 TOKEN_HEADER 严格错开，⛔ 不许混用 */
const SESSION_HEADER = "X-Session-Token";

/** 令牌只存本机浏览器会话，⛔ 不落库、不入库、不写进页面 */
const TOKEN_STORAGE_KEY = "bm.demo.token.session";

/** 服务端注入点的候选全局名（/config.js 注入了哪个就用哪个） */
const INJECTED_TOKEN_KEYS = ["__DEMO_TOKEN__", "__DEMO_TOKEN", "DEMO_TOKEN"];

/** 默认超时（毫秒）；CF 隧道对单次响应有 100 秒硬限制，前端再收紧一档 */
const DEFAULT_TIMEOUT_MS = 8000;

/** 契约错误码（contracts/core.md §信封） */
export const ENVELOPE_CODES = ["SCHEMA_REJECTED", "NOT_FOUND", "TIMEOUT", "QUOTA", "INTERNAL"];

/** 统一错误类型：带 code / status / envelop，页面可据此提示而不白屏 */
export class ApiError extends Error {
  constructor(message, code = "INTERNAL", status = 0, envelope = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.envelope = envelope;
  }
}

/** 记录最近一次失败（apiSafe 静默降级时，页面仍可展示"接口未就绪"提示） */
const lastErrors = new Map();

/**
 * 站点域名（服务端 /config.js 注入的 window.__SITE_DOMAIN__）
 * ⛔ 页面里不许硬编码域名，一律走这里
 */
export function siteDomain() {
  const raw = typeof window !== "undefined" ? window.__SITE_DOMAIN__ : "";
  return typeof raw === "string" ? raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
}

/** 应用版本（服务端注入，取不到就回退 uknown 语义） */
export function appVersion() {
  const v = typeof window !== "undefined" ? window.__APP_VERSION__ : "";
  return typeof v === "string" && v ? v : "";
}

function readInjectedToken() {
  if (typeof window === "undefined") return "";
  for (const key of INJECTED_TOKEN_KEYS) {
    const v = window[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // 兼容 <meta name="demo-token" content="..."> 注入方式
  try {
    const meta = document.querySelector('meta[name="demo-token"]');
    if (meta && meta.content && meta.content.trim()) return meta.content.trim();
  } catch {
    /* 非浏览器环境：忽略 */
  }
  return "";
}

function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* 隐私模式下 storage 不可用：忽略，不影响读接口 */
  }
}

/**
 * 取出写接口令牌。优先级：
 *   1) 服务端注入（/config.js 的 window.__DEMO_TOKEN__ 或 <meta name="demo-token">）
 *   2) 本机浏览器会话（由 setApiToken() 或 ?token=xxx 一次性传入后写入 sessionStorage）
 *   3) 地址栏 ?token=xxx（只在 URL 里出现一次，随即写入会话并清理地址栏）
 * 取不到就返回空串 —— 读接口照常工作，写接口会返回 401（页面提示，不白屏）。
 * ⛔ 令牌绝不写进任何源码或页面。
 */
export function apiToken() {
  const injected = readInjectedToken();
  if (injected) return injected;

  const stored = readStoredToken();
  if (stored) return stored;

  if (typeof location !== "undefined") {
    let fromUrl = "";
    try {
      fromUrl = new URLSearchParams(location.search).get("token") || "";
    } catch {
      fromUrl = "";
    }
    if (fromUrl.trim()) {
      storeToken(fromUrl.trim());
      try {
        const url = new URL(location.href);
        url.searchParams.delete("token");
        history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
      } catch {
        /* 不能改地址栏就算了：令牌已收进会话 */
      }
      return fromUrl.trim();
    }
  }
  return "";
}

/** 运行时注入令牌（例如演示时由 /config.js 之外的方式下发）；空值表示清除 */
export function setApiToken(token) {
  const t = typeof token === "string" ? token.trim() : "";
  storeToken(t);
  return t;
}

/** 是否已具备写接口令牌（页面据此决定"只读演示"提示，而不是猜） */
export function hasWriteToken() {
  return apiToken() !== "";
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return "SCHEMA_REJECTED"; // 契约里令牌不合法走 SCHEMA_REJECTED
  if (status === 404) return "NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return "QUOTA";
  return "INTERNAL";
}

function rememberError(path, error) {
  lastErrors.set(String(path), { code: error.code, message: error.message, at: Date.now() });
  return null;
}

/** 最近一次失败详情（apiSafe 静默降级后，页面仍可解释"为什么是 --"） */
export function lastError(path) {
  return lastErrors.get(String(path)) || null;
}

/** 清空失败记录（点击"重试"时用） */
export function clearErrors() {
  lastErrors.clear();
}

/**
 * 发起请求并解信封。
 * @param {string} path  同源路径，如 "/api/tasks"
 * @param {object} [opts] { method, body, headers, token, timeoutMs, signal }
 * @returns {Promise<any>} 解出来的 data（裸数据接口原样返回）
 * @throws {ApiError} 网络失败 / 非 2xx / 信封 ok=false
 */
export async function api(path, opts = {}) {
  const url = String(path);
  const method = String(opts.method || "GET").toUpperCase();
  const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
  // * 每个请求都带上会话身份：服务端据此判定"这是谁发的"
  const sid = sessionToken();
  if (sid) headers[SESSION_HEADER] = sid;

  const init = { method, headers, credentials: "same-origin", cache: "no-store" };

  if (opts.body !== undefined && opts.body !== null) {
    if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
      init.body = opts.body; // 交给浏览器自己带 boundary，⛔ 不手动设 Content-Type
    } else {
      headers["Content-Type"] = "application/json";
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
  }

  if (WRITE_METHODS.has(method)) {
    const token = opts.token !== undefined ? opts.token : apiToken();
    if (token) headers[TOKEN_HEADER] = token;
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer = null;
  let ctrl = opts.signal || null;
  if (!ctrl && typeof AbortController !== "undefined") {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal = ctrl.signal;
  } else if (ctrl) {
    init.signal = ctrl;
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    const err = new ApiError(
      aborted ? `${url} 请求超时（${timeoutMs}ms）` : `${url} 请求失败：${e && e.message ? e.message : e}`,
      aborted ? "TIMEOUT" : "INTERNAL",
      0,
    );
    rememberError(url, err);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = await res.text().catch(() => "");
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null; // 非 JSON（例如 500 的纯文本兜底）→ 下面按状态码处理
    }
  }

  // 统一信封：{ok,data,error}
  if (json && typeof json === "object" && "ok" in json && "data" in json) {
    if (json.ok === true) return json.data;
    const err = new ApiError(
      (json.error && json.error.message) || `${url} 返回失败信封`,
      (json.error && json.error.code) || codeForStatus(res.status),
      res.status,
      json,
    );
    rememberError(url, err);
    throw err;
  }

  if (!res.ok) {
    const err = new ApiError(
      `${url} HTTP ${res.status}${raw ? "：" + raw.slice(0, 160) : ""}`,
      codeForStatus(res.status),
      res.status,
    );
    rememberError(url, err);
    throw err;
  }

  // 裸数据兜底（某些模块可能先直接 res.json(array)）；空响应体返回 null
  return json === null && raw ? raw : json;
}

/**
 * 安全版：失败一律返回 null，不抛（用于"接口未就绪"的页面区块）。
 * 页面渲染成"—"并附一句来源说明，而不是白屏或写死数字。
 */
export async function apiSafe(path, opts = {}) {
  try {
    return await api(path, opts);
  } catch (e) {
    rememberError(path, e instanceof ApiError ? e : new ApiError(String(e && e.message ? e.message : e)));
    return null;
  }
}

/**
 * 取列表型接口，永远给数组或 null（绝不返回 undefined 让页面炸）。
 * 兼容 data 为数组 / {items:[]} / {list:[]} 三种形态。
 */
export async function apiList(path, opts = {}) {
  const data = await apiSafe(path, opts);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.data)) return data.data;
  return null;
}

/** 健康检查（核心层已提供；失败返回 null） */
export async function apiHealth(opts = {}) {
  return apiSafe("/api/health", opts);
}

/* ---------------------------------------------------------------------------
   MCP 端点（远程 Streamable HTTP：POST /mcp，JSON-RPC 2.0）
   用于 /agent 页"实时核对 14 个工具是否已注册"。
   ⛔ 不做 SSE 长连接保活（CF 隧道 100 秒硬限制）；令牌走 Authorization: Bearer。
   --------------------------------------------------------------------------- */

/** POST 一次 JSON-RPC，返回 result（失败抛 ApiError） */
export async function mcpRpc(method, params, opts = {}) {
  const token = opts.token !== undefined ? opts.token : apiToken();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = { jsonrpc: "2.0", id: opts.id || Date.now(), method };
  if (params !== undefined) payload.params = params;

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer = null;
  const init = { method: "POST", headers, body: JSON.stringify(payload), credentials: "same-origin", cache: "no-store" };
  if (typeof AbortController !== "undefined" && !opts.signal) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal = ctrl.signal;
  } else if (opts.signal) {
    init.signal = opts.signal;
  }

  let res;
  try {
    res = await fetch("/mcp", init);
  } catch (e) {
    const err = new ApiError(`/mcp ${method} 请求失败：${e && e.message ? e.message : e}`, "INTERNAL", 0);
    rememberError("/mcp", err);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = await res.text().catch(() => "");
  // 兼容 application/json 与 text/event-stream 两种回法（取最后一条 data: 行）
  let json = null;
  const looksSse = /text\/event-stream/i.test(res.headers.get("content-type") || "") || /^\s*data:/m.test(raw);
  const text = looksSse
    ? raw
        .split(/\r?\n/)
        .filter((l) => /^\s*data:/.test(l))
        .map((l) => l.replace(/^\s*data:\s?/, ""))
        .pop() || ""
    : raw;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || !json) {
    const err = new ApiError(
      `/mcp ${method} HTTP ${res.status}${raw ? "：" + raw.slice(0, 160) : ""}`,
      codeForStatus(res.status),
      res.status,
    );
    rememberError("/mcp", err);
    throw err;
  }
  if (json.error) {
    const err = new ApiError(
      `MCP ${method} 失败：${json.error.message || "unknown"}`,
      json.error.code ? String(json.error.code) : "INTERNAL",
      res.status,
    );
    rememberError("/mcp", err);
    throw err;
  }
  return json.result;
}

/** 实时取 MCP 工具名清单；未就绪 / 无令牌 → 返回 null（页面回退到内置清单） */
export async function mcpToolNames(opts = {}) {
  try {
    const result = await mcpRpc("tools/list", undefined, opts);
    const tools = result && Array.isArray(result.tools) ? result.tools : [];
    return tools.map((t) => t && t.name).filter((n) => typeof n === "string");
  } catch (e) {
    rememberError("/mcp", e);
    return null;
  }
}

/** 便于调试/自证：把最近失败一览打印到 console（只在显式调用时执行） */
export function dumpErrors() {
  return [...lastErrors.entries()].map(([path, info]) => ({ path, ...info }));
}

export default { api, apiSafe, apiList, apiHealth, apiToken, setApiToken, hasWriteToken, siteDomain, appVersion, lastError, clearErrors, dumpErrors, mcpRpc, mcpToolNames, ApiError };
