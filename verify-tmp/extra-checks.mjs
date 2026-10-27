/**
 * 独立验证 · 补充边界 + 表结构合规（verifier 自写）
 * 跑法：node verify-tmp/extra-checks.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB = path.join(__dirname, "extra-verify.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = DB;

const { initDb, getDb } = await import("../src/db/index.js");
initDb({ path: DB, force: true });
const M1 = await import("../src/engine/match.js");
const M1S = await import("../src/services/task.js");
const M2 = await import("../src/services/buddy.js");
const M2E = await import("../src/engine/buddy.js");

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 600)}`);
}
const now = Math.floor(Date.now() / 1000);
const iso = (ts) => new Date(ts * 1000).toISOString();
const sumReason = (r) =>
  [...String(r ?? "").matchAll(/\+(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);

console.log("=== M1 补充边界 ===\n");

// 时段 end 恰好 == deadline；时段 start 恰好 == now
{
  const task = { from_building: "A", to_building: "B", deadline_ts: now + 3600, reward_min: 3, reward_max: 5 };
  const exactEnd = M1.matchScore(task, { reachable_buildings: JSON.stringify(["B"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now - 100, end: now + 3600 }]), active: 1 }, now);
  const exactStart = M1.matchScore(task, { reachable_buildings: JSON.stringify(["B"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now, end: now + 4000 }]), active: 1 }, now);
  const halfOverlap = M1.matchScore(task, { reachable_buildings: JSON.stringify(["B"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now + 1800, end: now + 9999 }]), active: 1 }, now);
  check(
    "E1",
    "时段边界：end===deadline 与 start===now 都记满分 30；恰好 50% 重叠记 20",
    exactEnd?.parts.time === 30 && exactStart?.parts.time === 30 && halfOverlap?.parts.time === 20,
    `end==deadline: ${exactEnd?.parts.time} | start==now: ${exactStart?.parts.time} | 50.0% 重叠: ${halfOverlap?.parts.time}（${halfOverlap?.reason}）`,
  );
}

// limit 边界
{
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users LIMIT 1").get()?.id ?? (() => {
    db.prepare("INSERT INTO users(id,handle,contact_code,created_at,demo) VALUES ('u1','测试甲',NULL,?,1)").run(now);
    return "u1";
  })();
  for (let i = 0; i < 5; i += 1) {
    db.prepare(`INSERT INTO tasks(id,owner_id,from_building,to_building,station,deadline_ts,reward_min,reward_max,note,screenshot_path,raw_status,created_at,demo)
      VALUES (?,?,?,?,?,?,?,?,NULL,NULL,'open',?,1)`).run(`t_lim_${i}`, uid, "A", "B", "站点", now + 999 + i, 1, 2, now);
  }
  const cases = [
    ["limit=0", M1S.listOpenTasks({ limit: 0 }).length],
    ["limit=-5", M1S.listOpenTasks({ limit: -5 }).length],
    ["limit=999", M1S.listOpenTasks({ limit: 999 }).length],
    ["limit='abc'", M1S.listOpenTasks({ limit: "abc" }).length],
    ["limit='2'", M1S.listOpenTasks({ limit: "2" }).length],
    ["building='不存在的楼'", M1S.listOpenTasks({ building: "不存在的楼" }).length],
  ];
  check(
    "E2",
    "limit / building 边界：不崩、被 clamp 到 1..50、非法值回落默认 20、不存在的楼返回 0",
    cases[0][1] === 1 && cases[1][1] === 1 && cases[2][1] === 5 && cases[3][1] === 5 && cases[4][1] === 2 && cases[5][1] === 0,
    JSON.stringify(cases),
  );
}

// 撮合结果按 score 降序 + 单任务最多 3
{
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users LIMIT 1").get().id;
  db.prepare(`INSERT INTO tasks(id,owner_id,from_building,to_building,station,deadline_ts,reward_min,reward_max,note,screenshot_path,raw_status,created_at,demo)
    VALUES ('t_sort',?,?,?,?,?,?,?,NULL,NULL,'open',?,1)`).run(uid, "A", "B", "站点", now + 3600, 3, 9, now);
  for (let i = 0; i < 6; i += 1) {
    const rid = `runner_sort_${i}c`;
    db.prepare("INSERT OR IGNORE INTO users(id,handle,contact_code,created_at,demo) VALUES (?,?,NULL,?,1)").run(`u_sort_${i}`, `排序甲${i}`, now);
    db.prepare(`INSERT OR REPLACE INTO runners(id,user_id,reachable_buildings,reward_floor,time_windows,active,created_at,demo)
      VALUES (?,?,?,?,?,1,?,1)`).run(rid, `u_sort_${i}`, JSON.stringify(["B"]), (9 - i) / 3, JSON.stringify([{ start: now - 60, end: now + 7200 }]), now + i);
  }
  const res = M1S.matchForTask("t_sort");
  const scores = res.matches.map((m) => m.score);
  const sorted = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
  const dbRows = db.prepare("SELECT COUNT(*) n FROM matches WHERE task_id='t_sort'").get().n;
  check(
    "E3",
    "撮合：按 score 降序、单任务最多同时推 3 名（落库 3 条），阈值 60 过滤生效",
    sorted && res.matches.length === 3 && dbRows === 3 && scores.every((s) => s >= 60) && scores.every((s) => s <= 100),
    `候选=${res.candidates} 返回=${res.matches.length} 分数=${JSON.stringify(scores)} 落库=${dbRows} 每条=${JSON.stringify(res.matches.map((m) => `${m.runner_handle}:${m.score}`))}`,
  );
}

console.log("\n=== M2 补充边界 + 合规 ===\n");

// 照片不进评分、不落库
{
  const t = "我想找自习搭子，喜欢算法和摄影，安静有计划";
  const A = await M2.publishPost({ author_handle: "照片甲", kind: "study", text_profile: t });
  const B = await M2.publishPost({ author_handle: "照片乙", kind: "study", text_profile: t, photo_path: "static/u/a.jpg" });
  const cols = getDb().prepare("PRAGMA table_info(buddy_posts)").all().map((c) => c.name);
  const scoreA = M2E.buddyScore(A.profile, A.profile).score;
  const scoreB = M2E.buddyScore(B.profile, A.profile).score;
  check(
    "E4",
    "照片：带 photo_path 与不带时画像/评分完全一致；buddy_posts 表没有任何可存照片的列",
    JSON.stringify(A.profile) === JSON.stringify(B.profile) && scoreA === scoreB &&
      !cols.some((c) => /photo|image|avatar|picture/i.test(c)),
    `buddy_posts 列=${JSON.stringify(cols)} | 画像一致=${JSON.stringify(A.profile) === JSON.stringify(B.profile)} | 自比分一致=${scoreA}/${scoreB}`,
  );
}

// 一人对多帖分别表决互不影响
{
  const p1 = await M2.publishPost({ author_handle: "多帖甲", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  const p2 = await M2.publishPost({ author_handle: "多帖乙", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  const c1 = M2.castConsent({ post_id: p1.post_id, seeker_handle: "多帖寻找", agree: true });
  const c2 = M2.castConsent({ post_id: p2.post_id, seeker_handle: "多帖寻找", agree: false });
  const rows = getDb().prepare("SELECT COUNT(*) n FROM buddy_consents").get().n;
  check(
    "E5",
    "同一寻找方对不同帖分别表决互不干扰（一帖同意、一帖拒绝都能落库，UNIQUE 只限同一帖）",
    c1.seeker_ok === 1 && c2.seeker_ok === 0 && c1.author_ok === 0 && c2.author_ok === 0 && rows === 2,
    `帖1 → ${JSON.stringify(c1)} | 帖2 → ${JSON.stringify(c2)} | buddy_consents 行数=${rows}`,
  );
}

// 表结构合规：不允许出现能存真实身份信息的列
{
  const sql = fs.readFileSync(path.join(ROOT, "src/db/schema.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]);
  const idxs = [...sql.matchAll(/CREATE INDEX (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]);
  const forbidden = [];
  const FORBIDDEN = /(real_?name|true_?name|姓名|student_?no|学号|stu_?id|phone|mobile|手机|tel_|contact_?phone|id_?card|身份证|student_?card|学生证|password|passwd|口令|campus_?account|校园网|attrust|vpn|dorm_?no|宿舍号|room_?no|班级|class_?name|院系|department|college)/i;
  for (const m of sql.matchAll(/^\s{2}([a-z_]+)\s+(TEXT|INTEGER|REAL)/gim)) {
    if (FORBIDDEN.test(m[1])) forbidden.push(m[1]);
  }
  const supportsBump = ["idx_tasks_status_deadline", "idx_matches_task", "idx_sched_user_weekday"].filter((x) => idxs.includes(x));
  check(
    "E6",
    "core §2 数据库合规：9 张表、关键索引齐全、列名里没有任何可存真实姓名/学号/手机号/身份证/学生证/口令的字段",
    tables.length === 9 && supportsBump.length >= 1 && forbidden.length === 0 &&
      /UNIQUE\s*\(\s*post_id\s*,\s*seeker_id\s*\)/i.test(sql),
    `表=${JSON.stringify(tables)}(${tables.length}张) | 索引=${JSON.stringify(idxs)} | 关键索引命中=${JSON.stringify(supportsBump)} | 违规列名=${JSON.stringify(forbidden)} | buddy_consents UNIQUE(post_id,seeker_id)=${/UNIQUE\s*\(\s*post_id\s*,\s*seeker_id\s*\)/i.test(sql)}`,
  );
  // reason 一致性再压一遍（用 fixture 画像规模）
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/buddy-posts.json"), "utf8"));
  const list = Array.isArray(fixture) ? fixture : fixture.posts || fixture.buddy_posts;
  let bad = 0;
  for (const p of list) {
    for (const q of list) {
      const r = M2E.buddyScore(p.profile ?? p, q.profile ?? q);
      if (r.vetoed) continue;
      if (sumReason(r.reason) !== r.score) bad += 1;
    }
  }
  check("E7", "全 fixture 两两组合评分：reason 分值 === score，无异常", bad === 0, `buddy-posts ${list.length} 条两两互评 ${list.length * list.length} 组，不一致=${bad}`);
}

console.log(`\n=== 补充检查 汇总：PASS ${pass} / FAIL ${fail} ===`);
fs.writeFileSync(path.join(__dirname, "extra-result.json"), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
