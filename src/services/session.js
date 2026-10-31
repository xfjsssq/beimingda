/**
 * 会话 / 匿名身份（2026-10-31）
 *
 * 为什么要有这一层：
 *   之前的站点是"一个人对着演示数据玩"——谁发的都看不出来，换个浏览器还是同一个人。
 *   要让站点真的活起来（两个浏览器能互相看见对方发的单/留言），必须先有**稳定的身份**。
 *
 * 合规口径（⛔ 不许破）：
 *   · 只发 **匿名 uid + 昵称**，不收集姓名/学号/手机号/校园网账号，也不存 IP
 *   · token 只存 **sha256**，库里拿不到明文；删一行 = 该会话立即失效
 *   · 昵称校验刻意拒绝"纯数字串 / 11 位以上连续数字"——避免看起来像学号或手机号
 *   · 昵称唯一（UNIQUE handle），重名会被拒并提示换一个
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { CODES, reject } from "../util/envelope.js";
import { nowSec, toIso } from "../util/time.js";

/** 昵称：2~12 个中文/字母/数字/下划线 */
const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,12}$/;

const newId = (prefix) => `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** 自动生成一个匿名昵称（用户不填也能立刻用） */
function randomHandle() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 4; i += 1) s += alphabet[crypto.randomInt(alphabet.length)];
  return `同学${s}`;
}

/** 校验昵称（合规：拒绝像学号/手机号的纯数字） */
export function validateNickname(raw) {
  const s = String(raw ?? "").trim();
  if (!s) reject(CODES.SCHEMA_REJECTED, "昵称不能为空");
  if (s.length < 2 || s.length > 12) reject(CODES.SCHEMA_REJECTED, "昵称请控制在 2~12 个字");
  if (!NICK_RE.test(s)) reject(CODES.SCHEMA_REJECTED, "昵称只能用中文、字母、数字、下划线");
  if (/^\d+$/.test(s)) reject(CODES.SCHEMA_REJECTED, "昵称不能是纯数字（避免看起来像学号/手机号）");
  if (/\d{11,}/.test(s)) reject(CODES.SCHEMA_REJECTED, "昵称里不能有 11 位以上的连续数字");
  return s;
}

/** 按 handle 找用户；没有就建一个 **demo=0 的真实用户**（不是演示数据） */
export function ensureSessionUser(handle) {
  const db = getDb();
  const existed = db.prepare("SELECT * FROM users WHERE handle = ?").get(handle);
  if (existed) return existed;
  const id = newId("u");
  try {
    db.prepare("INSERT INTO users(id,handle,contact_code,created_at,demo) VALUES (?,?,?,?,0)")
      .run(id, handle, crypto.randomBytes(6).toString("hex"), nowSec());
  } catch (e) {
    if (!/UNIQUE/i.test(String(e?.message))) throw e;      // 并发重名 → 读回已有的
    const again = db.prepare("SELECT * FROM users WHERE handle = ?").get(handle);
    if (again) return again;
    throw e;
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

/**
 * 建会话：POST /api/session
 *   · 不传昵称 → 自动给一个（同学xxxx），零门槛先能用
 *   · 传昵称 → 用它；重名会自动加后缀（先让人进来，改名时可再调）
 */
export function createSession({ nickname } = {}) {
  const db = getDb();
  let handle = nickname ? validateNickname(nickname) : randomHandle();
  if (db.prepare("SELECT 1 FROM users WHERE handle = ?").get(handle)) {
    handle = `${handle}${crypto.randomInt(100, 999)}`;
  }
  const user = ensureSessionUser(handle);
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,last_seen_at) VALUES (?,?,?,?)")
    .run(sha256(token), user.id, nowSec(), nowSec());
  return {
    token, uid: user.id, handle: user.handle, nickname: user.handle,
    created_at: toIso(user.created_at),
    contact_code: user.contact_code,
  };
}

/** 用 token 找回身份（顺带更新 last_seen_at）；无效返回 null，⛔ 不抛异常 */
export function sessionFromToken(token) {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length < 16) return null;
  try {
    const db = getDb();
    const hash = sha256(raw);
    const row = db
      .prepare("SELECT s.token_hash, s.user_id, s.created_at, s.last_seen_at, u.handle, u.contact_code " +
               "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(hash);
    if (!row) return null;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowSec(), hash);
    return {
      uid: row.user_id, handle: row.handle, contact_code: row.contact_code,
      created_at: toIso(row.created_at), last_seen_at: toIso(row.last_seen_at),
    };
  } catch {
    return null;
  }
}

/** 改昵称：PATCH /api/me（唯一性冲突给明确提示，不返回 INTERNAL） */
export function renameSessionUser(uid, nickname) {
  const db = getDb();
  const nick = validateNickname(nickname);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!user) reject(CODES.NOT_FOUND, "会话对应的用户不存在");
  if (user.handle === nick) return meView(uid);
  const taken = db.prepare("SELECT 1 FROM users WHERE handle = ? AND id <> ?").get(nick, uid);
  if (taken) reject(CODES.SCHEMA_REJECTED, `昵称「${nick}」已经有人用了，换一个吧`);
  db.prepare("UPDATE users SET handle = ? WHERE id = ?").run(nick, uid);
  return meView(uid);
}

/** 我的资料 + 我在站内的活动量（给首页/侧栏显示"你在这儿的痕迹"） */
export function meView(uid) {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!user) reject(CODES.NOT_FOUND, "用户不存在");
  const count = (sql, ...args) => {
    try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return 0; }
  };
  return {
    uid: user.id,
    nickname: user.handle,
    contact_code: user.contact_code,
    demo: Boolean(user.demo),
    created_at: toIso(user.created_at),
    stats: {
      tasks_published: count("SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?", uid),
      interests_expressed: count("SELECT COUNT(*) AS n FROM matches m JOIN runners r ON r.id = m.runner_id WHERE r.user_id = ?", uid),
      buddy_posts: count("SELECT COUNT(*) AS n FROM buddy_posts WHERE author_id = ?", uid),
      buddy_messages: count("SELECT COUNT(*) AS n FROM buddy_messages WHERE from_id = ?", uid),
      schedule_items: count("SELECT COUNT(*) AS n FROM schedule_items WHERE user_id = ?", uid),
    },
  };
}

export default { createSession, sessionFromToken, renameSessionUser, meView, validateNickname, ensureSessionUser };
