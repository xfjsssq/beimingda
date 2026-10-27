/**
 * 代取撮合评分引擎（M1 · 冻版）
 *
 * 契约：contracts/m1-takeout.md §2
 *   【可达性 40】命中 to_building → 40；仅命中 from_building → 20；都不命中 → 出局
 *   【时间   30】某时段完全覆盖 [now, deadline] → 30；部分重叠 ≥50% → 20；<50% → 10；不重叠 → 出局
 *   【报酬   30】ratio = clamp((reward_max - reward_floor) / (reward_max - reward_min + 1e-6), 0, 1)；ratio*30
 *   推送阈值 60；单任务最多同时推 3 名；同一 runner 5 分钟内不重复推送
 *
 * ⛔ 权重（40/30/30）与阈值（60）一个字都不许改 —— 参数从 config/match-rules.json 读，
 *    引擎自身不写死数字，但会在 tests 里断言配置值仍等于契约值。
 *
 * ⭐ 可解释性硬约束：reason 里出现的每一个分值「相加必须严格等于 score」。
 *    实现办法：三段得分各自四舍五入到 2 位小数，再以「分」为单位做整数相加，
 *    因此 reason 上显示的数字与 score 在浮点上完全一致，不会出现
 *    "reason 写 +30、score 却是 59.7" 的自相矛盾。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowSec, toTs } from "../util/time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, "../../config/match-rules.json");

function loadTakeoutRules() {
  const raw = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  const t = raw.takeout;
  if (!t) throw new Error("config/match-rules.json 缺少 takeout 段");
  return t;
}

const RULES = loadTakeoutRules();

/** 契约 §2 的三段权重（只读） */
export const WEIGHTS = Object.freeze({
  accessibility: Object.freeze({
    to_building: RULES.accessibility.to_building, // 40
    from_building: RULES.accessibility.from_building, // 20
  }),
  time: Object.freeze({
    full: RULES.time.full, // 30
    overlap_ge_50pct: RULES.time.overlap_ge_50pct, // 20
    overlap_lt_50pct: RULES.time.overlap_lt_50pct, // 10
  }),
  reward_max_score: RULES.reward_max_score, // 30
});

/** 推送阈值 60（只含 >= 阈值的候选） */
export const PUSH_THRESHOLD = RULES.push_threshold;
/** 单任务最多同时推 3 名 */
export const MAX_PUSH_PER_TASK = RULES.max_push_per_task;
/** 同一 runner 5 分钟内不重复推送同一任务 */
export const DEDUPE_WINDOW_SECONDS = RULES.dedupe_window_seconds;

/** 0.1 分 = 1 分（内部按整数「分」运算，保证 reason 与 score 严格一致） */
const toCents = (n) => Math.round(Number(n) * 100);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** reason 里的数字格式：30 / 20 / 29.99（去掉无意义的小数位） */
function fmt(n) {
  return String(round2(n));
}

/** runner.reachable_buildings / time_windows 既可能是 JSON 字符串（DB 行），也可能是数组 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** active=0 / false 的能力登记不参与撮合（关掉接单开关即退出候选池） */
function isInactive(runner) {
  return runner?.active === 0 || runner?.active === false;
}

/**
 * 单对候选评分
 * @param {object} task    tasks 行 / 视图对象（需要 from_building, to_building, deadline_ts, reward_min, reward_max）
 * @param {object} runner  runners 行（reachable_buildings / time_windows 可为 JSON 字符串）
 * @param {number} [now]   Unix 秒（可注入，便于测试）
 * @returns {null|{score:number, reason:string, parts:{accessibility:number,time:number,reward:number,total:number}}}
 *          null = 出局（不可达 / 时间完全不重叠 / 任务已过期 / 能力已关闭）
 */
export function matchScore(task, runner, now = nowSec()) {
  if (!task || !runner) return null;
  if (isInactive(runner)) return null;

  const nowTs = Number(now);
  const toBuilding = String(task.to_building ?? "");
  const fromBuilding = String(task.from_building ?? "");

  // ---------- 1) 可达性 40 ----------
  const reachable = asArray(runner.reachable_buildings).map((b) => String(b));
  let accessibility;
  let reachNote;
  if (reachable.includes(toBuilding)) {
    accessibility = WEIGHTS.accessibility.to_building; // 40
    reachNote = `可达 ${toBuilding}`;
  } else if (reachable.includes(fromBuilding)) {
    accessibility = WEIGHTS.accessibility.from_building; // 20
    reachNote = `仅可达 ${fromBuilding}（取件楼）`;
  } else {
    return null; // 出局：不经过任何一端
  }

  // ---------- 2) 时间 30 ----------
  const deadline = Number(task.deadline_ts);
  if (!Number.isFinite(deadline)) return null;
  const span = deadline - nowTs;
  if (span <= 0) return null; // 任务已过期 → 出局

  let timeScore = 0;
  let timeNote = "无可用时段";
  for (const w of asArray(runner.time_windows)) {
    // DB 行里是 {start,end}（Unix 秒）；也容忍 service 入参形态 {start_iso,end_iso}，避免调用方踩空
    const ws = Number.isFinite(Number(w?.start)) ? Number(w.start) : toTs(w?.start_iso);
    const we = Number.isFinite(Number(w?.end)) ? Number(w.end) : toTs(w?.end_iso);
    if (!Number.isFinite(ws) || !Number.isFinite(we)) continue;
    const overlap = Math.max(0, Math.min(we, deadline) - Math.max(ws, nowTs));
    if (overlap <= 0) continue;
    const ratio = overlap / span;
    if (overlap >= span && ws <= nowTs) {
      timeScore = WEIGHTS.time.full; // 30
      timeNote = "时段完全覆盖";
      break;
    }
    if (ratio >= 0.5) {
      if (WEIGHTS.time.overlap_ge_50pct > timeScore) {
        timeScore = WEIGHTS.time.overlap_ge_50pct; // 20
        timeNote = `时段部分覆盖 ${(ratio * 100).toFixed(0)}%`;
      }
    } else if (WEIGHTS.time.overlap_lt_50pct > timeScore) {
      timeScore = WEIGHTS.time.overlap_lt_50pct; // 10
      timeNote = `时段部分覆盖 ${(ratio * 100).toFixed(0)}%`;
    }
  }
  if (timeScore === 0) return null; // 出局：完全不重叠

  // ---------- 3) 报酬 30 ----------
  const rewardMin = Number(task.reward_min);
  const rewardMax = Number(task.reward_max);
  const rewardFloor = Number(runner.reward_floor);
  const denominator = rewardMax - rewardMin + 1e-6;
  const ratio = Math.min(
    1,
    Math.max(0, (rewardMax - rewardFloor) / denominator),
  );
  const rewardScore = round2(ratio * WEIGHTS.reward_max_score); // 0..30

  // ---------- 总分：按整数「分」相加，保证 reason 数字之和 === score ----------
  const score = round2(
    (toCents(accessibility) + toCents(timeScore) + toCents(rewardScore)) / 100,
  );

  const reason =
    `${reachNote}(+${fmt(accessibility)})，` +
    `${timeNote}(+${fmt(timeScore)})，` +
    `报酬 ${fmt(rewardMax)}元 vs 下限 ${fmt(rewardFloor)}元(+${fmt(rewardScore)})`;

  return {
    score,
    reason,
    parts: { accessibility, time: timeScore, reward: rewardScore, total: score },
  };
}

/**
 * 找出一个任务的全部候选跑腿者
 * @returns {Array<{runner:object, runner_id:string, runner_handle:string|null, score:number, reason:string, parts:object}>}
 *          只含 score >= PUSH_THRESHOLD(60)，按 score 降序（同分按 runner_id 升序，保证稳定）
 */
export function findMatches(task, runners = [], now = nowSec()) {
  const out = [];
  for (const r of Array.isArray(runners) ? runners : []) {
    const scored = matchScore(task, r, now);
    if (!scored) continue;
    if (scored.score < PUSH_THRESHOLD) continue;
    out.push({
      runner: r,
      runner_id: String(r.id ?? ""),
      runner_handle: r.handle ?? r.user_handle ?? null,
      score: scored.score,
      reason: scored.reason,
      parts: scored.parts,
    });
  }
  out.sort(
    (a, b) => b.score - a.score || String(a.runner_id).localeCompare(String(b.runner_id)),
  );
  return out;
}

/** 供服务/接口层复用：从 reason 文本里解析出分值（自检与测试用） */
export function parseReasonScores(reason) {
  const nums = [];
  for (const m of String(reason ?? "").matchAll(/\+(\d+(?:\.\d+)?)/g)) {
    nums.push(Number(m[1]));
  }
  return nums;
}

export default {
  matchScore,
  findMatches,
  parseReasonScores,
  WEIGHTS,
  PUSH_THRESHOLD,
  MAX_PUSH_PER_TASK,
  DEDUPE_WINDOW_SECONDS,
};
