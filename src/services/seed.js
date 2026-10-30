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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(ROOT, "fixtures");
const CONFIG = path.join(ROOT, "config");

const nowSec = () => Math.floor(Date.now() / 1000);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readIfExists = (file) => (fs.existsSync(file) ? readJson(file) : null);

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

function seedSchedule(db) {
  const fx = readIfExists(path.join(FIXTURES, "schedule.json"));
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
 * @returns {{map_nodes:number, tasks:{total:number,inserted:number}, runners:object, buddy_posts:object, schedule_items:object, reset:boolean}}
 */
export function seedAll(db, { reset = false } = {}) {
  if (reset) resetDemo(db);
  return {
    map_nodes: seedMapNodes(db),
    tasks: seedTasks(db),
    runners: seedRunners(db),
    buddy_posts: seedBuddyPosts(db),
    schedule_items: seedSchedule(db),
    reset,
  };
}

export default { seedAll, resetDemo, counts, ensureUser };
