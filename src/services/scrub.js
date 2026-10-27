/**
 * 脱敏清洗（M4 · 双层防御的第二层）⭐
 *
 * 第一层是 MCP schema 的 additionalProperties:false；本文件是第二层：
 * 无论调用来自 MCP、HTTP 还是脚本直接 import，都必须经过这里。
 *
 * ⛔ 铁律：
 *   1. scrub_audit 只记「字段名」，绝不记任何字段值（哪怕一个字符）
 *   2. title 剥离人名时，被剥掉的内容不得写入日志或审计
 *   3. 白名单只有 6 个字段：weekday / period_start / period_end / title / room / weeks
 */

import { AppError, CODES } from "../util/envelope.js";

/** ⛔ 禁字段黑名单 —— 命中即丢弃该字段（只记字段名） */
export const BLACKLIST = Object.freeze([
  "name", "realName", "studentNo", "studentId", "stuNo", "teacher", "teacherName",
  "className", "major", "college", "grade", "score", "gpa", "rank", "phone", "mobile", "idCard",
]);

/** ✅ 允许进入平台的全部字段 */
export const ALLOWLIST = Object.freeze(["weekday", "period_start", "period_end", "title", "room", "weeks"]);

const BLACKLIST_SET = new Set(BLACKLIST);
const ALLOWLIST_SET = new Set(ALLOWLIST);

/**
 * title 里可能夹带教师姓名，写入前剥离。
 * 宁可多剥一点，也不要漏；被剥掉的字符串绝不外传。
 */
const TITLE_NAME_PATTERNS = [
  /[(（][^)）]{0,16}(老师|教师|教授|讲师|导师)[^)）]{0,16}[)）]/g, // （教师甲老师）整段括注
  /[\u4e00-\u9fa5]{1,4}(老师|教师|教授|讲师|导师)/g, // 教师甲老师
  /\s*[-—·/|]\s*[\u4e00-\u9fa5]{1,4}(老师|教师|教授|讲师|导师)\s*$/g, // 课程B - 教师丙
];

export function sanitizeTitle(title) {
  let t = String(title ?? "").trim();
  for (const re of TITLE_NAME_PATTERNS) t = t.replace(re, "");
  // 剥离后可能残留开头的分隔符（如「教师乙老师-课程B」→「-课程B」）
  return t.replace(/^[\s\-—·/|]+/, "").trim();
}

/**
 * 逐条扫描：命中黑名单或白名单外的字段 → 丢弃该字段并只记录字段名。
 * @param {Array<object>} items
 * @returns {{ clean: Array<object>, dropped: string[] }}
 */
export function scrubScheduleItems(items) {
  const dropped = new Set();
  const clean = [];

  for (const raw of Array.isArray(items) ? items : []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      dropped.add("invalid_item");
      continue;
    }

    const item = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k);
      if (BLACKLIST_SET.has(key)) {
        dropped.add(key); // ⛔ 只记字段名
        continue;
      }
      if (!ALLOWLIST_SET.has(key)) {
        dropped.add(key); // 白名单外一律丢，同样只记字段名
        continue;
      }
      item[key] = v;
    }

    // 必填校验：缺字段 → 整条丢弃
    if (item.weekday == null || item.period_start == null || item.period_end == null || item.title == null) {
      dropped.add(item.title ? "incomplete_row" : "title");
      continue;
    }

    // title 去人名；剥空 → 整条丢弃并记 title
    const title = sanitizeTitle(item.title);
    if (!title) {
      dropped.add("title");
      continue;
    }
    item.title = title;

    // 区间校验：非法区间丢掉该条（调用方会把它升级为 SCHEMA_REJECTED）
    if (item.period_end < item.period_start) {
      dropped.add("bad_period");
      continue;
    }

    clean.push(item);
  }

  return { clean, dropped: [...dropped] };
}

/**
 * 区间合法性硬校验：任何一条越界/倒挂 → 整批 SCHEMA_REJECTED。
 * §7.4 要求 service 层独立判一次，不依赖上游校验。
 */
export function assertItemRanges(items) {
  const list = Array.isArray(items) ? items : [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError(CODES.SCHEMA_REJECTED, "items 里存在非对象元素");
    }
    const { weekday, period_start, period_end } = raw;
    for (const [name, v] of Object.entries({ weekday, period_start, period_end })) {
      if (v == null || !Number.isInteger(Number(v))) {
        throw new AppError(CODES.SCHEMA_REJECTED, `${name} 必须是整数`);
      }
    }
    if (weekday < 1 || weekday > 7) {
      throw new AppError(CODES.SCHEMA_REJECTED, "weekday 必须在 1~7 之间");
    }
    if (period_start < 1 || period_start > 14 || period_end < 1 || period_end > 14) {
      throw new AppError(CODES.SCHEMA_REJECTED, "period_start / period_end 必须在 1~14 之间");
    }
    if (Number(period_end) < Number(period_start)) {
      throw new AppError(CODES.SCHEMA_REJECTED, "period_end 不得小于 period_start");
    }
  }
}

/**
 * 写脱敏审计。droppedFields 只允许是字段名数组。
 * ⛔ 绝不把值写进来。
 */
export function writeAudit(db, itemType, droppedFields, now = Math.floor(Date.now() / 1000)) {
  const names = (Array.isArray(droppedFields) ? droppedFields : [])
    .map((f) => String(f))
    .filter((f) => f.length > 0);
  if (!names.length) return false;
  db.prepare("INSERT INTO scrub_audit(item_type, dropped_fields, created_at) VALUES (?,?,?)").run(
    String(itemType),
    JSON.stringify([...new Set(names)]),
    now,
  );
  return true;
}

export default {
  BLACKLIST,
  ALLOWLIST,
  sanitizeTitle,
  scrubScheduleItems,
  assertItemRanges,
  writeAudit,
};
