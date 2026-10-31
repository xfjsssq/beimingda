/**
 * 演示数据灌入（业务层，幂等）—— 核心层
 *
 *   - `scripts/seed.js` 是这个模块的命令行壳（npm run seed）
 *   - `GET /api/demo/seed`（src/api/demo.js）是同一个实现的 HTTP 入口
 *   ⛔ 两处必须共用本文件，不许各写一份（contracts/core.md §3、§5）
 *
 * ⭐ 规则
 *   - 所有演示数据一律 demo=1，姓名用"同学A/同学B"，学号用 2025XXXX（表结构里本来也没有学号字段）
 *   - 幂等靠"确定性主键 + INSERT OR IGNORE"实现
 *   - fixtures/*.json 由各模块分支补充（M1 tasks/runners、M2 buddy-posts、M4 schedule）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(ROOT, "fixtures");
const CONFIG = path.join(ROOT, "config");

const nowSec = () => Math.floor(Date.now() / 1000);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readIfExists = (file) => (fs.existsSync(file) ? readJson(file) : null);
/** 与 services/session.js 同一套：会话 token 只存 sha256 */
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** 相对时间容错：deadline_iso 优先；否则 deadline_in_minutes 相对当前时间 */
function resolveTs(row) {
  if (row.deadline_ts) return Number(row.deadline_ts);
  if (row.deadline_iso) return Math.floor(Date.parse(row.deadline_iso) / 1000);
  if (row.deadline_in_minutes != null) return nowSec() + Math.round(row.deadline_in_minutes * 60);
  return nowSec() + 6 * 3600;
}

function resolveWindow(w) {
  const s =
    w.start_ts ??
    (w.start_iso ? Math.floor(Date.parse(w.start_iso) / 1000) : null) ??
    (w.start_in_minutes != null ? nowSec() + Math.round(w.start_in_minutes * 60) : null);
  const e =
    w.end_ts ??
    (w.end_iso ? Math.floor(Date.parse(w.end_iso) / 1000) : null) ??
    (w.end_in_minutes != null ? nowSec() + Math.round(w.end_in_minutes * 60) : null);
  return { start: s, end: e };
}

/** ⭐ 与 M1 的 src/services/users.js 同一约定：id = demo-user-<handle> */
const uid = (handle) => `demo-user-${handle}`;

export function ensureUser(db, handle, contactCode = null) {
  const id = uid(handle);
  db.prepare(
    `INSERT OR IGNORE INTO users(id, handle, contact_code, created_at, demo) VALUES (?,?,?,?,1)`,
  ).run(id, handle, contactCode, nowSec());
  return id;
}

function seedMapNodes(db) {
  const cfg = readIfExists(path.join(CONFIG, "map-nodes.json"));
  const nodes = cfg?.nodes ?? [];
  const stmt = db.prepare(
    `INSERT INTO map_nodes(id,label,category,lat,lng,pano_url,pano_yaw,desc,sort)
     VALUES (@id,@label,@category,@lat,@lng,@pano_url,@pano_yaw,@desc,@sort)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label, category=excluded.category, lat=excluded.lat, lng=excluded.lng,
       pano_url=excluded.pano_url, pano_yaw=excluded.pano_yaw, desc=excluded.desc, sort=excluded.sort`,
  );
  let n = 0;
  const run = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run({
        id: String(r.id),
        label: String(r.label ?? r.id),
        category: String(r.category ?? "service"),
        lat: Number(r.lat ?? 0),
        lng: Number(r.lng ?? 0),
        pano_url: r.pano_url ?? null,
        pano_yaw: Number(r.pano_yaw ?? 0),
        desc: r.desc ?? null,
        sort: Number(r.sort ?? 0),
      });
      n += 1;
    }
  });
  run(nodes);
  return n;
}

function seedTasks(db) {
  const fx = readIfExists(path.join(FIXTURES, "tasks.json"));
  const rows = fx?.tasks ?? [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tasks(id,owner_id,from_building,to_building,station,deadline_ts,
       reward_min,reward_max,note,screenshot_path,raw_status,created_at,demo)
     VALUES (@id,@owner_id,@from_building,@to_building,@station,@deadline_ts,
       @reward_min,@reward_max,@note,@screenshot_path,@raw_status,@created_at,1)`,
  );
  let n = 0;
  for (const r of rows) {
    const ownerId = ensureUser(db, r.owner_handle || "同学A");
    const res = stmt.run({
      id: String(r.id),
      owner_id: ownerId,
      from_building: String(r.from_building),
      to_building: String(r.to_building),
      station: String(r.station),
      deadline_ts: resolveTs(r),
      reward_min: Number(r.reward_min),
      reward_max: Number(r.reward_max),
      note: r.note ?? null,
      screenshot_path: r.screenshot_path ?? null,
      raw_status: r.raw_status ?? "open",
      created_at: nowSec(),
    });
    n += res.changes;
  }
  return { total: rows.length, inserted: n };
}

function seedRunners(db) {
  const fx = readIfExists(path.join(FIXTURES, "runners.json"));
  const rows = fx?.runners ?? [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO runners(id,user_id,reachable_buildings,reward_floor,time_windows,active,created_at,demo)
     VALUES (@id,@user_id,@reachable_buildings,@reward_floor,@time_windows,@active,@created_at,1)`,
  );
  let n = 0;
  for (const r of rows) {
    const userId = ensureUser(db, r.user_handle || r.handle || "同学B", r.contact_code ?? null);
    const res = stmt.run({
      id: String(r.id),
      user_id: userId,
      reachable_buildings: JSON.stringify(r.reachable_buildings ?? []),
      reward_floor: Number(r.reward_floor ?? 0),
      time_windows: JSON.stringify((r.time_windows ?? []).map(resolveWindow)),
      active: r.active === false ? 0 : 1,
      created_at: nowSec(),
    });
    n += res.changes;
  }
  return { total: rows.length, inserted: n };
}

function seedBuddyPosts(db) {
  const fx = readIfExists(path.join(FIXTURES, "buddy-posts.json"));
  const rows = fx?.posts ?? [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO buddy_posts(id,author_id,kind,profile_json,anon_token,raw_status,created_at,demo)
     VALUES (@id,@author_id,@kind,@profile_json,@anon_token,@raw_status,@created_at,1)`,
  );
  let n = 0;
  for (const r of rows) {
    const authorId = ensureUser(db, r.author_handle || "同学A");
    // ⛔ anon_token 必须随机生成，不得由 user_id 派生（演示数据里也不许例外）
    const token = r.anon_token || `anon_${crypto.randomBytes(6).toString("hex")}`;
    const res = stmt.run({
      id: String(r.id),
      author_id: authorId,
      kind: String(r.kind ?? "other"),
      profile_json: JSON.stringify(r.profile ?? {}),
      anon_token: token,
      raw_status: r.raw_status ?? "open",
      created_at: nowSec(),
    });
    n += res.changes;
  }
  return { total: rows.length, inserted: n };
}

/**
 * ⭐ 一对**真实**的演示配对 + 一段真实聊天（2026-10-31）
 *
 *   为什么要有它：
 *     「已同意」这一栏以前只能靠演示 JSON 里的样例行撑门面，点「打开私聊」进去是空的
 *     （站长反馈的数据错乱）。这里改成：真的落 `buddy_consents(revealed=1)` + 真的
 *     `threads` 会话 + 2~3 条 `thread_messages`，所以打开就有内容、而且真的能聊。
 *
 *   幂等：确定性主键 + INSERT OR IGNORE；threads 另有 UNIQUE(kind,ref_id,a_uid,b_uid) 兜底。
 *   清理：resetDemo() 里按外键顺序删（thread_messages → threads → sessions → … → users）。
 *   ⚠️ 两个身份的会话 token 由 DEMO_TOKEN 派生（不是写死的常量）：确定性 → 重复灌不新增会话，
 *      且 `/api/demo/seed` 会把 token 一起返回，演示脚本/自测可以直接用这两个身份登录。
 *      风险等级与 DEMO_TOKEN 本身相同（都是 demo 凭据，站点只读 + 限频）。
 */
const BUDDY_PAIR = Object.freeze({
  user_a: "搭子演示A",
  user_b: "搭子演示B",
  post_id: "demo-buddy-pair-post",
  anon_token: "anon_7b3e9c1a5d20",
  consent_id: "demo-buddy-pair-consent",
  thread_id: "demo-buddy-pair-thread",
  messages: [
    { id: "demo-buddy-pair-msg-1", from: "b", body: "我周三周四晚上都在图书馆三楼，可以一起", offset: -600 },
    { id: "demo-buddy-pair-msg-2", from: "a", body: "行，那七点图书馆门口见；我一般在靠窗那排", offset: -540 },
    { id: "demo-buddy-pair-msg-3", from: "b", body: "好，我先去占位，到了跟你说", offset: -480 },
  ],
});

/** 演示身份对应的会话 token（由 DEMO_TOKEN 派生，⛔ 源码里不写死任何凭据字面量） */
function demoPairToken(handle) {
  return sha256(`buddy-demo-session|${handle}|${process.env.DEMO_TOKEN || "local-demo"}`);
}

export function seedBuddyPair(db, { exposeSecrets = false } = {}) {
  const aId = ensureUser(db, BUDDY_PAIR.user_a);
  const bId = ensureUser(db, BUDDY_PAIR.user_b);
  const t = nowSec();

  // ① A 发一条搭子帖（一句话那种，别加量）
  const profile = {
    kind: "study", grade: "不限", major_group: "不限",
    schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] },
    interests: [], traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 },
    wanted: "想找人一起自习，图书馆三楼，晚上七点",
    must_have: [], deal_breaker: [],
  };
  const postRes = db.prepare(
    `INSERT OR IGNORE INTO buddy_posts(id,author_id,kind,profile_json,anon_token,raw_status,created_at,demo)
     VALUES (?,?,?,?,?,?,?,1)`,
  ).run(BUDDY_PAIR.post_id, aId, "study", JSON.stringify(profile), BUDDY_PAIR.anon_token, "open", t - 700);

  // ② B 表达意愿（留言）→ A 接受（author_ok=seeker_ok=revealed=1）
  const consentRes = db.prepare(
    `INSERT OR IGNORE INTO buddy_consents(id,post_id,seeker_id,score,author_ok,seeker_ok,revealed,created_at)
     VALUES (?,?,?,?,1,1,1,?)`,
  ).run(BUDDY_PAIR.consent_id, BUDDY_PAIR.post_id, bId, 86, t - 660);

  // 留言（帖子上能看到"有人表达过意愿"）
  db.prepare(
    `INSERT OR IGNORE INTO buddy_messages(id,post_id,consent_id,from_id,to_id,kind,body,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    `${BUDDY_PAIR.consent_id}-ask`, BUDDY_PAIR.post_id, BUDDY_PAIR.consent_id, bId, aId, "message",
    "我周三周四晚上都在图书馆三楼，可以一起", t - 660,
  );

  // ③ 真实会话行（a=帖主，b=申请者，与 chat.js 的 ensureThreads 完全一致）
  const threadRes = db.prepare(
    `INSERT OR IGNORE INTO threads(id,kind,ref_id,a_uid,b_uid,created_at) VALUES (?, 'buddy', ?, ?, ?, ?)`,
  ).run(BUDDY_PAIR.thread_id, BUDDY_PAIR.post_id, aId, bId, t - 640);

  // ④ 会话里预置 2~3 条像真人的消息
  const msgStmt = db.prepare(
    `INSERT OR IGNORE INTO thread_messages(id,thread_id,from_uid,body,kind,created_at) VALUES (?,?,?,?,?,?)`,
  );
  let msgChanges = 0;
  for (const m of BUDDY_PAIR.messages) {
    const isEmoji = !/[\u4e00-\u9fa5A-Za-z0-9]/.test(m.body);
    const r = msgStmt.run(m.id, BUDDY_PAIR.thread_id, m.from === "a" ? aId : bId, m.body, isEmoji ? "emoji" : "text", t + m.offset);
    msgChanges += r.changes;
  }

  // ⑤ 两个身份的会话 + 一个可登录的密码（都由 DEMO_TOKEN 派生，源码里不写死字面量）
  //    密码有存在的必要：演示者可以在站内「注册 / 登录」成 搭子演示A/B，直接在「已同意」里看到这条真会话。
  //    ⚠️ token/密码只在**授权调用**（reset=1，要 X-Demo-Token）时返回，普通 GET /api/demo/seed 不返回。
  const tokens = {};
  const logins = {};
  for (const [key, handle, id] of [["A", BUDDY_PAIR.user_a, aId], ["B", BUDDY_PAIR.user_b, bId]]) {
    const token = demoPairToken(handle);
    db.prepare(
      `INSERT OR IGNORE INTO sessions(token_hash,user_id,created_at,last_seen_at) VALUES (?,?,?,?)`,
    ).run(sha256(token), id, t, t);
    const password = demoPairToken(`pass|${handle}`).slice(0, 12);
    const { salt, hash } = hashPassword(password);
    db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ? AND pass_hash IS NULL").run(hash, salt, id);
    if (exposeSecrets) {
      tokens[key] = { handle, uid: id, token };
      logins[key] = { handle, password };
    }
  }

  return {
    // total/inserted 放在顶层：scripts/seed.js 的 CLI 打印用得上（其它字段是给 /api/demo/seed 与自测看的）
    total: 1 + 1 + 1 + BUDDY_PAIR.messages.length,
    inserted: postRes.changes + consentRes.changes + threadRes.changes + msgChanges,
    users: { A: BUDDY_PAIR.user_a, B: BUDDY_PAIR.user_b },
    post_id: BUDDY_PAIR.post_id,
    anon_token: BUDDY_PAIR.anon_token,
    thread_id: BUDDY_PAIR.thread_id,
    messages: BUDDY_PAIR.messages.length,
    ...(exposeSecrets ? { tokens, login: logins } : {}),
  };
}

function seedSchedule(db) {  const fx = readIfExists(path.join(FIXTURES, "schedule.json"));
  const rows = fx?.items ?? [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO schedule_items(id,user_id,weekday,period_start,period_end,title,room,weeks,remind_before,created_at,demo)
     VALUES (@id,@user_id,@weekday,@period_start,@period_end,@title,@room,@weeks,@remind_before,@created_at,1)`,
  );
  let n = 0;
  for (const [i, r] of rows.entries()) {
    const userId = ensureUser(db, r.user_handle || "同学A");
    const res = stmt.run({
      id: String(r.id ?? `demo-sched-${i + 1}`),
      user_id: userId,
      weekday: Number(r.weekday),
      period_start: Number(r.period_start),
      period_end: Number(r.period_end),
      title: String(r.title),
      room: r.room ?? null,
      weeks: r.weeks ?? null,
      remind_before: r.remind_before ?? null,
      created_at: nowSec(),
    });
    n += res.changes;
  }
  return { total: rows.length, inserted: n };
}

/** 清空全部 demo=1 数据（只在显式要求时调用） */
export function resetDemo(db) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM matches").run();
    // ⚠️ 外键顺序：会话/消息必须先删（threads 引用 users，thread_messages 引用 threads/users）
    db.prepare(
      `DELETE FROM thread_messages WHERE thread_id IN (
         SELECT id FROM threads WHERE a_uid IN (SELECT id FROM users WHERE demo=1)
            OR b_uid IN (SELECT id FROM users WHERE demo=1))`,
    ).run();
    db.prepare(
      `DELETE FROM threads WHERE a_uid IN (SELECT id FROM users WHERE demo=1)
          OR b_uid IN (SELECT id FROM users WHERE demo=1)`,
    ).run();
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE demo=1)").run();
    db.prepare("DELETE FROM buddy_messages").run();
    db.prepare("DELETE FROM buddy_consents").run();
    db.prepare("DELETE FROM tasks WHERE demo=1").run();
    db.prepare("DELETE FROM runners WHERE demo=1").run();
    db.prepare("DELETE FROM buddy_posts WHERE demo=1").run();
    db.prepare("DELETE FROM schedule_items WHERE demo=1").run();
    db.prepare("DELETE FROM users WHERE demo=1").run();
    db.prepare("DELETE FROM scrub_audit").run();
  });
  tx();
}

export function counts(db) {
  const q = (sql) => db.prepare(sql).get().n;
  return {
    users: q("SELECT COUNT(*) n FROM users"),
    tasks: q("SELECT COUNT(*) n FROM tasks"),
    runners: q("SELECT COUNT(*) n FROM runners"),
    buddy_posts: q("SELECT COUNT(*) n FROM buddy_posts"),
    buddy_consents: q("SELECT COUNT(*) n FROM buddy_consents"),
    threads: q("SELECT COUNT(*) n FROM threads"),
    thread_messages: q("SELECT COUNT(*) n FROM thread_messages"),
    sessions: q("SELECT COUNT(*) n FROM sessions"),
    schedule_items: q("SELECT COUNT(*) n FROM schedule_items"),
    map_nodes: q("SELECT COUNT(*) n FROM map_nodes"),
    matches: q("SELECT COUNT(*) n FROM matches"),
    scrub_audit: q("SELECT COUNT(*) n FROM scrub_audit"),
  };
}

/**
 * 幂等灌入演示数据。
 * @param {import('better-sqlite3').Database} db
 * @param {{reset?: boolean}} [opts] reset=true 时先清空全部 demo=1 数据
 * @returns {{map_nodes:number, tasks:object, runners:object, buddy_posts:object, buddy_pair:object, schedule_items:object, reset:boolean}}
 */
export function seedAll(db, { reset = false } = {}) {
  if (reset) resetDemo(db);
  return {
    map_nodes: seedMapNodes(db),
    tasks: seedTasks(db),
    runners: seedRunners(db),
    buddy_posts: seedBuddyPosts(db),
    // tokens/密码只在 reset=1（要 X-Demo-Token 的授权调用）时返回，避免匿名调用者捞到演示身份
    buddy_pair: seedBuddyPair(db, { exposeSecrets: reset }),
    schedule_items: seedSchedule(db),
    reset,
  };
}

export default { seedAll, resetDemo, counts, ensureUser, seedBuddyPair };
