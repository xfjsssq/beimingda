/**
 * 日程服务（M4）
 *   - 所有落库都走这里；MCP handler 与 HTTP 路由共用同一套逻辑（⛔ 不许各写一份）
 *   - 导入前必须先清空该用户旧课表（同一用户重复导入不叠加）
 *   - 所有写入都必须经过 scrub.js 的二次扫描
 */

import { randomUUID } from "node:crypto";
import { CODES, reject } from "../util/envelope.js";
import { nowSec, toIso } from "../util/time.js";
import { assertItemRanges, scrubScheduleItems, sanitizeTitle, writeAudit } from "./scrub.js";

/** 与 scripts/seed.js 一致的用户 id 策略 */
const userIdOf = (handle) => `demo-user-${handle}`;

function requireHandle(handle) {
  const h = String(handle ?? "").trim();
  if (!h) reject(CODES.SCHEMA_REJECTED, "user_handle 不能为空");
  if (h.length > 64) reject(CODES.SCHEMA_REJECTED, "user_handle 过长");
  return h;
}

/** 用户不存在就建（demo=1），与 seed 的 INSERT OR IGNORE 同策略 */
export function ensureUser(db, handle, now = nowSec()) {
  const h = requireHandle(handle);
  const id = userIdOf(h);
  db.prepare("INSERT OR IGNORE INTO users(id, handle, contact_code, created_at, demo) VALUES (?,?,?,?,1)").run(
    id,
    h,
    null,
    now,
  );
  return id;
}

/**
 * 导入课表：先清旧、再批量插，全程一个事务。
 * @returns {{ imported: number, dropped_fields: string[] }}
 */
export function importSchedule(db, { user_handle, items }, now = nowSec()) {
  const handle = requireHandle(user_handle);
  if (!Array.isArray(items)) reject(CODES.SCHEMA_REJECTED, "items 必须是数组");

  // service 层独立判一次区间（不假设上游校验过）
  assertItemRanges(items);

  const { clean, dropped } = scrubScheduleItems(items);
  const userId = ensureUser(db, handle, now);

  const run = db.transaction(() => {
    // ⚠️ DELETE 必须带 user_id，否则会清掉全站课表
    db.prepare("DELETE FROM schedule_items WHERE user_id = ?").run(userId);
    const ins = db.prepare(`INSERT INTO schedule_items
      (id,user_id,weekday,period_start,period_end,title,room,weeks,remind_before,created_at,demo)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`);
    for (const it of clean) {
      ins.run(
        randomUUID(),
        userId,
        Number(it.weekday),
        Number(it.period_start),
        Number(it.period_end),
        String(it.title),
        it.room == null ? null : String(it.room).slice(0, 50),
        it.weeks == null ? null : String(it.weeks).slice(0, 50),
        null,
        now,
      );
    }
    writeAudit(db, "schedule", dropped, now);
  });
  run();

  return { imported: clean.length, dropped_fields: dropped };
}

/**
 * 手动添加单条（页面兜底）。同样走 scrub，防止绕过 MCP schema。
 * @returns {{ item_id: string }}
 */
export function addScheduleItem(db, input, now = nowSec()) {
  const handle = requireHandle(input?.user_handle);

  // 顶层也可能夹带禁字段（HTTP 直接 POST）：按契约丢弃并记审计（只记字段名）
  const SELF_ALLOWED = new Set([
    "user_handle", "weekday", "period_start", "period_end", "title", "room", "weeks", "remind_before",
  ]);
  const extraDropped = Object.keys(input ?? {}).filter((k) => !SELF_ALLOWED.has(k));

  const raw = {
    weekday: input?.weekday,
    period_start: input?.period_start,
    period_end: input?.period_end,
    title: input?.title,
    room: input?.room,
    weeks: input?.weeks,
  };
  if (input?.remind_before !== undefined && input?.remind_before !== null) {
    const rb = Number(input.remind_before);
    if (!Number.isInteger(rb) || rb < 0 || rb > 1440) {
      reject(CODES.SCHEMA_REJECTED, "remind_before 必须是 0~1440 的整数");
    }
  }
  assertItemRanges([raw]);

  const { clean, dropped } = scrubScheduleItems([raw]);
  if (!clean.length) {
    writeAudit(db, "schedule", dropped.length ? dropped : ["invalid_item"], now);
    reject(CODES.SCHEMA_REJECTED, "该条记录不合法（字段被白名单过滤）");
  }

  const it = clean[0];
  const userId = ensureUser(db, handle, now);

  // upsert：同一门课（user+weekday+period_start+period_end+title）再次提交时只更新，
  // 不再插入重复条目 —— 页面「提醒设置」区块就是靠这个改 remind_before 的
  // （契约只有 3 条路由，没有 PATCH）。
  const existing = db
    .prepare(
      `SELECT id FROM schedule_items
       WHERE user_id = ? AND weekday = ? AND period_start = ? AND period_end = ? AND title = ?`,
    )
    .get(userId, Number(it.weekday), Number(it.period_start), Number(it.period_end), sanitizeTitle(it.title));

  if (existing) {
    // ⚠️ 只更新"请求里真的带了的"字段：页面「提醒设置」只提交 remind_before，
    // 若无条件 SET room/weeks 会把教室与周次清成 NULL（数据丢失）。
    const sets = [];
    const vals = [];
    if (input?.room !== undefined) {
      sets.push("room = ?");
      vals.push(it.room == null ? null : String(it.room).slice(0, 50));
    }
    if (input?.weeks !== undefined) {
      sets.push("weeks = ?");
      vals.push(it.weeks == null ? null : String(it.weeks).slice(0, 50));
    }
    if (input?.remind_before !== undefined) {
      sets.push("remind_before = ?");
      vals.push(input.remind_before == null ? null : Number(input.remind_before));
    }
    if (sets.length) {
      db.prepare(`UPDATE schedule_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals, existing.id);
    }
    writeAudit(db, "schedule", [...new Set([...dropped, ...extraDropped])], now);
    return { item_id: existing.id, updated: sets.length > 0 };
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO schedule_items
    (id,user_id,weekday,period_start,period_end,title,room,weeks,remind_before,created_at,demo)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(
    id,
    userId,
    Number(it.weekday),
    Number(it.period_start),
    Number(it.period_end),
    sanitizeTitle(it.title),
    it.room == null ? null : String(it.room).slice(0, 50),
    it.weeks == null ? null : String(it.weeks).slice(0, 50),
    input?.remind_before == null ? null : Number(input.remind_before),
    now,
  );
  writeAudit(db, "schedule", [...new Set([...dropped, ...extraDropped])], now);

  return { item_id: id, updated: false };
}

/** 查询：按 weekday、period_start 升序；只回白名单字段 */
export function querySchedule(db, { user_handle, weekday } = {}) {
  const handle = requireHandle(user_handle);
  const userId = userIdOf(handle);
  const rows =
    weekday == null
      ? db
          .prepare(
            `SELECT weekday,period_start,period_end,title,room,weeks,remind_before
             FROM schedule_items WHERE user_id = ? ORDER BY weekday, period_start`,
          )
          .all(userId)
      : db
          .prepare(
            `SELECT weekday,period_start,period_end,title,room,weeks,remind_before
             FROM schedule_items WHERE user_id = ? AND weekday = ? ORDER BY weekday, period_start`,
          )
          .all(userId, Number(weekday));

  return rows.map((r) => ({
    weekday: r.weekday,
    period_start: r.period_start,
    period_end: r.period_end,
    title: r.title,
    room: r.room,
    weeks: r.weeks,
    remind_before: r.remind_before,
  }));
}

/**
 * 单条详情（只读）。给评委点单条看详情用。
 * 只回 id + 白名单字段，不返回 user_id / created_at 等内部信息。
 */
export function getScheduleItem(db, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id) reject(CODES.SCHEMA_REJECTED, "item_id 不能为空");
  const r = db
    .prepare(
      `SELECT id,weekday,period_start,period_end,title,room,weeks,remind_before
       FROM schedule_items WHERE id = ?`,
    )
    .get(id);
  if (!r) reject(CODES.NOT_FOUND, "日程不存在");
  return {
    id: r.id,
    weekday: r.weekday,
    period_start: r.period_start,
    period_end: r.period_end,
    title: r.title,
    room: r.room,
    weeks: r.weeks,
    remind_before: r.remind_before,
  };
}

/** 删除单条；不存在 → NOT_FOUND */
export function removeScheduleItem(db, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id) reject(CODES.SCHEMA_REJECTED, "item_id 不能为空");
  const info = db.prepare("DELETE FROM schedule_items WHERE id = ?").run(id);
  if (info.changes === 0) reject(CODES.NOT_FOUND, "日程不存在");
  return { ok: true };
}

/** 脱敏审计（评委核验用）：只回字段名 */
export function listScrubAudit(db, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const rows = db
    .prepare("SELECT id,item_type,dropped_fields,created_at FROM scrub_audit ORDER BY id DESC LIMIT ?")
    .all(n);
  return rows.map((r) => {
    let dropped = [];
    try {
      const parsed = JSON.parse(r.dropped_fields);
      dropped = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      dropped = [];
    }
    return {
      id: r.id,
      item_type: r.item_type,
      dropped_fields: dropped,
      created_at: toIso(r.created_at),
    };
  });
}

/** 提醒用：取出所有设了提醒且当天有课的记录 */
export function listReminderCandidates(db, weekday) {
  return db
    .prepare(
      `SELECT id,user_id,weekday,period_start,period_end,title,room,weeks,remind_before
       FROM schedule_items
       WHERE remind_before IS NOT NULL AND remind_before >= 0 AND weekday = ?
       ORDER BY period_start`,
    )
    .all(Number(weekday));
}

export default {
  ensureUser,
  importSchedule,
  addScheduleItem,
  querySchedule,
  removeScheduleItem,
  listScrubAudit,
  listReminderCandidates,
};
