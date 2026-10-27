/**
 * 用户（仅昵称，无任何身份字段）与 M1 各 service 共用的入参归一化
 *
 * 为什么在 service 层再建一个用户：
 *   tasks.owner_id / runners.user_id 都是 users 的外键，MCP 与 HTTP 传进来的都是「昵称 handle」，
 *   所以发布任务 / 登记跑腿时都必须先 ensure 出用户行。
 *
 * ⭐ 与 scripts/seed.js 的约定保持一致：id = `demo-user-<handle>`。
 *    两边用同一套 id，才能保证「先跑 seed、后用页面发布」或「先发布、后跑 seed」都不会
 *    因为 handle 的 UNIQUE 约束与外键对不上而冲突（seed 用 INSERT OR IGNORE，只按 id 幂等）。
 *
 * ⛔ 合规：handle 只允许是昵称；这里显式拒绝手机号 / 邮箱形态，避免把可识别身份写进库。
 */
import { getDb } from "../db/index.js";
import { CODES, reject } from "../util/envelope.js";
import { nowSec } from "../util/time.js";

const MAX_HANDLE_LEN = 32;

/** 昵称归一化：去空白 + 校验。非法直接 SCHEMA_REJECTED */
export function normalizeHandle(handle, label = "user_handle") {
  const raw = typeof handle === "string" ? handle.trim() : "";
  if (!raw) reject(CODES.SCHEMA_REJECTED, `${label} 不能为空`);
  if (raw.length > MAX_HANDLE_LEN) {
    reject(CODES.SCHEMA_REJECTED, `${label} 过长（≤ ${MAX_HANDLE_LEN} 字符）`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    reject(CODES.SCHEMA_REJECTED, `${label} 含非法控制字符`);
  }
  if (/^1[3-9]\d{9}$/.test(raw)) {
    reject(CODES.SCHEMA_REJECTED, `${label} 不能是手机号（本站只收昵称）`);
  }
  if (/^\S+@\S+\.\S+$/.test(raw)) {
    reject(CODES.SCHEMA_REJECTED, `${label} 不能是邮箱（本站只收昵称）`);
  }
  return raw;
}

/** 数字归一化：接受 number 与「纯数字字符串」（LLM 客户端常常把数字写成字符串），其余 → null */
export function toFiniteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 整数归一化（用于 limit / top_k / 上线时段分钟数等） */
export function toInt(v, fallback = null) {
  const n = toFiniteNumber(v);
  if (n == null) return fallback;
  return Math.trunc(n);
}

/**
 * 幂等取用户 id（不存在则建）
 * @returns {string} users.id
 */
export function ensureUser(handle, contactCode = null) {
  const name = normalizeHandle(handle);
  const db = getDb();
  const id = `demo-user-${name}`;
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    db.prepare(
      "INSERT OR IGNORE INTO users(id, handle, contact_code, created_at, demo) VALUES (?,?,?,?,1)",
    ).run(id, name, contactCode, nowSec());
  }
  return id;
}

/** 按昵称查（不存在返回 null） */
export function findUserByHandle(handle) {
  const name = typeof handle === "string" ? handle.trim() : "";
  if (!name) return null;
  return getDb().prepare("SELECT * FROM users WHERE handle = ?").get(name) || null;
}

export default { normalizeHandle, toFiniteNumber, toInt, ensureUser, findUserByHandle };
