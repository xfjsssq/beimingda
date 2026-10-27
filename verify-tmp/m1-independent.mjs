/**
 * 独立验证 · M1 代取撮合（verifier 自写，不采信 m1-dev 的测试）
 * 契约：contracts/m1-takeout.md §7 八条 + 反例
 * 跑法：node verify-tmp/m1-independent.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "m1-verify.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = DB;
process.env.DEMO_TOKEN = "verifier-local-token";

const { initDb, getDb } = await import("../src/db/index.js");
initDb({ path: DB, force: true });
const { publishTask, listOpenTasks, matchForTask, getTask } = await import("../src/services/task.js");
const { registerRunner } = await import("../src/services/runner.js");
const { matchScore, findMatches, PUSH_THRESHOLD } = await import("../src/engine/match.js");
const { loadHandlers } = await import("../src/mcp/handlers.js");
const { callTool } = await import("../src/mcp/tools.js");
loadHandlers();

const now = Math.floor(Date.now() / 1000);
const iso = (ts) => new Date(ts * 1000).toISOString();

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 400)}`);
}

/** 抓 AppError 的 code */
function codeOf(fn) {
  try {
    const r = fn();
    return { threw: false, value: r };
  } catch (e) {
    return { threw: true, code: e?.code ?? "NO_CODE", message: e?.message };
  }
}

/** 从 reason 里解析所有 +N（含小数），求和 */
function sumReason(reason) {
  return [...String(reason ?? "").matchAll(/\+(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]))
    .reduce((a, b) => a + b, 0);
}

const basePublish = (over = {}) => ({
  from_building: "12号楼",
  to_building: "15号楼",
  station: "北门菜鸟驿站",
  deadline_iso: iso(now + 7200),
  reward_min: 3,
  reward_max: 5,
  owner_handle: "同学A",
  ...over,
});

console.log("=== M1 契约 §7 八条（独立复现）===\n");

// ── §7-1 reward_min > reward_max ─────────────────────────────
{
  const svc = codeOf(() => publishTask(basePublish({ reward_min: 5, reward_max: 3 })));
  const mcp = await callTool("task_publish", basePublish({ reward_min: 5, reward_max: 3 }));
  check(
    "§7-1",
    "reward_min(5) > reward_max(3) → SCHEMA_REJECTED",
    svc.threw && svc.code === "SCHEMA_REJECTED" && mcp.ok === false && mcp.error.code === "SCHEMA_REJECTED",
    `service=${JSON.stringify(svc)} | mcp=${JSON.stringify(mcp.error)}`,
  );
}

// ── §7-2 已过期 deadline ──────────────────────────────────────
{
  const past = iso(now - 60);
  const svc = codeOf(() => publishTask(basePublish({ deadline_iso: past })));
  const mcp = await callTool("task_publish", basePublish({ deadline_iso: past }));
  check(
    "§7-2",
    "deadline 已过期 → SCHEMA_REJECTED",
    svc.threw && svc.code === "SCHEMA_REJECTED" && mcp.ok === false && mcp.error.code === "SCHEMA_REJECTED",
    `service=${JSON.stringify(svc)} | mcp=${JSON.stringify(mcp.error)}`,
  );
}

// ── 造两个 runner ─────────────────────────────────────────────
// 可达 + 时段完全覆盖 + 报酬满足 -> 应 >= 60
const rGood = registerRunner({
  user_handle: "同学R-good",
  reachable_buildings: ["15号楼", "12号楼"],
  reward_floor: 2,
  time_windows: [{ start_iso: iso(now - 600), end_iso: iso(now + 7200) }],
});
// 不可达（两个楼都不在列表里）
const rFar = registerRunner({
  user_handle: "同学R-far",
  reachable_buildings: ["20号楼", "21号楼"],
  reward_floor: 1,
  time_windows: [{ start_iso: iso(now - 600), end_iso: iso(now + 9999) }],
});
// 时间完全不重叠
const rNoTime = registerRunner({
  user_handle: "同学R-notime",
  reachable_buildings: ["15号楼"],
  reward_floor: 1,
  time_windows: [{ start_iso: iso(now + 100000), end_iso: iso(now + 200000) }],
});

const t1 = publishTask(basePublish());

// ── §7-3 不可达 runner 不出现 ─────────────────────────────────
{
  const res = matchForTask(t1.task_id);
  const handles = res.matches.map((m) => m.runner_handle);
  const engTask = getTask(t1.task_id);
  const engAll = findMatches(engTask, [
    { id: rGood.runner_id, handle: "同学R-good", reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now - 600, end: now + 7200 }]), active: 1 },
    { id: rFar.runner_id, handle: "同学R-far", reachable_buildings: JSON.stringify(["20号楼"]), reward_floor: 1, time_windows: JSON.stringify([{ start: now - 600, end: now + 9999 }]), active: 1 },
    { id: rNoTime.runner_id, handle: "同学R-notime", reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 1, time_windows: JSON.stringify([{ start: now + 100000, end: now + 200000 }]), active: 1 },
    { id: "r-inactive", handle: "同学R-off", reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 1, time_windows: JSON.stringify([{ start: now - 600, end: now + 7200 }]), active: 0 },
  ], now).map((m) => m.runner_handle);
  check(
    "§7-3",
    "不可达 / 时间不重叠 / active=0 的 runner 不出现在结果里",
    !handles.includes("同学R-far") && !handles.includes("同学R-notime") &&
      !engAll.includes("同学R-far") && !engAll.includes("同学R-notime") && !engAll.includes("同学R-off") &&
      handles.includes("同学R-good"),
    `service(落库路径) matches=${JSON.stringify(handles)} | engine findMatches=${JSON.stringify(engAll)} | 出局判定 matchScore(far)=${matchScore(getTask(t1.task_id), { reachable_buildings: '["20号楼"]', reward_floor: 1, time_windows: JSON.stringify([{ start: now - 600, end: now + 9999 }]), active: 1 }, now)}`,
  );
}

// ── §7-3b 低于阈值 60 的候选不许返回 ─────────────────────────
{
  const task = getTask(t1.task_id);
  const w = JSON.stringify([{ start: now - 600, end: now + 7200 }]);
  // 仅命中取件楼(20) + 时段满分(30) + 报酬 0 = 50 → 必须出局
  const sub = matchScore(task, { reachable_buildings: JSON.stringify(["12号楼"]), reward_floor: 99, time_windows: w, active: 1 }, now);
  // 仅命中取件楼(20) + 时段满分(30) + 报酬满(30) = 80 → 必须保留
  const over = matchScore(task, { reachable_buildings: JSON.stringify(["12号楼"]), reward_floor: 1, time_windows: w, active: 1 }, now);
  const listed = findMatches(task, [
    { id: "r-sub", handle: "差一点", reachable_buildings: JSON.stringify(["12号楼"]), reward_floor: 99, time_windows: w, active: 1 },
    { id: "r-over", handle: "够格", reachable_buildings: JSON.stringify(["12号楼"]), reward_floor: 1, time_windows: w, active: 1 },
  ], now).map((m) => m.runner_handle);
  const pushed = matchForTask(t1.task_id);
  check(
    "§7-3b",
    "阈值 60：50 分的候选不出现在结果里，80 分的出现；落库结果全部 >= 60",
    sub.score === 50 && over.score === 80 && !listed.includes("差一点") && listed.includes("够格") &&
      pushed.matches.every((m) => m.score >= 60),
    `sub=${sub.score} over=${over.score} findMatches=${JSON.stringify(listed)} 落库分数=${JSON.stringify(pushed.matches.map((m) => m.score))}`,
  );
}

// ── §7-4 5 分钟去重（真实推进时间：直接改库里的 created_at） ──
{
  const second = matchForTask(t1.task_id);
  const pushed2 = second.matches.find((m) => m.runner_handle === "同学R-good");
  // 把已有 matches 的时间戳往前挪 301 秒 = 模拟"已经过了 5 分钟"
  const moved = getDb()
    .prepare("UPDATE matches SET created_at = created_at - 301 WHERE task_id = ?")
    .run(t1.task_id).changes;
  const third = matchForTask(t1.task_id);
  const pushed3 = third.matches.find((m) => m.runner_handle === "同学R-good");
  const rows = getDb().prepare("SELECT COUNT(*) n FROM matches WHERE task_id = ?").get(t1.task_id).n;
  check(
    "§7-4",
    "同一 runner 5 分钟内不重复推送；过 300 秒后可再推",
    pushed2.pushed === false && /5\s*分钟/.test(pushed2.skip_reason || "") && pushed3.pushed === true && rows === 2,
    `第2次: pushed=${pushed2.pushed} skip_reason="${pushed2.skip_reason}" | 改库 created_at-301 共 ${moved} 行 | 第3次: pushed=${pushed3.pushed} match_id=${pushed3.match_id} | matches 行数=${rows}`,
  );
}

// ── §7-5 reason 分值相加 === score ───────────────────────────
// 判定口径：契约要的是「显示出来的分值相加等于 score」。
//   · 十进制/分（round(sum*100) === round(score*100)）必须严格相等 —— 这是契约口径
//   · 裸浮点严格相等（sum === score）会因 IEEE754 累加误差产生 ~1e-14 的差 —— 单列发现项
const centsEq = (sum, score) => Math.round(sum * 100) === Math.round(score * 100);
const FLOAT_MISMATCH = [];
{
  const res = matchForTask(t1.task_id);
  const rows = res.matches.map((m) => {
    const s = sumReason(m.reason);
    return { handle: m.runner_handle, score: m.score, sum: s, eq: centsEq(s, m.score), raw: s === m.score, reason: m.reason };
  });
  // 再压一遍引擎：大批随机组合
  let fuzzBad = [];
  let fuzzCrash = null;
  try {
    for (let i = 0; i < 400; i += 1) {
      const rf = Math.random() * 10;
      const rm = rf + Math.random() * 10;
      const task = {
        from_building: `B${i % 5}`,
        to_building: `B${(i + 1) % 5}`,
        deadline_ts: now + 60 + (i % 17) * 600,
        reward_min: Math.round(rf * 100) / 100,
        reward_max: Math.round(rm * 100) / 100,
      };
      const runner = {
        reachable_buildings: JSON.stringify([`B${(i + 1) % 5}`, `B${i % 5}`, "BZ"]),
        reward_floor: Math.random() * 12,
        time_windows: JSON.stringify([{ start: now - 300 + (i % 7) * 100, end: now + 120 + (i % 11) * 300 }]),
        active: 1,
      };
      const r = matchScore(task, runner, now);
      if (!r) continue;
      const s = sumReason(r.reason);
      if (!centsEq(s, r.score)) fuzzBad.push({ task, runner, reason: r.reason, score: r.score, sum: s });
      if (s !== r.score) FLOAT_MISMATCH.push({ score: r.score, sum: s, reason: r.reason });
      if (r.score > 100 || r.score < 0) fuzzBad.push({ over: r.score, reason: r.reason });
    }
  } catch (e) {
    fuzzCrash = String(e?.stack || e).slice(0, 300);
  }
  check(
    "§7-5",
    "reason 里 +N 之和 === score（真实落库 + 400 组引擎模糊测试）",
    rows.length > 0 && rows.every((r) => r.eq) && fuzzBad.length === 0 && !fuzzCrash,
    `落库路径: ${JSON.stringify(rows.map((r) => `${r.handle} score=${r.score} sum=${r.sum} 分对齐=${r.eq}`))} | 模糊测试「分」不一致=${fuzzBad.length} 崩溃=${fuzzCrash}`,
  );
  check(
    "§7-5b",
    "（发现项）裸浮点严格相等：reason 分值以小数形式出现时 sum !== score（IEEE754 级差）",
    true,
    `浮点严格不等实例 ${FLOAT_MISMATCH.length} 个；样例：${JSON.stringify(FLOAT_MISMATCH.slice(0, 2))}`,
  );
}

// ── §7-6 过期任务不出现在 task_list_open（直接插库造脏数据） ──
{
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users LIMIT 1").get().id;
  db.prepare(
    `INSERT INTO tasks(id,owner_id,from_building,to_building,station,deadline_ts,reward_min,reward_max,note,screenshot_path,raw_status,created_at,demo)
     VALUES ('task_expired_open',?,?,?,?,?,?,?,NULL,NULL,'open',?,1)`,
  ).run(uid, "12号楼", "15号楼", "北门菜鸟驿站", now - 100, 3, 5, now - 3600);
  db.prepare(
    `INSERT INTO tasks(id,owner_id,from_building,to_building,station,deadline_ts,reward_min,reward_max,note,screenshot_path,raw_status,created_at,demo)
     VALUES ('task_done_future',?,?,?,?,?,?,?,NULL,NULL,'done',?,1)`,
  ).run(uid, "12号楼", "15号楼", "北门菜鸟驿站", now + 9999, 3, 5, now);
  const list = listOpenTasks({ limit: 50 });
  const ids = list.map((t) => t.task_id);
  const mcp = await callTool("task_list_open", { limit: 50 });
  const mcpIds = mcp.data.tasks.map((t) => t.task_id);
  check(
    "§7-6",
    "task_list_open 不返回已过期任务 / done 任务",
    !ids.includes("task_expired_open") && !ids.includes("task_done_future") &&
      !mcpIds.includes("task_expired_open") && !mcpIds.includes("task_done_future") &&
      ids.includes(t1.task_id),
    `service list=${ids.length} 条，含过期?${ids.includes("task_expired_open")} 含done?${ids.includes("task_done_future")} | MCP count=${mcp.data.count}`,
  );
}

// ── §7-7 screenshot_path=null 仍成功 ─────────────────────────
{
  const a = publishTask(basePublish({ owner_handle: "同学B", screenshot_path: null }));
  const b = publishTask(basePublish({ owner_handle: "同学C" })); // 完全省略
  const rowA = getDb().prepare("SELECT screenshot_path FROM tasks WHERE id=?").get(a.task_id);
  const mcp = await callTool("task_publish", basePublish({ owner_handle: "同学D", screenshot_path: null }));
  check(
    "§7-7",
    "screenshot_path=null / 省略 → 发布仍成功，落库为 NULL",
    a.status === "open" && b.status === "open" && rowA.screenshot_path === null && mcp.ok === true,
    `null路径 status=${a.status} 落库=${JSON.stringify(rowA.screenshot_path)} | 省略 status=${b.status} | MCP ok=${mcp.ok}`,
  );
}

// ── §7-8 additionalProperties:false 生效 ─────────────────────
{
  const svc = codeOf(() => publishTask(basePublish({ evil_field: 1 })));
  const mcpExtra = await callTool("task_publish", basePublish({ evil_field: 1 }));
  const mcpMissing = await callTool("task_publish", { from_building: "12号楼" });
  const mcpBadWin = await callTool("runner_register", {
    user_handle: "同学E",
    reachable_buildings: ["15号楼"],
    reward_floor: 2,
    time_windows: [{ start_iso: iso(now + 60), end_iso: iso(now + 600), extra: 1 }],
  });
  check(
    "§7-8",
    "多传字段 / 缺必填 → SCHEMA_REJECTED（MCP 层 + service 层）",
    svc.threw && svc.code === "SCHEMA_REJECTED" &&
      mcpExtra.ok === false && mcpExtra.error.code === "SCHEMA_REJECTED" &&
      mcpMissing.ok === false && mcpMissing.error.code === "SCHEMA_REJECTED" &&
      mcpBadWin.ok === false && mcpBadWin.error.code === "SCHEMA_REJECTED",
    `service=${svc.code} | MCP多传=${JSON.stringify(mcpExtra.error)} | MCP缺必填=${JSON.stringify(mcpMissing.error)} | 嵌套窗口多传=${JSON.stringify(mcpBadWin.error)}`,
  );
}

console.log("\n=== M1 反例测试（自己设计的刁钻用例）===\n");

// ── C1 reward_min === reward_max（分母趋近 0）────────────────
{
  let r = null;
  let crash = null;
  let svcRes = null;
  try {
    svcRes = publishTask(basePublish({ owner_handle: "同学F", reward_min: 5, reward_max: 5 }));
    const t = getTask(svcRes.task_id);
    r = matchScore(t, JSON.parse(JSON.stringify({ ...rGoodRow(), reward_floor: 2 })), now);
  } catch (e) {
    crash = String(e?.message);
  }
  function rGoodRow() {
    return getDb().prepare("SELECT * FROM runners WHERE id=?").get(rGood.runner_id);
  }
  const sum = r ? sumReason(r.reason) : null;
  check(
    "C1",
    "reward_min === reward_max（分母 1e-6）→ 不崩、报酬分 clamp 到 30、reason=score",
    !crash && r !== null && r.score <= 100 && r.score >= 0 && sum === r.score,
    `crash=${crash} score=${r?.score} parts=${JSON.stringify(r?.parts)} sum=${sum} reason="${r?.reason}"`,
  );
}

// ── C2 reward_floor 高于 reward_max ─────────────────────────
{
  const task = getTask(t1.task_id);
  let crash = null;
  let r = null;
  try {
    r = matchScore(task, { reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 999, time_windows: JSON.stringify([{ start: now - 10, end: now + 7200 }]), active: 1 }, now);
  } catch (e) {
    crash = String(e?.message);
  }
  check(
    "C2",
    "reward_floor(999) 远高于 reward_max(5) → 报酬分 0、总分不为负、不崩",
    !crash && r !== null && r.parts.reward === 0 && r.score >= 0 && r.score <= 100 && sumReason(r.reason) === r.score,
    `crash=${crash} parts=${JSON.stringify(r?.parts)} score=${r?.score} reason="${r?.reason}"`,
  );
}

// ── C3 时段只有 1 秒重叠 ────────────────────────────────────
{
  const task = { from_building: "12号楼", to_building: "15号楼", deadline_ts: now + 100000, reward_min: 3, reward_max: 5 };
  const overlap1s = matchScore(task, { reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now, end: now + 1 }]), active: 1 }, now);
  const noOverlap = matchScore(task, { reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now - 100, end: now }]), active: 1 }, now);
  check(
    "C3",
    "仅 1 秒重叠 → 时间 10 分（<50%）；紧贴边界完全不重叠 → 出局(null)",
    overlap1s !== null && overlap1s.parts.time === 10 && noOverlap === null && sumReason(overlap1s.reason) === overlap1s.score,
    `1秒重叠: parts=${JSON.stringify(overlap1s?.parts)} reason="${overlap1s?.reason}" | 完全无重叠=${noOverlap}`,
  );
}

// ── C4 deadline 刚好等于当前秒 / 恰好 +1 秒 ─────────────────
{
  const exactlyNow = codeOf(() => publishTask(basePublish({ owner_handle: "同学G", deadline_iso: iso(now + 1) }), { now }));
  const oneSecPast = codeOf(() => publishTask(basePublish({ owner_handle: "同学H", deadline_iso: iso(now) }), { now }));
  const engineAtDeadline = matchScore({ from_building: "12号楼", to_building: "15号楼", deadline_ts: now, reward_min: 3, reward_max: 5 }, { reachable_buildings: JSON.stringify(["15号楼"]), reward_floor: 2, time_windows: JSON.stringify([{ start: now - 10, end: now + 10 }]), active: 1 }, now);
  check(
    "C4",
    "deadline 刚好 == now → 拒；deadline == now+1s → 收；引擎侧 deadline==now → 出局",
    exactlyNow.threw === false && oneSecPast.threw && oneSecPast.code === "SCHEMA_REJECTED" && engineAtDeadline === null,
    `now+1s: ${exactlyNow.threw ? exactlyNow.code : "接受 ✅"} | now: ${oneSecPast.code} | 引擎:${engineAtDeadline}`,
  );
}

// ── C5 超过 3 名候选时的推送上限 ────────────────────────────
{
  for (let i = 0; i < 5; i += 1) {
    registerRunner({
      user_handle: `同学X-${i}`,
      reachable_buildings: ["15号楼", "12号楼"],
      reward_floor: 2,
      time_windows: [{ start_iso: iso(now - 600), end_iso: iso(now + 7200) }],
    });
  }
  const t2 = publishTask(basePublish({ owner_handle: "同学Y", reward_min: 4, reward_max: 6 }));
  const res = matchForTask(t2.task_id);
  const pushed = res.matches.filter((m) => m.pushed);
  const rows = getDb().prepare("SELECT COUNT(*) n FROM matches WHERE task_id=?").get(t2.task_id).n;
  check(
    "C5",
    "候选>3 时：单任务最多落库 3 条 pushed，其余只展示",
    pushed.length === 3 && rows === 3 && res.matches.length >= 3 && res.matches.filter((m) => m.skip_reason && /上限/.test(m.skip_reason)).length >= 0,
    `candidates=${res.candidates} matches=${res.matches.length} pushed=${pushed.length} 落库=${rows} skip_reasons=${JSON.stringify(res.matches.map((m) => m.skip_reason))}`,
  );
}

// ── C6 分数不可能 > 100 / 不可能为负（大量随机）────────────────
{
  let bad = [];
  let crash = null;
  try {
    for (let i = 0; i < 2000; i += 1) {
      const task = {
        from_building: `B${i % 3}`,
        to_building: `B${(i + 1) % 3}`,
        deadline_ts: now + 1 + (i % 100) * 30,
        reward_min: (i % 50) / 5,
        reward_max: (i % 50) / 5 + (i % 7) / 2,
      };
      const runner = {
        reachable_buildings: JSON.stringify([`B${(i + 1) % 3}`]),
        reward_floor: ((i * 7) % 60) / 4,
        time_windows: JSON.stringify([{ start: now - (i % 40) * 10, end: now + (i % 40) * 30 }]),
        active: 1,
      };
      const r = matchScore(task, runner, now);
      if (!r) continue;
      if (!(r.score >= 0 && r.score <= 100)) bad.push({ score: r.score, reason: r.reason });
      if (!centsEq(sumReason(r.reason), r.score)) bad.push({ mismatch: r.reason, score: r.score });
    }
  } catch (e) {
    crash = String(e?.stack || e).slice(0, 300);
  }
  check(
    "C6",
    "2000 组随机：0 <= score <= 100 且 reason 分值 === score（按分对齐），无异常抛出",
    bad.length === 0 && !crash,
    `异常=${bad.length} 崩溃=${crash} 样例=${JSON.stringify(bad.slice(0, 3))}`,
  );
}

console.log(`\n=== M1 汇总：PASS ${pass} / FAIL ${fail} ===`);
fs.writeFileSync(path.join(__dirname, "m1-result.json"), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
