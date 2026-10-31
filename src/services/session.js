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
    // ⛔ 不再生成"中转码"（机制已废弃：双方同意后直接站内私聊）
      db.prepare("INSERT INTO users(id,handle,created_at,demo) VALUES (?,?,?,0)")
      .run(id, handle, nowSec());
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
    has_password: Boolean(user.pass_hash),
    // ⛔ 不再返回 contact_code（旧的中转码机制已废弃：双方同意后直接站内私聊）
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
      .prepare("SELECT s.token_hash, s.user_id, s.created_at, s.last_seen_at, u.handle " +
               "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(hash);
    if (!row) return null;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowSec(), hash);
    return {
      uid: row.user_id, handle: row.handle,
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
    has_password: Boolean(user.pass_hash),
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

/* ============================================================================
   账号密码（2026-10-31）
     · 密码只存 **scrypt 加盐哈希**（Node 内置，不引依赖）；库里没有明文、也没有可逆材料
     · 三种入口共用一套逻辑：
         匿名进（不带密码，行为不变） / 注册（昵称不存在→建号） /
         认领（昵称是匿名用户、还没设密码 → 首次设密码即认领） / 登录（已有密码 → 校验）
     · 连续失败限频：同一昵称 5 次/5 分钟 → 429
     · 依然不收集姓名/学号/手机号：账号只有"昵称 + 密码哈希"
   ========================================================================== */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const PW_MIN = 6;
const PW_MAX = 64;
const loginFails = new Map();          // nickname -> { count, until }

/** 密码规则：6~64 位，不能全是空白；不强制复杂度（校园场景别为难用户），但不能太短 */
export function validatePassword(raw) {
  const s = String(raw ?? "");
  if (!s.trim()) reject(CODES.SCHEMA_REJECTED, "密码不能为空");
  if (s.length < PW_MIN || s.length > PW_MAX) reject(CODES.SCHEMA_REJECTED, `密码请控制在 ${PW_MIN}~${PW_MAX} 位`);
  return s;
}

export function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), useSalt, 64, SCRYPT).toString("hex");
  return { salt: useSalt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const got = crypto.scryptSync(String(password), salt, 64, SCRYPT);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function throttled(nickname) {
  const rec = loginFails.get(nickname);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  loginFails.delete(nickname);
  return false;
}

function noteFail(nickname) {
  const rec = loginFails.get(nickname) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) rec.until = Date.now() + 5 * 60 * 1000;
  loginFails.set(nickname, rec);
}

function clearFail(nickname) {
  loginFails.delete(nickname);
}

function issueSession(user) {
  const db = getDb();
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,last_seen_at) VALUES (?,?,?,?)")
    .run(sha256(token), user.id, nowSec(), nowSec());
  return { token, uid: user.id, handle: user.handle, nickname: user.handle,
           has_password: Boolean(user.pass_hash), created_at: toIso(user.created_at) };
}

/**
 * 注册 / 认领 / 登录 / 匿名，四合一。
 *   不传密码 → 匿名开户（与原来完全一致）
 *   传密码 + 昵称不存在 → 注册
 *   传密码 + 昵称是匿名用户（没密码）→ 认领（设置密码）
 *   传密码 + 昵称已有密码 → 登录校验（错 5 次/5 分钟 → 429）
 */
export function registerOrLogin({ nickname, password } = {}) {
  const db = getDb();
  if (!password) return createSession({ nickname });          // 匿名路径不变

  const pw = validatePassword(password);
  const name = nickname ? validateNickname(nickname) : "";
  if (!name) reject(CODES.SCHEMA_REJECTED, "设置密码时必须同时给昵称");
  if (throttled(name)) reject(CODES.QUOTA, "密码错误次数过多，请 5 分钟后再试");

  const user = db.prepare("SELECT * FROM users WHERE handle = ?").get(name);
  if (!user) {                                                // 注册
    const created = ensureSessionUser(name);
    const { salt, hash } = hashPassword(pw);
    db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(hash, salt, created.id);
    return issueSession({ ...created, pass_hash: hash });
  }
  if (!user.pass_hash) {                                      // 认领匿名昵称
    const { salt, hash } = hashPassword(pw);
    db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(hash, salt, user.id);
    return issueSession({ ...user, pass_hash: hash });
  }
  if (!verifyPassword(pw, user.pass_salt, user.pass_hash)) {   // 登录失败
    noteFail(name);
    reject(CODES.SCHEMA_REJECTED, "昵称或密码不对");
  }
  clearFail(name);
  return issueSession(user);
}

/** 显式登录：必须已注册（给"换设备找回"用，错误信息更明确） */
export function loginWithPassword({ nickname, password } = {}) {
  const db = getDb();
  const name = validateNickname(nickname);
  const pw = validatePassword(password);
  if (throttled(name)) reject(CODES.QUOTA, "密码错误次数过多，请 5 分钟后再试");
  const user = db.prepare("SELECT * FROM users WHERE handle = ?").get(name);
  if (!user || !user.pass_hash) reject(CODES.NOT_FOUND, "这个昵称还没有设过密码（可以直接用昵称+新密码注册/认领）");
  if (!verifyPassword(pw, user.pass_salt, user.pass_hash)) {
    noteFail(name);
    reject(CODES.SCHEMA_REJECTED, "昵称或密码不对");
  }
  clearFail(name);
  return issueSession(user);
}

/** 改密码：已设过密码的要先给旧密码；没设过的（匿名用户）可直接设 */
export function setPassword(uid, { password, old_password } = {}) {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!user) reject(CODES.NOT_FOUND, "用户不存在");
  const pw = validatePassword(password);
  if (user.pass_hash && !verifyPassword(String(old_password ?? ""), user.pass_salt, user.pass_hash)) {
    reject(CODES.SCHEMA_REJECTED, "旧密码不对");
  }
  const { salt, hash } = hashPassword(pw);
  db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(hash, salt, uid);
  return { ...meView(uid), has_password: true };
}

export default { createSession, sessionFromToken, renameSessionUser, meView, validateNickname, ensureSessionUser,
  registerOrLogin, loginWithPassword, setPassword, validatePassword, hashPassword, verifyPassword };
