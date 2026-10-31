/**
 * 私聊（站内消息）—— 2026-10-31
 *
 * 为什么要它：
 *   以前"双方都同意"之后给一串**站内私聊**，让人自己拿去别的软件加好友 —— 既然数据都在我们服务器上，
 *   这一步纯属多余，而且把用户推出站外。现在改成：**双方都同意 → 站内直接开聊**。
 *
 * 谁能聊（严格）：
 *   · kind='task' ：该代取单 matches.state='accepted' → 发布者 ↔ 接单者
 *   · kind='buddy'：该搭子帖 buddy_consents.revealed=1（双方都点头）→ 帖主 ↔ 申请者
 *   ⛔ 其它任何人、任何未达成一致的关系，都拿不到会话（service 层校验，不是前端藏按钮）
 *
 * 会话是"按需物化"的：读列表时把符合条件的关系 upsert 成 threads，因此不需要额外的建群流程。
 * ⛔ 表里不存任何联系方式：聊天就在站内。
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { CODES, reject } from "../util/envelope.js";
import { nowSec, toIso } from "../util/time.js";

const newId = (p) => `${p}_${crypto.randomUUID()}`;
const MAX_LEN = 500;

/** 物化：把"已达成一致"的关系变成会话行（幂等） */
export function ensureThreads(uid) {
  const db = getDb();
  const now = nowSec();

  // ① 代取：matches.accepted → 发布者 ↔ 接单者
  const taskPairs = db.prepare(
    `SELECT t.id AS ref_id, t.owner_id AS a_uid, r.user_id AS b_uid
     FROM matches m
     JOIN tasks t   ON t.id = m.task_id
     JOIN runners r ON r.id = m.runner_id
     WHERE m.state = 'accepted' AND (t.owner_id = @uid OR r.user_id = @uid)`,
  ).all({ uid });

  // ② 搭子：双方都同意（revealed=1）→ 帖主 ↔ 申请者
  const buddyPairs = db.prepare(
    `SELECT p.id AS ref_id, p.author_id AS a_uid, c.seeker_id AS b_uid
     FROM buddy_consents c
     JOIN buddy_posts p ON p.id = c.post_id
     WHERE c.revealed = 1 AND (p.author_id = @uid OR c.seeker_id = @uid)`,
  ).all({ uid });

  const ins = db.prepare(
    `INSERT OR IGNORE INTO threads(id,kind,ref_id,a_uid,b_uid,created_at) VALUES (?,?,?,?,?,?)`,
  );
  for (const [kind, rows] of [["task", taskPairs], ["buddy", buddyPairs]]) {
    for (const r of rows) {
      if (!r.a_uid || !r.b_uid || r.a_uid === r.b_uid) continue;
      ins.run(newId("th"), kind, r.ref_id, r.a_uid, r.b_uid, now);
    }
  }
}

/** 按"搭子帖 + 双方都同意"物化会话（返回 thread_id 或 null）——替代旧的站内私聊机制（已废弃） */
export function ensureThreadForBuddy(postId) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.author_id AS a_uid, c.seeker_id AS b_uid
     FROM buddy_consents c JOIN buddy_posts p ON p.id = c.post_id
     WHERE c.post_id = ? AND c.revealed = 1`,
  ).all(String(postId ?? ""));
  let last = null;
  for (const r of rows) {
    if (!r.a_uid || !r.b_uid || r.a_uid === r.b_uid) continue;
    db.prepare("INSERT OR IGNORE INTO threads(id,kind,ref_id,a_uid,b_uid,created_at) VALUES (?,?,?,?,?,?)")
      .run(`${newId("th")}`, "buddy", String(postId), r.a_uid, r.b_uid, nowSec());
    last = db.prepare(
      "SELECT id FROM threads WHERE kind='buddy' AND ref_id = ? AND a_uid = ? AND b_uid = ?",
    ).get(String(postId), r.a_uid, r.b_uid);
  }
  return last ? last.id : null;
}

/** 按"代取单已接单"物化会话 */
export function ensureThreadForTask(taskId) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.owner_id AS a_uid, r.user_id AS b_uid
     FROM matches m JOIN tasks t ON t.id = m.task_id JOIN runners r ON r.id = m.runner_id
     WHERE m.task_id = ? AND m.state = 'accepted'`,
  ).all(String(taskId ?? ""));
  let last = null;
  for (const r of rows) {
    if (!r.a_uid || !r.b_uid || r.a_uid === r.b_uid) continue;
    db.prepare("INSERT OR IGNORE INTO threads(id,kind,ref_id,a_uid,b_uid,created_at) VALUES (?,?,?,?,?,?)")
      .run(`${newId("th")}`, "task", String(taskId), r.a_uid, r.b_uid, nowSec());
    last = db.prepare(
      "SELECT id FROM threads WHERE kind='task' AND ref_id = ? AND a_uid = ? AND b_uid = ?",
    ).get(String(taskId), r.a_uid, r.b_uid);
  }
  return last ? last.id : null;
}

/**
 * 某人 + 某帖 → 属于他的会话 id（用于接口里附 chat_ready/thread_id）
 * ⭐ 幂等：找不到就顺手建一个（调用方只需调一次，不依赖"上一步已建好"）
 */
export function threadIdForBuddy(postId, uid) {
  const db = getDb();
  const find = () => db.prepare(
    "SELECT id FROM threads WHERE kind='buddy' AND ref_id = ? AND (a_uid = ? OR b_uid = ?) LIMIT 1",
  ).get(String(postId ?? ""), uid, uid);
  let row = find();
  if (!row) {
    ensureThreadForBuddy(postId);
    row = find();
  }
  return row ? row.id : null;
}

/** 会话列表：对方是谁、聊的哪一单/哪一帖、最后一条消息 */
export function listThreads(uid, { limit = 50 } = {}) {
  ensureThreads(uid);
  const db = getDb();
  const rows = db.prepare(
    `SELECT th.*,
            CASE WHEN th.a_uid = @uid THEN th.b_uid ELSE th.a_uid END AS peer_uid,
            u.handle AS peer_handle,
            (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = th.id) AS msg_count,
            (SELECT m.body  FROM thread_messages m WHERE m.thread_id = th.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_body,
            (SELECT m.from_uid FROM thread_messages m WHERE m.thread_id = th.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_from,
            (SELECT m.created_at FROM thread_messages m WHERE m.thread_id = th.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_at
     FROM threads th
     JOIN users u ON u.id = CASE WHEN th.a_uid = @uid THEN th.b_uid ELSE th.a_uid END
     WHERE th.a_uid = @uid OR th.b_uid = @uid
     ORDER BY COALESCE(last_at, th.created_at) DESC, th.rowid DESC
     LIMIT @limit`,
  ).all({ uid, limit: Number(limit) || 50 });

  return rows.map((r) => ({
    thread_id: r.id,
    kind: r.kind,
    ref_id: r.ref_id,
    subject: subjectOf(r.kind, r.ref_id),
    peer: { uid: r.peer_uid, nickname: r.peer_handle, avatar: avatarOf(r.peer_uid) },
    message_count: r.msg_count,
    last_message: r.last_body === null ? null : {
      body: r.last_body, mine: r.last_from === uid, at: toIso(r.last_at),
    },
    created_at: toIso(r.created_at),
  }));
}

/** 关联对象摘要（代取单 / 搭子帖）：聊天时顶部悬浮显示"我们到底在聊哪一单" */
export function subjectOf(kind, refId) {
  const db = getDb();
  if (kind === "task") {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(refId);
    if (!t) return null;
    return { kind, ref_id: refId, title: `${t.from_building} → ${t.to_building}`,
             subtitle: `取件点：${t.station} · 报酬 ¥${t.reward_min}-${t.reward_max}`,
             status: t.raw_status, deadline: toIso(t.deadline_ts) };
  }
  const p = db.prepare("SELECT * FROM buddy_posts WHERE id = ?").get(refId);
  if (!p) return null;
  return { kind, ref_id: refId, title: p.kind ? `搭子 · ${p.kind}` : "搭子",
           subtitle: (p.text_profile || p.description || "").slice(0, 60),
           status: p.raw_status, deadline: null };
}

const avatarOf = (uid) => {
  const keys = ["panda", "cat", "fox", "owl", "whale", "deer", "robot", "leaf"];
  let h = 0;
  for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return keys[h % keys.length];
};

/** 取会话并校验"我确实是双方之一" */
export function getThread(threadId, uid) {
  ensureThreads(uid);
  const db = getDb();
  const th = db.prepare("SELECT * FROM threads WHERE id = ?").get(String(threadId ?? ""));
  if (!th) reject(CODES.NOT_FOUND, "会话不存在");
  if (th.a_uid !== uid && th.b_uid !== uid) {
    reject(CODES.SCHEMA_REJECTED, "这个会话与你无关（只有双方都同意之后才能聊）");
  }
  const peerUid = th.a_uid === uid ? th.b_uid : th.a_uid;
  const peer = db.prepare("SELECT id, handle FROM users WHERE id = ?").get(peerUid);
  return {
    thread_id: th.id, kind: th.kind, ref_id: th.ref_id,
    subject: subjectOf(th.kind, th.ref_id),
    peer: { uid: peerUid, nickname: peer?.handle || "对方", avatar: avatarOf(peerUid) },
    created_at: toIso(th.created_at),
  };
}

export function listThreadMessages(threadId, uid, { after, limit = 200 } = {}) {
  const th = getThread(threadId, uid);                 // 顺带鉴权
  const db = getDb();
  const rows = db.prepare(
    `SELECT m.*, u.handle AS from_handle FROM thread_messages m
     JOIN users u ON u.id = m.from_uid
     WHERE m.thread_id = ? ORDER BY m.created_at ASC, m.rowid ASC LIMIT ?`,
  ).all(th.thread_id, Number(limit) || 200);
  const list = rows.map((m) => ({
    message_id: m.id, body: m.body, kind: m.kind, mine: m.from_uid === uid,
    from: { uid: m.from_uid, nickname: m.from_handle, avatar: avatarOf(m.from_uid) },
    at: toIso(m.created_at),
  }));
  if (!after) return list;
  const idx = list.findIndex((m) => m.message_id === after);
  return idx >= 0 ? list.slice(idx + 1) : list;
}

export function postThreadMessage(threadId, uid, body) {
  const th = getThread(threadId, uid);                 // 鉴权
  const text = String(body ?? "").trim();
  if (!text) reject(CODES.SCHEMA_REJECTED, "消息不能为空");
  if (text.length > MAX_LEN) reject(CODES.SCHEMA_REJECTED, `一条消息最多 ${MAX_LEN} 个字`);
  const db = getDb();
  const id = newId("msg");
  const isEmoji = !/[\u4e00-\u9fa5A-Za-z0-9]/.test(text);      // 纯表情
  db.prepare("INSERT INTO thread_messages(id,thread_id,from_uid,body,kind,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, th.thread_id, uid, text, isEmoji ? "emoji" : "text", nowSec());
  return {
    message_id: id, body: text, kind: isEmoji ? "emoji" : "text", mine: true,
    from: { uid, nickname: null, avatar: avatarOf(uid) }, at: toIso(nowSec()),
  };
}

export default { ensureThreads, ensureThreadForBuddy, ensureThreadForTask, threadIdForBuddy, listThreads, getThread, listThreadMessages, postThreadMessage, subjectOf };
