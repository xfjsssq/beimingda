/**
 * 时间转换（冻版）
 *   存库：Unix 秒（INTEGER）
 *   出接口：ISO 8601 带时区
 * ⛔ 所有模块一律用这里的函数，不许自己写 Date 转换。
 */

/** ISO 8601 字符串 → Unix 秒；非法返回 null */
export function toTs(iso) {
  if (iso == null || iso === "") return null;
  if (typeof iso === "number") return Math.floor(iso);
  const ms = Date.parse(String(iso));
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** Unix 秒 → ISO 8601（UTC 带 Z，等价于带时区）；空值返回 null */
export function toIso(ts) {
  if (ts == null) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

/** 当前 Unix 秒（可注入 now 便于测试） */
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** ISO 必须晚于 now，否则抛由调用方决定 —— 这里只做判定 */
export function isFutureIso(iso, now = nowSec()) {
  const ts = toTs(iso);
  return ts != null && ts > now;
}

export default { toTs, toIso, nowSec, isFutureIso };
