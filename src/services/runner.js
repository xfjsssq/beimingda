/**
 * 跑腿方能力 service（M1）
 *
 * 契约：contracts/m1-takeout.md §1 runners / §3.3 runner_register
 *   - reachable_buildings：JSON 数组（平台规范楼栋名，取自 config/map-nodes.json 的 label）
 *   - reward_floor：可接受报酬下限
 *   - time_windows：JSON，[{"start":ts,"end":ts}]（Unix 秒存库，入参出参用 ISO 8601）
 *   - 同一 user_handle 重复登记 → 覆盖更新（走 runners.user_id 唯一约束的 UPSERT）
 *
 * ⛔ 本文件是与 MCP/HTTP 共用的一套逻辑，不许在别处再写一份。
 * ⛔ 不收集联系方式（runners 表里也没有可存手机号的口子）。
 */
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { CODES, assertNoExtraKeys, reject } from "../util/envelope.js";
import { nowSec, toIso, toTs } from "../util/time.js";
import { ensureUser, normalizeHandle, toFiniteNumber } from "./users.js";

const RUNNER_FIELDS = ["user_handle", "reachable_buildings", "reward_floor", "time_windows"];
const WINDOW_FIELDS = ["start_iso", "end_iso"];
const MAX_BUILDINGS = 20;
const MAX_WINDOWS = 20;

/** 解析并校验 reachable_buildings */
function normalizeBuildings(value) {
  if (!Array.isArray(value)) {
    reject(CODES.SCHEMA_REJECTED, "reachable_buildings 必须是字符串数组");
  }
  if (value.length > MAX_BUILDINGS) {
    reject(CODES.SCHEMA_REJECTED, `reachable_buildings 最多 ${MAX_BUILDINGS} 个楼栋`);
  }
  const out = [];
  for (const item of value) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) reject(CODES.SCHEMA_REJECTED, "reachable_buildings 含空楼栋名");
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 解析并校验 time_windows（入参 ISO → 出参/存库 Unix 秒） */
function normalizeWindows(value) {
  if (!Array.isArray(value)) {
    reject(CODES.SCHEMA_REJECTED, "time_windows 必须是数组");
  }
  if (value.length > MAX_WINDOWS) {
    reject(CODES.SCHEMA_REJECTED, `time_windows 最多 ${MAX_WINDOWS} 段`);
  }
  const out = [];
  for (const [i, w] of value.entries()) {
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      reject(CODES.SCHEMA_REJECTED, `time_windows[${i}] 必须是对象`);
    }
    assertNoExtraKeys(w, WINDOW_FIELDS, `time_windows[${i}]`);
    const start = toTs(w.start_iso);
    const end = toTs(w.end_iso);
    if (start == null || end == null) {
      reject(CODES.SCHEMA_REJECTED, `time_windows[${i}] 的 start_iso / end_iso 不是合法时间`);
    }
    if (end <= start) {
      reject(CODES.SCHEMA_REJECTED, `time_windows[${i}] 的 end_iso 必须晚于 start_iso`);
    }
    out.push({ start, end });
  }
  return out;
}

/**
 * 能力登记（幂等：同一 user_handle 覆盖更新）
 * @returns {{runner_id:string, created:boolean, user_handle:string, reachable_buildings:string[],
 *            reward_floor:number, time_windows:Array<{start_iso:string,end_iso:string}>, active:boolean}}
 */
export function registerRunner(input = {}, opts = {}) {
  assertNoExtraKeys(input, RUNNER_FIELDS, "runner_register");
  const handle = normalizeHandle(input.user_handle);
  const buildings = normalizeBuildings(input.reachable_buildings);
  const floor = toFiniteNumber(input.reward_floor);
  if (floor == null || floor < 0) {
    reject(CODES.SCHEMA_REJECTED, "reward_floor 必须是 ≥ 0 的数字");
  }
  const windows = normalizeWindows(input.time_windows);

  const db = getDb();
  const userId = ensureUser(handle);
  const demo = opts.demo === false ? 0 : 1;

  const prev = db.prepare("SELECT id FROM runners WHERE user_id = ?").get(userId);
  const runnerId = prev?.id ?? `runner_${crypto.randomUUID()}`;

  db.prepare(
    `INSERT INTO runners(id, user_id, reachable_buildings, reward_floor, time_windows, active, created_at, demo)
     VALUES (@id, @user_id, @buildings, @floor, @windows, 1, @created_at, @demo)
     ON CONFLICT(user_id) DO UPDATE SET
       reachable_buildings = excluded.reachable_buildings,
       reward_floor        = excluded.reward_floor,
       time_windows        = excluded.time_windows,
       active              = 1`,
  ).run({
    id: runnerId,
    user_id: userId,
    buildings: JSON.stringify(buildings),
    floor,
    windows: JSON.stringify(windows),
    created_at: nowSec(),
    demo,
  });

  return {
    runner_id: runnerId,
    created: !prev,
    user_handle: handle,
    reachable_buildings: buildings,
    reward_floor: floor,
    time_windows: windows.map((w) => ({ start_iso: toIso(w.start), end_iso: toIso(w.end) })),
    active: true,
  };
}

/** 参与撮合的候选池：只取 active=1，并带上昵称 handle */
export function listActiveRunners() {
  return getDb()
    .prepare(
      `SELECT r.*, u.handle AS handle
         FROM runners r
         JOIN users u ON u.id = r.user_id
        WHERE r.active = 1
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all();
}

/** 按 id 取（不存在返回 null） */
export function getRunner(id) {
  return (
    getDb()
      .prepare(
        `SELECT r.*, u.handle AS handle FROM runners r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      )
      .get(String(id ?? "")) || null
  );
}

/** 按昵称取当前能力登记（不存在返回 null） */
export function getRunnerByHandle(handle) {
  const name = typeof handle === "string" ? handle.trim() : "";
  if (!name) return null;
  return (
    getDb()
      .prepare(
        `SELECT r.*, u.handle AS handle FROM runners r JOIN users u ON u.id = r.user_id WHERE u.handle = ?`,
      )
      .get(name) || null
  );
}

/** 视图：时间出接口一律 ISO 8601 */
export function toRunnerView(row) {
  if (!row) return null;
  const windows = (() => {
    try {
      const parsed = JSON.parse(row.time_windows || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const buildings = (() => {
    try {
      const parsed = JSON.parse(row.reachable_buildings || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  return {
    runner_id: row.id,
    user_handle: row.handle ?? null,
    reachable_buildings: buildings,
    reward_floor: row.reward_floor,
    time_windows: windows.map((w) => ({ start_iso: toIso(w.start), end_iso: toIso(w.end) })),
    active: row.active === 1 || row.active === true,
  };
}

/**
 * 对外（页面/门户）用的脱敏视图：
 *   ⛔ 不含 user_id（内部主键）、不含 contact_code（那是 M2 双选揭示后才有资格出现的东西）
 *   active 用 1/0 表达（门户统计直接 `Number(r.active) === 1` 计数）
 */
export function toPublicRunnerView(row) {
  const view = toRunnerView(row);
  if (!view) return null;
  return { ...view, active: view.active ? 1 : 0 };
}

/** 活跃跑腿者列表（脱敏视图，供门户「活跃跑腿者数」统计） */
export function listActiveRunnerViews() {
  return listActiveRunners().map(toPublicRunnerView);
}

export default {
  registerRunner,
  listActiveRunners,
  listActiveRunnerViews,
  getRunner,
  getRunnerByHandle,
  toRunnerView,
  toPublicRunnerView,
};
