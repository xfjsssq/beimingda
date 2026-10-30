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
import {
  canonicalBuildingOrThrow,
  canonicalStation,
  loadMapNodes,
  normalizeBuildingName,
} from "./buildings.js";

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

  // ⭐ 楼栋名先归一、归一失败再拒（config/map-nodes.json 的 label 是撮合唯一口径；
  //    MCP 与 HTTP 共用这一套，⛔ 不许各写一份）。`12号楼` → `12号宿舍楼`。
  const fromBuilding = canonicalBuildingOrThrow(
    requiredText(input.from_building, "from_building"),
    "取件楼栋（from_building）",
  );
  const toBuilding = canonicalBuildingOrThrow(
    requiredText(input.to_building, "to_building"),
    "送达楼栋（to_building）",
  );
  // 快递站名不参与可达性打分 → 归不到规范名时保留原文，避免 Agent 反复试错
  const station = canonicalStation(requiredText(input.station, "station"));
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
  const rawBuilding = typeof params.building === "string" ? params.building.trim() : "";
  // 过滤参数同样归一（`12号楼` 也能筛得到）；归不出来就按原文过滤 → 查不到结果，不报错
  const building = rawBuilding ? normalizeBuildingName(rawBuilding) ?? rawBuilding : "";

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

/**
 * 最近的撮合记录（跨任务，按时间倒序）—— 门户「平均匹配得分」用
 * ⛔ 只读，不写库；只出昵称，不出 user_id / 联系方式
 */
export function listRecentMatches(limit = DEFAULT_LIMIT, opts = {}) {
  const where = [];
  const args = [];
  if (opts.state) { where.push("m.state = ?"); args.push(String(opts.state)); }
  if (opts.runner_handle) { where.push("u.handle = ?"); args.push(String(opts.runner_handle)); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return getDb()
    .prepare(
      `SELECT m.id, m.task_id, m.score, m.state, m.created_at, u.handle AS runner_handle
         FROM matches m
         JOIN runners r ON r.id = m.runner_id
         JOIN users   u ON u.id = r.user_id
         ${clause}
        ORDER BY m.created_at DESC, m.score DESC
        LIMIT ?`,
    )
    .all(...args, clampLimit(limit, DEFAULT_LIMIT, MAX_LIMIT))
    .map((m) => ({
      match_id: m.id,
      task_id: m.task_id,
      runner_handle: m.runner_handle,
      score: m.score,
      state: m.state,
      created_at: m.created_at,
      created_at_iso: toIso(m.created_at),
    }));
}

// ---------------------------------------------------------------- 接单 / 拒单

/**
 * `matches.state` 的合法取值（契约 contracts/m1-takeout.md §1）
 * `pushed`：撮合引擎刚推出去；`accepted`：有人接了；`declined`：明确不接；`expired`：过了截止时间
 */
export const MATCH_STATES = Object.freeze(["pushed", "accepted", "declined", "expired"]);

/**
 * 改一条撮合记录的状态（接单 / 拒单）—— 前端卡片上的「接这一单」「选 TA 接单」走这里。
 *
 * 规则（M1 契约 §1 的 matches.state）：
 *   - 只接受 `accepted` / `declined` 两个目标态（状态机由撮合引擎与这个函数共同推进）
 *   - **只有 `state='pushed'` 的记录能被改**：已经被接走 / 已拒单的记录再改 → SCHEMA_REJECTED，
 *     message 里带上「当前状态」——前端据此提示「这一单已经被别人接走了」，而不是静默失败
 *   - 记录不存在 → NOT_FOUND
 *
 * ⛔ 不在这里改任务状态、⛔ 不写其它候选的行：把「同任务其它候选置灰」留给展示层，
 *    后端只保证「一条撮合记录的状态迁移是原子的」（UPDATE ... WHERE state='pushed'）。
 *
 * @param {string} matchId
 * @param {"accepted"|"declined"} state
 * @returns {{match_id:string, task_id:string, state:string}}
 */
export function setMatchState(matchId, state) {
  const id = typeof matchId === "string" ? matchId.trim() : "";
  if (!id) reject(CODES.NOT_FOUND, "match not found: 空 id");

  const next = typeof state === "string" ? state.trim() : "";
  if (next !== "accepted" && next !== "declined" && next !== "pushed") {
    reject(CODES.SCHEMA_REJECTED, `state 只允许 accepted / declined / pushed（收到「${next || "空"}」）`);
  }

  const db = getDb();
  const row = db.prepare("SELECT id, task_id, state FROM matches WHERE id = ?").get(id);
  if (!row) reject(CODES.NOT_FOUND, `match not found: ${id}`);
  // 状态机：pushed → accepted/declined（接单/拒单）；accepted → pushed（取消接单）
  const allowedFrom = next === "pushed" ? "accepted" : "pushed";
  if (row.state !== allowedFrom) {
    reject(
      CODES.SCHEMA_REJECTED,
      next === "pushed"
        ? `match ${id} 当前状态是 ${row.state}，只有 accepted 的记录可以取消接单`
        : `match ${id} 当前状态是 ${row.state}，只有 pushed 的记录可以被接单 / 拒单`,
    );
  }

  // 带上 state='pushed' 条件：即使并发调用，也只有一个能把行改走
  const changed = db
    .prepare("UPDATE matches SET state = ? WHERE id = ? AND state = ?")
    .run(next, id, allowedFrom).changes;   // 带上原状态：并发下只有一个能改走
  if (changed !== 1) {
    const now = db.prepare("SELECT state FROM matches WHERE id = ?").get(id);
    reject(
      CODES.SCHEMA_REJECTED,
      `match ${id} 当前状态是 ${now?.state ?? "未知"}，只有 pushed 的记录可以被接单 / 拒单`,
    );
  }

  return { match_id: row.id, task_id: row.task_id, state: next };
}

// ---------------------------------------------------------------- 截图理解（task_parse_screenshot）
//
// 契约 §3.1：
//   - 图片直接进模型上下文理解（不做独立 OCR 再转换）
//   - ⛔ 收件人姓名 / 手机号 / 运单号一律不抽取、不复述、不写入
//   - confidence < 0.4 或关键字段全空 → 返回 null 字段而非猜测值
//   - 图片不落服务器磁盘
//
// ⭐ 本仓库的降级实现（.env 里 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三件套为空时）：
//   不落盘、不 OCR、不调外部接口；只用「规则化兜底」在 hint 文本里做**确定性**匹配
//   （楼栋规范名来自 config/map-nodes.json，报酬区间来自「3-5元 / 3块到5块」这类写法）。
//   识别不出来的字段一律返回 null、confidence 记 0；始终不产出姓名/手机号/运单号字段。

const PARSE_FIELDS = [
  "from_building",
  "to_building",
  "station",
  "deadline_iso",
  "reward_min",
  "reward_max",
  "note",
];

/** 图片 base64 上限（express.json 本体上限 2mb，这里只做防御性判断） */
const MAX_IMAGE_B64 = 4_000_000;
const LLM_TIMEOUT_MS = 25_000; // 契约：单次响应必须 < 90 秒

/** LLM 三件套是否配齐（配齐才走真模型调用） */
export function isVisionConfigured() {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

function emptyFields(confidence = 0) {
  const out = { confidence };
  for (const f of PARSE_FIELDS) out[f] = null;
  return out;
}

/** 只保留契约字段 + 强制不出现身份字段（模型即使返回也一律丢弃） */
function finalizeParsed(raw, confidence) {
  const conf = Math.min(1, Math.max(0, Number(confidence) || 0));
  const out = { confidence: conf };
  const usable = conf >= 0.4 && raw && typeof raw === "object";
  for (const f of PARSE_FIELDS) {
    const v = usable ? raw[f] : null;
    out[f] = v === undefined || v === "" ? null : v;
  }
  // ⛔ 关键字段全空时，confidence 归 0（不猜测）
  if (PARSE_FIELDS.every((f) => out[f] == null)) out.confidence = 0;
  return out;
}

/** 规则化兜底：在 hint 里做确定性匹配（完全不看图片内容） */
function parseByRules(hint) {
  const text = typeof hint === "string" ? hint : "";
  if (!text.trim()) return emptyFields(0);

  const nodes = loadMapNodes();
  const labels = nodes
    .map((n) => ({ label: String(n.label ?? ""), category: String(n.category ?? "") }))
    .filter((n) => n.label);

  // 1) 楼栋（按出现顺序取前两个：取件楼 → 送达楼）
  const hits = labels
    .map((n) => ({ ...n, at: text.indexOf(n.label) }))
    .filter((n) => n.at >= 0)
    .sort((a, b) => a.at - b.at);
  const dorms = hits.filter((n) => n.category === "dorm").map((n) => n.label);

  // 2) 快递站（category = service / gate 的规范名）
  const stationHit = hits.find((n) => n.category === "service" || n.category === "gate");

  // 3) 报酬区间：3-5元 / 3块到5块 / 报酬 5 元
  let rewardMin = null;
  let rewardMax = null;
  const range = /(\d+(?:\.\d+)?)\s*(?:元|块)?\s*(?:[-~到至]|——)\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/.exec(text);
  if (range) {
    rewardMin = Number(range[1]);
    rewardMax = Number(range[2]);
    if (rewardMin > rewardMax) [rewardMin, rewardMax] = [rewardMax, rewardMin];
  } else {
    const single = /(\d+(?:\.\d+)?)\s*(?:元|块)/.exec(text);
    if (single) {
      rewardMin = Number(single[1]);
      rewardMax = rewardMin;
    }
  }

  const raw = {
    from_building: dorms[0] ?? null,
    to_building: dorms[1] ?? null,
    station: stationHit?.label ?? null,
    deadline_iso: null, // 时间表述（今晚8点前…）歧义大，规则兜底一律不猜
    reward_min: rewardMin,
    reward_max: rewardMax,
    note: null, // ⛔ 不把自由文本抄进 note，避免把姓名/电话/单号带进库
  };

  const recognized = PARSE_FIELDS.filter((f) => raw[f] != null).length;
  const confidence = recognized === 0 ? 0 : Math.min(0.6, 0.3 + recognized * 0.1);
  return { ...finalizeParsed(raw, confidence), source: "rule_fallback" };
}

/** 真模型调用（只有 LLM 三件套配齐时才走这里；图片只在请求体内，不落盘、不打日志） */
async function parseByLlm(imageBase64, hint) {
  const base = String(process.env.LLM_BASE_URL).replace(/\/+$/, "");
  const model = process.env.LLM_MODEL;
  const dataUrl = /^data:image\//i.test(imageBase64)
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const system =
    "你是校园代取任务的字段抽取器。只输出一个 JSON 对象，键固定为 " +
    "from_building,to_building,station,deadline_iso,reward_min,reward_max,note,confidence。" +
    "识别不出来的字段填 null，不要猜测。deadline_iso 用 ISO 8601 带时区。" +
    "严格禁止输出、复述、改写收件人姓名、手机号、运单号、取件码等任何个人或物流标识信息，" +
    "note 也不要包含这些内容（note 以楼栋/件型/重量等无关信息为限）。";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: `补充说明：${hint || "（无）"}` },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? "";
    const json = JSON.parse(String(text).replace(/^```(?:json)?|```$/gm, "").trim());
    return { ...finalizeParsed(json, json?.confidence ?? 0.8), source: "llm" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 截图 → 结构化任务字段
 * @param {{image_base64:string, hint?:string}} input
 * @returns {Promise<object>} 契约字段 + confidence（⛔ 不含姓名/手机号/运单号）
 */
export async function parseTaskFromImage(input = {}) {
  const image = typeof input.image_base64 === "string" ? input.image_base64.trim() : "";
  if (!image) reject(CODES.SCHEMA_REJECTED, "image_base64 不能为空");
  if (image.length > MAX_IMAGE_B64) {
    reject(CODES.SCHEMA_REJECTED, "image_base64 过大（超过 4MB 文本上限）");
  }
  const payload = image.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/\r\n=\s]+$/.test(payload)) {
    reject(CODES.SCHEMA_REJECTED, "image_base64 不是合法的 base64 文本");
  }
  const hint = typeof input.hint === "string" ? input.hint.slice(0, 200) : "";

  const common = { image_stored: false, pii_extracted: [] };

  if (isVisionConfigured()) {
    try {
      const parsed = await parseByLlm(image, hint);
      return { ...parsed, ...common, degraded: false };
    } catch (e) {
      // 模型不可用 → 如实降级，不猜测、不报错
      return {
        ...parseByRules(hint),
        ...common,
        degraded: true,
        degrade_reason: `LLM 调用失败，已降级为规则兜底：${String(e?.message || e).slice(0, 120)}`,
      };
    }
  }

  return {
    ...parseByRules(hint),
    ...common,
    degraded: true,
    degrade_reason: "未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，走规则化兜底（不 OCR、不落盘）",
  };
}

export default {
  publishTask,
  getTask,
  listOpenTasks,
  matchForTask,
  listMatches,
  listRecentMatches,
  setMatchState,
  MATCH_STATES,
  parseTaskFromImage,
  isVisionConfigured,
  toTaskView,
  TASK_FIELDS,
};
