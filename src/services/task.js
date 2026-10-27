/**
 * 代取任务 service（M1）—— MCP 与 HTTP API 共用同一套逻辑（⛔ 不许各写一份）
 *
 * 契约：contracts/m1-takeout.md §1 tasks / §3.2 task_publish / §3.4 / §3.5 / §4
 *   - 发布校验：reward_min <= reward_max；deadline 必须晚于当前时间；否则 SCHEMA_REJECTED
 *   - 时间：Unix 秒存库，ISO 8601 出接口（统一走 src/util/time.js）
 *   - 撮合：findMatches（引擎）→ 结果写 matches（state='pushed'）
 *   - 推送去重：同一 (task_id, runner_id) 300 秒内不重复推送
 *   - 单任务最多同时推 3 名（config/match-rules.json 的 max_push_per_task）
 *   - note 按契约是「已脱敏」字段：手机号 / 超长单号在入库前打码，且只把「字段名」写进 scrub_audit
 *
 * ⛔ 不参与交易、不代收款；报酬由双方线下协商
 * ⛔ 不回传 contact_code（联系方式只在 M2 的双选揭示后出现）
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { CODES, assertNoExtraKeys, reject } from "../util/envelope.js";
import { nowSec, toIso, toTs } from "../util/time.js";
import {
  DEDUPE_WINDOW_SECONDS,
  MAX_PUSH_PER_TASK,
  PUSH_THRESHOLD,
  findMatches,
} from "../engine/match.js";
import { ensureUser, normalizeHandle, toFiniteNumber, toInt } from "./users.js";
import { listActiveRunners } from "./runner.js";

/** task_publish / POST /api/tasks 允许的字段（白名单，多一个即 SCHEMA_REJECTED） */
export const TASK_FIELDS = [
  "from_building",
  "to_building",
  "station",
  "deadline_iso",
  "reward_min",
  "reward_max",
  "note",
  "screenshot_path",
  "owner_handle",
];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TEXT_LEN = 60;
const MAX_NOTE_LEN = 300;

const TASK_SELECT = `SELECT t.*, u.handle AS owner_handle
                       FROM tasks t
                       JOIN users u ON u.id = t.owner_id`;

// ---------------------------------------------------------------- 入参校验

function requiredText(value, label, maxLen = MAX_TEXT_LEN) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) reject(CODES.SCHEMA_REJECTED, `${label} 不能为空`);
  if (text.length > maxLen) reject(CODES.SCHEMA_REJECTED, `${label} 过长（≤ ${maxLen} 字符）`);
  return text;
}

/** 手机号 / 超长运单号打码（只做掩码，不做抽取；取件码等短数字保留） */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const TRACKING_RE = /(?<!\d)\d{12,}(?!\d)/g;

function scrubNote(value) {
  if (value == null || value === "") return { text: null, dropped: [] };
  if (typeof value !== "string") reject(CODES.SCHEMA_REJECTED, "note 必须是字符串");
  let text = value.trim().slice(0, MAX_NOTE_LEN);
  if (!text) return { text: null, dropped: [] };
  const dropped = [];
  if (PHONE_RE.test(text)) {
    dropped.push("phone");
    PHONE_RE.lastIndex = 0;
    text = text.replace(PHONE_RE, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`);
  }
  if (TRACKING_RE.test(text)) {
    dropped.push("tracking_no");
    TRACKING_RE.lastIndex = 0;
    text = text.replace(TRACKING_RE, "[已脱敏单号]");
  }
  return { text: text || null, dropped };
}

/** scrub_audit 只记字段名，绝不记值 */
function auditScrub(droppedFields) {
  getDb()
    .prepare("INSERT INTO scrub_audit(item_type, dropped_fields, created_at) VALUES (?,?,?)")
    .run("task", droppedFields.join(","), nowSec());
}

/**
 * 打码后的截图相对路径：只接受安全相对路径（截图原图一律不落盘，见契约 §6）
 * 传 null / 空串 → 允许，落库为 null
 */
function sanitizeScreenshotPath(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    reject(CODES.SCHEMA_REJECTED, "screenshot_path 必须是字符串或 null");
  }
  let p = value.trim().replace(/\\/g, "/");
  if (!p) return null;
  if (/^[A-Za-z]:/.test(p) || p.startsWith("/") || p.includes("..")) {
    reject(CODES.SCHEMA_REJECTED, "screenshot_path 必须是 static/ 下的相对路径");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) {
    reject(CODES.SCHEMA_REJECTED, "screenshot_path 含非法字符");
  }
  if (p.startsWith("static/")) p = p.slice("static/".length);
  return p.slice(0, 200);
}

function clampLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = toInt(value, null);
  if (n == null) return fallback;
  return Math.min(max, Math.max(1, n));
}

// ---------------------------------------------------------------- 视图

/** tasks 行 → 出接口的视图（时间一律 ISO 8601，不含 contact_code） */
export function toTaskView(row) {
  if (!row) return null;
  return {
    task_id: row.id,
    owner_handle: row.owner_handle ?? null,
    from_building: row.from_building,
    to_building: row.to_building,
    station: row.station,
    deadline_ts: row.deadline_ts,
    deadline_iso: toIso(row.deadline_ts),
    reward_min: row.reward_min,
    reward_max: row.reward_max,
    note: row.note ?? null,
    screenshot_path: row.screenshot_path ?? null,
    raw_status: row.raw_status,
    created_at_ts: row.created_at,
    created_at_iso: toIso(row.created_at),
    demo: row.demo === 1,
  };
}

// ---------------------------------------------------------------- CRUD

/**
 * 发布任务
 * @returns {{task_id:string, status:string}}
 */
export function publishTask(input = {}, opts = {}) {
  assertNoExtraKeys(input, TASK_FIELDS, "task_publish");
  const now = Number.isFinite(opts.now) ? Number(opts.now) : nowSec();

  const fromBuilding = requiredText(input.from_building, "from_building");
  const toBuilding = requiredText(input.to_building, "to_building");
  const station = requiredText(input.station, "station");
  const ownerHandle = normalizeHandle(input.owner_handle, "owner_handle");

  const deadlineTs = toTs(input.deadline_iso);
  if (deadlineTs == null) {
    reject(CODES.SCHEMA_REJECTED, "deadline_iso 不是合法的 ISO 8601 时间");
  }
  if (deadlineTs <= now) {
    reject(CODES.SCHEMA_REJECTED, "deadline_iso 必须晚于当前时间（该时间已过期）");
  }

  const rewardMin = toFiniteNumber(input.reward_min);
  const rewardMax = toFiniteNumber(input.reward_max);
  if (rewardMin == null || rewardMax == null) {
    reject(CODES.SCHEMA_REJECTED, "reward_min / reward_max 必须是数字");
  }
  if (rewardMin < 0 || rewardMax < 0) {
    reject(CODES.SCHEMA_REJECTED, "reward_min / reward_max 不能为负数");
  }
  if (rewardMin > rewardMax) {
    reject(CODES.SCHEMA_REJECTED, "reward_min 不得大于 reward_max");
  }

  const { text: note, dropped } = scrubNote(input.note);
  const screenshotPath = sanitizeScreenshotPath(input.screenshot_path);

  const ownerId = ensureUser(ownerHandle);
  const taskId = `task_${crypto.randomUUID()}`;

  getDb()
    .prepare(
      `INSERT INTO tasks(id, owner_id, from_building, to_building, station, deadline_ts,
                         reward_min, reward_max, note, screenshot_path, raw_status, created_at, demo)
       VALUES (@id, @owner_id, @from_building, @to_building, @station, @deadline_ts,
               @reward_min, @reward_max, @note, @screenshot_path, 'open', @created_at, @demo)`,
    )
    .run({
      id: taskId,
      owner_id: ownerId,
      from_building: fromBuilding,
      to_building: toBuilding,
      station,
      deadline_ts: deadlineTs,
      reward_min: rewardMin,
      reward_max: rewardMax,
      note,
      screenshot_path: screenshotPath,
      created_at: now,
      demo: opts.demo === false ? 0 : 1,
    });

  if (dropped.length) auditScrub(dropped);

  return { task_id: taskId, status: "open" };
}

/** 单条（不存在 → NOT_FOUND） */
export function getTask(id) {
  const taskId = typeof id === "string" ? id.trim() : "";
  if (!taskId) reject(CODES.NOT_FOUND, "task not found: 空 id");
  const row = getDb().prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId);
  if (!row) reject(CODES.NOT_FOUND, `task not found: ${taskId}`);
  return toTaskView(row);
}

/**
 * 开放任务列表：只含 raw_status='open' 且 deadline_ts > now
 * @param {{building?:string, limit?:number}} [params] building 同时匹配 from_building 与 to_building
 */
export function listOpenTasks(params = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : nowSec();
  const limit = clampLimit(params.limit);
  const building = typeof params.building === "string" ? params.building.trim() : "";

  let sql = `${TASK_SELECT} WHERE t.raw_status = 'open' AND t.deadline_ts > @now`;
  const args = { now, limit };
  if (building) {
    sql += " AND (t.from_building = @building OR t.to_building = @building)";
    args.building = building;
  }
  sql += " ORDER BY t.deadline_ts ASC, t.created_at ASC LIMIT @limit";

  return getDb()
    .prepare(sql)
    .all(args)
    .map(toTaskView);
}

// ---------------------------------------------------------------- 撮合

/**
 * 触发撮合：引擎评分 → 结果写 matches（含 5 分钟去重与「单任务最多推 3 名」）
 *
 * @param {string} taskId
 * @param {{topK?:number, now?:number}} [opts] topK：返回条数（1..10，默认 3）
 * @returns {{task_id:string, task:object, threshold:number, candidates:number,
 *            pushed_count:number, skipped_count:number, matches:Array<object>}}
 */
export function matchForTask(taskId, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : nowSec();
  const topK = clampLimit(opts.topK, MAX_PUSH_PER_TASK, 10);

  const id = typeof taskId === "string" ? taskId.trim() : "";
  if (!id) reject(CODES.NOT_FOUND, "task not found: 空 id");
  const db = getDb();
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  if (!row) reject(CODES.NOT_FOUND, `task not found: ${id}`);

  const candidates = findMatches(row, listActiveRunners(), now);
  const findByPair = db.prepare(
    `SELECT id, state, created_at FROM matches
      WHERE task_id = ? AND runner_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO matches(id, task_id, runner_id, score, state, created_at)
     VALUES (?,?,?,?,'pushed',?)`,
  );

  const matches = [];
  let pushed = 0;
  let skipped = 0;

  for (const [i, c] of candidates.entries()) {
    if (i >= topK) break;
    const entry = {
      runner_id: c.runner_id,
      runner_handle: c.runner_handle,
      score: c.score,
      reason: c.reason,
      pushed: false,
      match_id: null,
      state: null,
      skip_reason: null,
    };

    if (i >= MAX_PUSH_PER_TASK) {
      // 契约 §2：单任务最多同时推 3 名，其余只展示不落库
      entry.skip_reason = `超出单任务同时推送上限（${MAX_PUSH_PER_TASK} 名）`;
    } else {
      const recent = findByPair.get(row.id, c.runner_id, now - DEDUPE_WINDOW_SECONDS);
      if (recent) {
        // 契约 §2：同一 runner 5 分钟内不重复推送同一任务
        entry.match_id = recent.id;
        entry.state = recent.state;
        entry.skip_reason = `同一跑腿者 ${Math.round(DEDUPE_WINDOW_SECONDS / 60)} 分钟内已推送过该任务`;
        skipped += 1;
      } else {
        const matchId = `match_${crypto.randomUUID()}`;
        insert.run(matchId, row.id, c.runner_id, c.score, now);
        entry.pushed = true;
        entry.match_id = matchId;
        entry.state = "pushed";
        pushed += 1;
      }
    }
    matches.push(entry);
  }

  return {
    task_id: row.id,
    task: toTaskView(row),
    threshold: PUSH_THRESHOLD,
    dedupe_window_seconds: DEDUPE_WINDOW_SECONDS,
    max_push_per_task: MAX_PUSH_PER_TASK,
    candidates: candidates.length,
    matched_count: matches.length,
    pushed_count: pushed,
    skipped_count: skipped,
    matches,
  };
}

/** 某任务已落库的撮合记录（评委核验「引擎真在算」用） */
export function listMatches(taskId, limit = MAX_LIMIT) {
  return getDb()
    .prepare(
      `SELECT m.id, m.task_id, m.runner_id, m.score, m.state, m.created_at, u.handle AS runner_handle
         FROM matches m
         JOIN runners r ON r.id = m.runner_id
         JOIN users   u ON u.id = r.user_id
        WHERE m.task_id = ?
        ORDER BY m.score DESC LIMIT ?`,
    )
    .all(String(taskId ?? ""), clampLimit(limit, MAX_LIMIT, MAX_LIMIT))
    .map((m) => ({
      match_id: m.id,
      task_id: m.task_id,
      runner_id: m.runner_id,
      runner_handle: m.runner_handle,
      score: m.score,
      state: m.state,
      created_at_iso: toIso(m.created_at),
    }));
}

export default {
  publishTask,
  getTask,
  listOpenTasks,
  matchForTask,
  listMatches,
  toTaskView,
  TASK_FIELDS,
};
