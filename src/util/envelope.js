/**
 * 统一返回信封（冻版）—— 全站所有 HTTP API 与 MCP 工具返回都必须经过这里。
 * ⛔ 不许任何模块各写一份。
 *
 *   { ok: true,  data: {...}, error: null }
 *   { ok: false, data: null,  error: { code, message } }
 */

export const CODES = Object.freeze({
  SCHEMA_REJECTED: "SCHEMA_REJECTED",
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  QUOTA: "QUOTA",
  INTERNAL: "INTERNAL",
});

export const ok = (data) => ({ ok: true, data, error: null });

export const err = (code, message) => ({
  ok: false,
  data: null,
  error: { code, message: String(message ?? "") },
});

/** 业务异常：抛出后由 server.js 的错误中间件统一转成信封 */
export class AppError extends Error {
  constructor(code, message) {
    super(String(message ?? code));
    this.name = "AppError";
    this.code = CODES[code] ? code : CODES.INTERNAL;
  }
}

/** 用法：if (bad) reject(CODES.SCHEMA_REJECTED, "reward_min > reward_max"); */
export function reject(code, message) {
  throw new AppError(code, message);
}

/** 把任意异常归一化成信封 */
export function toEnvelope(e) {
  if (e instanceof AppError) return err(e.code, e.message);
  return err(CODES.INTERNAL, e?.message || "internal error");
}

/** 校验 body 只允许出现白名单字段（配合 MCP schema 的 additionalProperties:false） */
export function assertNoExtraKeys(obj, allowed, label = "object") {
  const extra = Object.keys(obj ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length) {
    reject(CODES.SCHEMA_REJECTED, `${label} 含非法字段: ${extra.join(",")}`);
  }
}

export default { CODES, ok, err, AppError, reject, toEnvelope, assertNoExtraKeys };
