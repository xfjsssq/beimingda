/**
 * 双选揭示状态机（M2 · 冻版逻辑，⛔ 不得简化）
 *
 *   契约：contracts/m2-buddy.md §3
 *
 *   初始：       author_ok=0, seeker_ok=0, revealed=0
 *   寻找方同意：  seeker_ok=1        -> author_ok 保持 0，revealed 保持 0
 *   发布方同意：  author_ok=1
 *   双方都为 1： revealed=1，此时才返回 contact_code
 *
 *   任一方拒绝（agree=false）即终止：该方 bit 归 0，revealed 归 0，
 *   且该 (post_id, seeker_id) 不再接受任何表决
 *   —— 持久化层面的保证是 buddy_consents 的 UNIQUE(post_id, seeker_id)
 *
 * 本文件是**纯逻辑**：不碰数据库、不碰 HTTP、不调 LLM，可直接单测。
 * 落库与身份解析在 src/services/buddy.js，派生字段（reveal_status）也在这里。
 *
 * ⛔ 三条硬约束（评审对照用）
 *   1. 任何一方未同意时，绝不返回 contact_code
 *   2. 绝不向一方暗示"对方已经同意了"（对外只给 pending / mutual）
 *   3. 不得把 anon_token 与真实身份关联后展示给另一方
 */
import { CODES, reject } from "../util/envelope.js";

export const ROLES = Object.freeze({ AUTHOR: "author", SEEKER: "seeker" });

/** 对外暴露的双选状态（唯一允许透出的对方信息） */
export const REVEAL_STATUS = Object.freeze({ PENDING: "pending", MUTUAL: "mutual" });

const bit = (v) => (v === 1 || v === true ? 1 : 0);

/** 初始行：双方未表态 */
export function initialConsent() {
  return { author_ok: 0, seeker_ok: 0, revealed: 0 };
}

/**
 * 把任意来源（DB 行 / 半成品对象 / undefined）收敛成 {author_ok,seeker_ok,revealed} 三个 bit。
 *
 * ⛔ `revealed` **不由存储列决定**：只有 author_ok 与 seeker_ok 同时为 1 才算揭示。
 *    库里那一列即使是脏值（被手工改成 1、或历史遗留），也不会让出口吐出 contact_code。
 */
export function normalizeConsent(row) {
  const r = row ?? {};
  const author_ok = bit(r.author_ok);
  const seeker_ok = bit(r.seeker_ok);
  return {
    author_ok,
    seeker_ok,
    revealed: author_ok === 1 && seeker_ok === 1 ? 1 : 0,
  };
}

/**
 * 核心状态迁移：对 row 施加"某一方表态 agree"
 *
 * @param {object} row  当前行（可为 initialConsent()）
 * @param {"author"|"seeker"} who 表态方
 * @param {boolean} agree 同意 / 拒绝
 * @returns {{author_ok:number, seeker_ok:number, revealed:number}} 新行（不改原对象）
 */
export function applyConsent(row, who, agree) {
  if (who !== ROLES.AUTHOR && who !== ROLES.SEEKER) {
    reject(CODES.SCHEMA_REJECTED, `who 只能是 author / seeker，收到: ${String(who)}`);
  }
  if (typeof agree !== "boolean") {
    reject(CODES.SCHEMA_REJECTED, "agree 必须是布尔值");
  }

  const next = normalizeConsent(row);
  const v = agree ? 1 : 0;
  if (who === ROLES.SEEKER) next.seeker_ok = v;
  else next.author_ok = v;

  // revealed 永远由两个 bit 重新推导，⛔ 不许从外部直接写入
  next.revealed = next.author_ok === 1 && next.seeker_ok === 1 ? 1 : 0;
  return next;
}

/** 双方是否都已同意 */
export function isMutual(row) {
  const r = normalizeConsent(row);
  return r.author_ok === 1 && r.seeker_ok === 1;
}

/**
 * 语义化状态："pending"（含未表决 / 仅一方同意 / 已拒绝）或 "mutual"。
 * ⛔ 这是唯一允许出现在候选结果里的双选信息 —— 不透露是哪一方同意、也不透露对方是否已同意。
 */
export function revealStatus(row) {
  return isMutual(row) ? REVEAL_STATUS.MUTUAL : REVEAL_STATUS.PENDING;
}

/**
 * 该行是否已终局（不可再有任何表决）：
 *   - 已互相可见           -> 终局
 *   - 该行被表态方拒绝过   -> 由 service 用 UNIQUE(post_id,seeker_id) 判定为终局
 * 本函数只回答"是否已经互相可见"，拒绝态由 service 的"行已存在即不可再表决"保证。
 */
export function isSettled(row) {
  return isMutual(row);
}

/**
 * 对外响应（contracts/m2-buddy.md §4.3）
 *
 * ⛔ 关键：revealed=0 时 contact_code **这个键根本不出现在对象里**
 *    （不是置 null、不是空字符串 —— 是 Object.hasOwn() 为 false）
 *
 * ⛔ 脏数据防线：是否揭示**以状态机推导为准**（author_ok && seeker_ok 同时为真），
 *    ⛔ 绝不直接信任 row.revealed 这一存储列。
 *
 * @param {object} row 迁移后的行
 * @param {string|null} contactCode 对方的中转码（仅在互相可见时才允许传入）
 */
export function toResponse(row, contactCode = null) {
  const r = normalizeConsent(row);
  // 再推导一次（不读 r.revealed / row.revealed），评审一眼能看出出口只信状态机
  const revealed = r.author_ok === 1 && r.seeker_ok === 1 ? 1 : 0;
  const base = {
    author_ok: r.author_ok,
    seeker_ok: r.seeker_ok,
    revealed,
  };
  // ⛔ 2026-10-31 起不再给"中转码"：双方都同意就**直接站内聊天**（服务器直连）
  if (revealed === 1) base.chat_ready = true;
  return base;
}

/** 供测试与自检：断言一个响应对象里是否"含有" contact_code 键（而不是判空） */
export function hasContactCodeKey(obj) {
  return obj != null && typeof obj === "object" && Object.hasOwn(obj, "contact_code");
}

export default {
  ROLES,
  REVEAL_STATUS,
  initialConsent,
  normalizeConsent,
  applyConsent,
  isMutual,
  isSettled,
  revealStatus,
  toResponse,
  hasContactCodeKey,
};
