/**
 * 搭子匹配 service（M2）
 *
 *   ⭐ 本文件是 M2 的**唯一业务逻辑落脚点**：MCP 3 个工具与 HTTP 2 条路由都调这里，
 *     ⛔ 不允许各写一套（contracts/core.md §3）。
 *
 *   契约：
 *     · contracts/m2-buddy.md §3 双选状态机（状态迁移在 engine/doubleOpt.js，本文件只负责落库与身份解析）
 *     · contracts/m2-buddy.md §5 HTTP（GET/POST /api/buddies）
 *     · contracts/core.md §3 时间：存库 Unix 秒 / 出接口 ISO
 *
 *   ⛔ 三条红线（评审对照用）
 *     1. anon_token 随机生成，**不得由 user_id 派生**
 *     2. 未双选成功不返回 chat_ready（⛔ 也不再有"站内私聊"：双方同意后直接站内私聊）
 *     3. 结果里不出现院系全名 / 班级 / 学号 / 宿舍号 / 真实姓名
 *        —— 对外字段一律走白名单投影（safePost / safeCandidate）
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { nowSec, toIso } from "../util/time.js";
import { CODES, reject, assertNoExtraKeys } from "../util/envelope.js";
import {
  KINDS,
  buddyScore,
  extractProfile,
  meetsThreshold,
  normalizeProfile,
  scoreCandidate,
  llmEnabled,
} from "../engine/buddy.js";
import {
  ROLES,
  applyConsent,
  initialConsent,
  normalizeConsent,
  revealStatus,
  toResponse,
} from "../engine/doubleOpt.js";

/** 对外字段白名单：候选/帖子只允许出现这些键（⛔ 任何身份字段都进不来） */
export const SAFE_POST_KEYS = Object.freeze([
  "post_id",
  "anon_token",
  "kind",
  "profile",
  "created_at",
]);
export const SAFE_CANDIDATE_KEYS = Object.freeze([
  "post_id",
  "anon_token",
  "kind",
  "score",
  "reason",
  "reveal_status",
  "parts",
  "chat_ready",
  "thread_id",
]);

/** publishPost 允许的入参（HTTP 侧 additionalProperties:false 的等价实现） */
const PUBLISH_KEYS = ["author_handle", "kind", "text_profile", "photo_path"];

const HANDLE_MAX = 32;
const SEARCH_POOL = () => (llmEnabled() ? 30 : 200); // 单次响应必须 < 90 秒（CF 隧道），LLM 路径收窄候选池

// ──────────────────────────── 匿名标识 ────────────────────────────

/**
 * 匿名标识：随机 12 位十六进制。
 * ⛔ 绝不用 hash(user_id) / user_id.slice() 这类可反推的派生方式。
 */
/** 入参校验（本模块自带一份，⛔ 不与 task.js 互相依赖） */
function requiredText(value, label, maxLen = 60) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) reject(CODES.SCHEMA_REJECTED, `${label} 不能为空`);
  if (text.length > maxLen) reject(CODES.SCHEMA_REJECTED, `${label} 过长（≤ ${maxLen} 字符）`);
  return text;
}

function clampLimit(value, fallback = 50, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function anonToken() {
  return `anon_${crypto.randomBytes(6).toString("hex")}`;
}

/** 匿名站内私聊（不是手机号/微信，双选成功后下发的对接凭据） */
export function newContactCode() {
  return `ct_${crypto.randomBytes(4).toString("hex")}`;
}

const newId = (prefix) => `${prefix}-${crypto.randomBytes(8).toString("hex")}`;

// ──────────────────────────── 用户与身份（只收匿名昵称） ────────────────────────────

function assertHandle(handle, label = "handle") {
  const h = String(handle ?? "").trim();
  if (!h) reject(CODES.SCHEMA_REJECTED, `${label} 不能为空`);
  if (h.length > HANDLE_MAX) reject(CODES.SCHEMA_REJECTED, `${label} 最长 ${HANDLE_MAX} 个字符`);
  // 合规：只收匿名昵称，不收集真实身份/联系方式
  if (/@/.test(h) || /\d{8,}/.test(h) || /^(1[3-9]\d{9})$/.test(h)) {
    reject(CODES.SCHEMA_REJECTED, `${label} 只能是匿名昵称：不接受邮箱 / 学号 / 手机号形态`);
  }
  return h;
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) {
    reject(CODES.SCHEMA_REJECTED, `kind 必须是 ${KINDS.join(" / ")} 之一，收到: ${String(kind)}`);
  }
  return kind;
}

export function findUser(handle) {
  return getDb().prepare("SELECT id, handle FROM users WHERE handle = ?").get(handle) ?? null;
}

/** 写入路径用：昵称不存在则建（user_id 随机，与昵称无推导关系） */
export function ensureUser(handle) {
  const existed = findUser(handle);
  if (existed) return existed;
  getDb()
    // ⛔ 2026-10-31 起不再生成"站内私聊"（机制已废弃：双方同意后直接站内私聊）
    .prepare("INSERT OR IGNORE INTO users(id,handle,created_at,demo) VALUES (?,?,?,1)")
    .run(newId("u"), handle, nowSec());
  const created = findUser(handle);
  if (!created) reject(CODES.INTERNAL, "用户创建失败");
  return created;
}

const findUserById = (id) =>
  getDb().prepare("SELECT id, handle FROM users WHERE id = ?").get(id) ?? null;

// ──────────────────────────── 进程内缓存（表决时复用打分上下文） ────────────────────────────

const CACHE_MAX = 500;
const profileCache = new Map(); // user_id -> { profile, at }
const handleProfileCache = new Map(); // 昵称 -> { profile, at }（读路径不建用户，靠昵称兜底）
const pairScoreCache = new Map(); // `${post_id}:${seeker_id}` -> score

function cacheSet(map, key, value) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, value);
}

function parseProfile(row) {
  try {
    return normalizeProfile(JSON.parse(row.profile_json), row.kind);
  } catch {
    return normalizeProfile(null, row.kind);
  }
}

/** 白名单投影：只允许 SAFE_POST_KEYS 里的键出去 */
function safePost(row) {
  const p = parseProfile(row);
  return {
    post_id: row.id,
    anon_token: row.anon_token,
    kind: p.kind,
    profile: p,
    created_at: toIso(row.created_at),
  };
}

// ──────────────────────────── 帖子 ────────────────────────────

/**
 * 底层建帖（显式画像）—— 供单测 / 演示数据使用。
 * 对外入口一律走 publishPost（服务端负责把自然语言抽取成 §1 画像）。
 */
export function createPost({ author_handle, kind, profile, anon_token, raw_status = "open" } = {}) {
  const handle = assertHandle(author_handle, "author_handle");
  const k = assertKind(kind);
  const user = ensureUser(handle);
  const finalProfile = normalizeProfile({ ...(profile ?? {}), kind: k }, k);
  if (!finalProfile.wanted) {
    reject(CODES.SCHEMA_REJECTED, "画像缺少 wanted：请说清「想找什么样的搭子」（契约 §7 必填）");
  }
  const id = newId("post");
  const token = anon_token || anonToken(); // ⛔ 随机，不由 user_id 派生
  getDb()
    .prepare(
      `INSERT INTO buddy_posts(id,author_id,kind,profile_json,anon_token,raw_status,created_at,demo)
       VALUES (?,?,?,?,?,?,?,1)`,
    )
    .run(id, user.id, finalProfile.kind, JSON.stringify(finalProfile), token, raw_status, nowSec());
  return { post_id: id, anon_token: token, profile: finalProfile };
}

/**
 * 发布搭子帖：服务端把 text_profile 抽取成 §1 的 11 字段画像。
 * @returns {{post_id:string, anon_token:string, profile:object}}
 */
export async function publishPost(input = {}) {
  assertNoExtraKeys(input, PUBLISH_KEYS, "buddy_publish");
  const { author_handle, kind, text_profile } = input;
  const handle = assertHandle(author_handle, "author_handle");
  const k = assertKind(kind);

  // 照片：契约 §6 允许用户选图，但 §7 明令「照片不进评分」，且 buddy_posts 表里没有照片列
  // -> 这里只接收 photo_path 这个参数名，既不落库也不参与任何打分。
  const profile = await extractProfile(String(text_profile ?? ""), k);
  if (!profile.wanted) {
    reject(CODES.SCHEMA_REJECTED, "缺少 wanted：请在描述里说清「想找什么样的搭子」（契约 §7：kind 与 wanted 必填）");
  }
  return createPost({ author_handle: handle, kind: k, profile });
}

/** 搭子墙列表：GET /api/buddies?kind= —— 仅暴露 anon_token / 画像 / 时间，无 user_id */
export function listPosts({ kind, limit } = {}) {
  const db = getDb();
  const lim = Math.min(100, Math.max(1, Math.round(Number(limit) || 50)));
  const rows = kind
    ? db
        .prepare(
          `SELECT * FROM buddy_posts WHERE raw_status='open' AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(assertKind(kind), lim)
    : db
        .prepare(`SELECT * FROM buddy_posts WHERE raw_status='open' ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(lim);
  return rows.map(safePost);
}

// ──────────────────────────── 候选检索（评分 + 双选状态） ────────────────────────────

function normalizeTopK(v) {
  const raw = v == null || v === "" ? 5 : v; // 未传 / 传空 -> 契约默认 5
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 20) {
    reject(CODES.SCHEMA_REJECTED, "top_k 必须是 1..20 之间的整数（默认 5）");
  }
  return n;
}

/**
 * 检索候选：kind 一致 + 未被一票否决 + score >= 60（契约 §2 阈值）
 * @returns {{candidates:Array<{post_id,anon_token,kind,score,reason,reveal_status,parts,chat_ready?,thread_id?}>}}
 */
export async function searchBuddies({ seeker_handle, kind, text_profile, top_k } = {}) {
  const handle = assertHandle(seeker_handle, "seeker_handle");
  const k = assertKind(kind);
  const topK = normalizeTopK(top_k);

  const seekerProfile = await extractProfile(String(text_profile ?? ""), k);
  if (!seekerProfile.wanted) {
    reject(CODES.SCHEMA_REJECTED, "缺少 wanted：请把「想找什么样的搭子」说清楚");
  }

  const db = getDb();
  // 读路径不建用户：读接口保持只读（没建过用户 => 无历史表决 => 一律 pending）
  const seeker = findUser(handle);
  // 记住本次搜索用的画像：随后 buddy_consent 落库时要写 score（表现在 NOT NULL），
  // 优先用这里缓存的分/画像，避免用中性画像算出一个和候选列表不一致的分。
  cacheSet(handleProfileCache, handle, { profile: seekerProfile, at: nowSec() });
  if (seeker) cacheSet(profileCache, seeker.id, { profile: seekerProfile, at: nowSec() });

  const rows = db
    .prepare(`SELECT * FROM buddy_posts WHERE raw_status='open' ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(SEARCH_POOL());

  const scored = await Promise.all(
    rows.map(async (row) => {
      const postProfile = parseProfile(row);
      if (postProfile.kind !== k) return null; // kind 不一致 -> 出局
      const result = await scoreCandidate(postProfile, seekerProfile);
      if (result.vetoed || !meetsThreshold(result.score)) return null; // 一票否决 / 低于阈值 -> 不返回
      const consent = seeker
        ? db.prepare("SELECT * FROM buddy_consents WHERE post_id = ? AND seeker_id = ?").get(row.id, seeker.id)
        : null;
      const status = revealStatus(consent ?? initialConsent());

      const candidate = {
        post_id: row.id,
        anon_token: row.anon_token,
        kind: postProfile.kind,
        score: result.score,
        reason: result.reason,
        reveal_status: status,
        parts: result.parts,
      };
      if (status === "mutual") {
        // ⛔ 只有双方都同意（revealed=1）才附带 chat_ready / thread_id
        // ⛔ 不再输出站内私聊：双方同意后可聊（candidate 里改为 chat_ready / thread_id，见下）
      candidate.chat_ready = true;
    candidate.thread_id = threadIdForBuddy(row.id, seeker?.id) || null;
      }
      if (seeker) cacheSet(pairScoreCache, `${row.id}:${seeker.id}`, result.score);
      return candidate;
    }),
  );

  const candidates = scored.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, topK);
  return { candidates };
}

// ──────────────────────────── 双选表决（契约 §3） ────────────────────────────

/**
 * 表决入口（MCP `buddy_consent` 与页面共用）。
 *
 *   seeker_handle 是**当前表态人的匿名昵称**（契约 §4.3 只给这一个身份字段）：
 *     · 昵称 = 帖作者  -> 记为发布方表决（author_ok）
 *     · 其它昵称        -> 记为寻找方表决（seeker_ok），落一行 buddy_consents
 *   ⛔ 同一 (post_id, seeker_id) 只能表决一次 —— 由 DB 的 UNIQUE(post_id, seeker_id) 保证
 *
 * @returns {{author_ok:number, seeker_ok:number, revealed:number, chat_ready?, thread_id?}}
 *          ⛔ revealed=0 时不出现 chat_ready / thread_id（旧的站内私聊已废弃）
 */
export function castConsent({ post_id, seeker_handle, agree } = {}) {
  const handle = assertHandle(seeker_handle, "seeker_handle");
  if (typeof agree !== "boolean") reject(CODES.SCHEMA_REJECTED, "agree 必须是布尔值");

  const db = getDb();
  const post = db.prepare("SELECT * FROM buddy_posts WHERE id = ?").get(String(post_id ?? ""));
  if (!post) reject(CODES.NOT_FOUND, `帖子不存在: ${String(post_id ?? "")}`);
  if (post.raw_status !== "open") reject(CODES.SCHEMA_REJECTED, "该帖已关闭，不能再表决");

  const actor = ensureUser(handle);
  const author = findUserById(post.author_id);
  if (author && author.id === actor.id) return authorVote(post, author, agree);
  return seekerVote(post, actor, author, handle, agree);
}

/**
 * 统一出口：状态机结果 + （双方同意时）站内私聊会话
 *   ⭐ 会话在这里建，MCP 与 HTTP 两条路都会建（之前在 HTTP 路由里建，MCP 就走不到）
 *   ⛔ 不再返回任何"站内私聊"：双方同意 → 直接给 thread_id 开聊
 */
function responseWithChat(post, state, uid) {
  const out = toResponse(state);
  if (out.chat_ready) {
    try { out.thread_id = threadIdForBuddy(post.id, uid); } catch { out.thread_id = null; }
  }
  return out;
}

/** 寻找方表决：落 buddy_consents 一行（含拒绝 —— 拒绝即终止） */
function seekerVote(post, actor, author, handle, agree) {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM buddy_consents WHERE post_id = ? AND seeker_id = ?")
    .get(post.id, actor.id);
  if (existing) {
    reject(
      CODES.SCHEMA_REJECTED,
      `同一帖只能表决一次（UNIQUE(post_id,seeker_id)）：已于 ${toIso(existing.created_at)} 表决过，不可改票`,
    );
  }

  const postProfile = parseProfile(post);
  const cached = pairScoreCache.get(`${post.id}:${actor.id}`);
  const seekerProfile =
    profileCache.get(actor.id)?.profile ??
    handleProfileCache.get(handle)?.profile ??
    normalizeProfile(null, post.kind);
  const score = Number.isFinite(cached) ? cached : buddyScore(postProfile, seekerProfile).score;

  const next = applyConsent(initialConsent(), ROLES.SEEKER, agree);
  try {
    db.prepare(
      `INSERT INTO buddy_consents(id,post_id,seeker_id,score,author_ok,seeker_ok,revealed,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(newId("consent"), post.id, actor.id, score, next.author_ok, next.seeker_ok, next.revealed, nowSec());
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message))) {
      reject(CODES.SCHEMA_REJECTED, "同一 (post_id, seeker_id) 只能表决一次（数据库 UNIQUE 约束）");
    }
    throw e;
  }

  // 寻找方单独同意时 author_ok 保持 0 => revealed 必为 0 => 不给聊天入口
  return responseWithChat(post, next, actor.id);   // 双方同意 → 直接给私聊会话
}

/** 进程内：作者对某条意愿只能表态一次（同意态另有 author_ok=1 的持久化判据） */
const authorVoted = new Set();

/** 发布方表决：只能作用在"寻找方已同意"的意愿上；对方拒绝过 => 已终止 */
function authorVote(post, author, agree) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM buddy_consents WHERE post_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(post.id);
  if (!rows.length) {
    reject(CODES.NOT_FOUND, "该帖还没有任何人表态，发布方暂无可同意的对象");
  }

  const target = rows.find((r) => r.seeker_ok === 1) ?? rows[0];
  if (target.seeker_ok !== 1) {
    // 任一方拒绝即终止
    reject(CODES.SCHEMA_REJECTED, "对方已拒绝，该意愿已终止，不能再表决");
  }

  const voteKey = `${post.id}:${target.seeker_id}`;
  if (target.author_ok === 1 || authorVoted.has(voteKey)) {
    reject(CODES.SCHEMA_REJECTED, "发布方对该意愿已经表决过，不可改票");
  }

  const next = applyConsent(target, ROLES.AUTHOR, agree);
  db.prepare("UPDATE buddy_consents SET author_ok = ?, revealed = ? WHERE id = ?").run(
    next.author_ok,
    next.revealed,
    target.id,
  );
  authorVoted.add(voteKey);

  const seekerUser = findUserById(target.seeker_id);
  return responseWithChat(post, next, author.id);  // 双方同意 → 直接给私聊会话
}

/** 我发出的意愿（页面区块四）：⛔ 不暴露对方的个人表决位，只给 pending / mutual */
export function myApplications({ seeker_handle, limit } = {}) {
  const handle = assertHandle(seeker_handle, "seeker_handle");
  const user = findUser(handle);
  if (!user) return [];
  const lim = Math.min(100, Math.max(1, Math.round(Number(limit) || 50)));
  const rows = getDb()
    .prepare(
      `SELECT c.post_id, c.score, c.author_ok, c.seeker_ok, c.revealed, c.created_at, p.anon_token, p.kind
       FROM buddy_consents c JOIN buddy_posts p ON p.id = c.post_id
       WHERE c.seeker_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
    )
    .all(user.id, lim);
  return rows.map((r) => {
    // ⛔ 以状态机推导为准：不把存储列 revealed 原样透出去（脏数据防线）
    const derived = normalizeConsent(r);
    return {
      post_id: r.post_id,
      anon_token: r.anon_token,
      kind: r.kind,
      score: r.score,
      my_ok: derived.seeker_ok,
      revealed: derived.revealed,
      reveal_status: revealStatus(derived),
      created_at: toIso(r.created_at),
    };
  });
}

export default {
  anonToken,
  newContactCode,
  findUser,
  ensureUser,
  createPost,
  publishPost,
  listPosts,
  searchBuddies,
  castConsent,
  myApplications,
  SAFE_POST_KEYS,
  SAFE_CANDIDATE_KEYS,
};


/* =============================================================================
   站内留言 / 回复（2026-10-30 · 用户要求"在站点里就能发帖、留言、回复、接受"）
     · postMessage：给某个帖子留言；带上 consent_id 就是回复某一条"表达意愿"
     · listMessages：帖子下的留言与回复（按时间升序）
     · myConsole：我的申请三块 —— 我发布的帖（含收到的留言）/ 我表达的意愿 / 已互相同意
   ============================================================================= */

export function postMessage({ post_id, consent_id = null, from_handle, to_handle = null, body, kind = "message" } = {}) {
  const postId = requiredText(post_id, "post_id");
  const text = requiredText(body, "留言内容", 300);
  const from = requiredText(from_handle, "handle");
  const db = getDb();
  const post = db.prepare("SELECT id, author_id, raw_status FROM buddy_posts WHERE id = ?").get(postId);
  if (!post) reject(CODES.NOT_FOUND, `post not found: ${postId}`);
  if (post.raw_status !== "open") reject(CODES.SCHEMA_REJECTED, "这个帖子已经关闭了，不能再留言");

  const fromId = ensureUser(from).id;             // ⚠️ 本模块的 ensureUser 返回对象，不是 id
  const toId = to_handle ? ensureUser(to_handle).id : null;
  const id = `msg_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO buddy_messages(id, post_id, consent_id, from_id, to_id, kind, body, created_at)
     VALUES (@id, @post_id, @consent_id, @from_id, @to_id, @kind, @body, @created_at)`,
  ).run({
    id, post_id: postId, consent_id: consent_id ?? null, from_id: fromId,
    to_id: toId ?? null, kind, body: text, created_at: nowSec(),
  });
  return { message_id: id, post_id: postId, consent_id, kind, body: text, at: toIso(nowSec()) };
}

export function listMessages(postId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT m.id, m.post_id, m.consent_id, m.kind, m.body, m.created_at,
              uf.handle AS from_handle, ut.handle AS to_handle
         FROM buddy_messages m
         JOIN users uf ON uf.id = m.from_id
         LEFT JOIN users ut ON ut.id = m.to_id
        WHERE m.post_id = ?
        ORDER BY m.created_at ASC`,
    )
    .all(String(postId))
    .map((m) => ({
      message_id: m.id,
      post_id: m.post_id,
      consent_id: m.consent_id,
      kind: m.kind,
      body: m.body,
      from: m.from_handle,
      to: m.to_handle,
      at: toIso(m.created_at),
    }));
}

/** 我的申请（三块）：posts=我发布的（含收到的留言）/ intents=我表达的意愿（含回复）/ mutual=已互相同意 */
export function myConsole({ handle, limit = 50 } = {}) {
  const me = requiredText(handle, "handle");
  const db = getDb();
  const myId = ensureUser(me).id;                 // ⚠️ 同上
  const lt = clampLimit ? clampLimit(limit, 50, 200) : 50;

  const posts = db
    .prepare(
      `SELECT id, kind, profile_json, anon_token, raw_status, created_at
         FROM buddy_posts WHERE author_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(myId, lt)
    .map((p) => {
      const cons = db
        .prepare(
          `SELECT c.id, c.score, c.author_ok, c.seeker_ok, c.revealed, c.created_at,
                  us.handle AS seeker_handle
             FROM buddy_consents c JOIN users us ON us.id = c.seeker_id
            WHERE c.post_id = ? ORDER BY c.created_at DESC`,
        )
        .all(p.id)
        .map((c) => ({
          consent_id: c.id,
          seeker: c.seeker_handle,
          score: c.score,
          status: c.revealed === 1 ? "mutual" : c.author_ok === 1 ? "accepted" : "pending",
          at: toIso(c.created_at),
          messages: listMessages(p.id).filter((m) => m.consent_id === c.id),
        }));
      return {
        post_id: p.id,
        kind: p.kind,
        anon_token: p.anon_token,
        status: p.raw_status,
        profile: safeParse(p.profile_json),
        at: toIso(p.created_at),
        consents: cons,
        messages: listMessages(p.id).filter((m) => !m.consent_id),
      };
    });

  const intents = myApplications({ seeker_handle: me, limit: lt });

  const mutual = db
    .prepare(
      `SELECT c.id, c.post_id, c.seeker_ok, c.author_ok, c.revealed, c.created_at, p.kind, p.anon_token
         FROM buddy_consents c JOIN buddy_posts p ON p.id = c.post_id
        WHERE c.seeker_id = ? AND c.revealed = 1 ORDER BY c.created_at DESC`,
    )
    .all(myId)
    .map((c) => ({
      consent_id: c.id,
      post_id: c.post_id,
      kind: c.kind,
      anon_token: c.anon_token,
      revealed: c.revealed,
      at: toIso(c.created_at),
    }));

  return { posts, intents, mutual };
}

function safeParse(v) {
  try { return JSON.parse(v || "{}"); } catch { return {}; }
}
