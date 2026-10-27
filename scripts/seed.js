#!/usr/bin/env node
/**
 * 演示数据灌入（幂等）—— T0 交付项
 *
 *   npm run seed              幂等灌入（重复执行不报错、不重复插数据、不覆盖已存在记录）
 *   npm run seed -- --reset   先清空全部 demo=1 的数据再灌
 *   npm run seed -- --check   只统计当前库内数据量，不写入
 *
 * ⭐ 规则
 *   - 所有演示数据一律 demo=1，姓名用"同学A/同学B"，学号用 2025XXXX（本表结构里本来也没有学号字段）
 *   - 幂等靠"确定性主键 + INSERT OR IGNORE"实现
 *   - fixtures/*.json 的数据由各模块分支补充（M1 tasks/runners、M2 buddy-posts、M4 schedule）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initDb, getDb, closeDb, dbPath } from "../src/db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures");
const CONFIG = path.join(ROOT, "config");

const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const CHECK = args.has("--check");

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

const uid = (handle) => `demo-user-${handle}`;

function ensureUser(db, handle, contactCode = null) {
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

function resetDemo(db) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM matches").run();
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

function counts(db) {
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

function main() {
  initDb();
  const db = getDb();

  if (CHECK) {
    console.log("[seed] --check：", JSON.stringify(counts(db), null, 2));
    closeDb();
    return;
  }

  if (RESET) {
    resetDemo(db);
    console.log("[seed] --reset：已清空 demo=1 数据");
  }

  const summary = {
    map_nodes: seedMapNodes(db),
    tasks: seedTasks(db),
    runners: seedRunners(db),
    buddy_posts: seedBuddyPosts(db),
    schedule_items: seedSchedule(db),
  };

  console.log(`[seed] db = ${dbPath()}`);
  for (const [k, v] of Object.entries(summary)) {
    console.log(`[seed] ${k}: fixture 行数 ${v.total ?? v}，新增 ${v.inserted ?? v}`);
  }
  console.log("[seed] 当前库内统计：", JSON.stringify(counts(db), null, 2));
  console.log("[seed] 提示：重复执行不产生重复数据（幂等）");
  closeDb();
}

main();
