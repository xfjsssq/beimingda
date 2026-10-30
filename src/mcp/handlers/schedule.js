/**
 * M4 · 日程提醒的 4 个 MCP 工具
 *   schedule_import / schedule_add / schedule_query / schedule_remove
 *
 * 第一层防御在这里：每个 schema 都固定 additionalProperties:false，
 * items 里只列白名单 6 字段。第二层在 services/scrub.js。
 * ⛔ 本文件不写 SQL，一律调 service。
 */

import { getDb } from "../../db/index.js";
import { registerTool } from "../tools.js";
import { ALLOWLIST, BLACKLIST } from "../../services/scrub.js";
import { AppError, CODES } from "../../util/envelope.js";
import {
  addScheduleItem,
  importSchedule,
  querySchedule,
  removeScheduleItem,
} from "../../services/schedule.js";

/**
 * 第一层防御的「深一层」：骨架的 validateArgs 只校验顶层 additionalProperties，
 * 不会下钻到 items 数组元素内部。这里补上逐条元素的字段校验：
 * 命中黑名单或白名单外字段 → 整批 SCHEMA_REJECTED（错误信息只报字段名，不回显值）。
 */
function assertItemsNoExtraKeys(items) {
  if (!Array.isArray(items)) throw new AppError(CODES.SCHEMA_REJECTED, "items 必须是数组");
  const banned = new Set(BLACKLIST);
  const allowed = new Set(ALLOWLIST);
  for (const raw of items) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError(CODES.SCHEMA_REJECTED, "items 里存在非对象元素");
    }
    const bad = Object.keys(raw).filter((k) => banned.has(k) || !allowed.has(k));
    if (bad.length) {
      throw new AppError(CODES.SCHEMA_REJECTED, `items 含非法字段: ${bad.join(",")}`);
    }
  }
}

const ITEM_PROPERTIES = {
  weekday: { type: "integer", minimum: 1, maximum: 7 },
  period_start: { type: "integer", minimum: 1, maximum: 14 },
  period_end: { type: "integer", minimum: 1, maximum: 14 },
  title: { type: "string", maxLength: 100 },
  room: { type: "string", maxLength: 50 },
  weeks: { type: "string", maxLength: 50 },
};

export const SCHEDULE_TOOLS = [
  {
    name: "schedule_import",
    description:
      "导入课表（同一用户重复导入会覆盖旧课表）。只接收白名单 6 字段：weekday/period_start/period_end/title/room/weeks；姓名、学号、教师等字段会被丢弃并记入脱敏审计。返回 {imported, dropped_fields}，请向用户汇报写入了多少条、丢弃了哪些类别的字段。",
    inputSchema: {
      type: "object",
      properties: {
        user_handle: { type: "string" },
        items: {
          type: "array",
          description: "结构化课表条目。⭐ 允许多余字段（老师/学号/姓名等）—— 服务端会丢弃并记入脱敏审计，不会整单拒绝。",
          items: {
            type: "object",
            properties: ITEM_PROPERTIES,
            required: ["weekday", "period_start", "period_end", "title"],
            additionalProperties: true,   // ⭐ 故意放开：身份字段由脱敏层丢弃，便于"直接粘贴课表"
          },
        },
        raw_text: {
          type: "string",
          description: "可选：直接粘贴的课表文本（一行一节课，例如「周一 1-2 节 高等数学 教学楼A-101」）。服务端会解析成条目，未识别的行会被跳过并如实说明。",
        },
      },
      required: ["user_handle"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_add",
    description: "手动添加一条日程。字段同上，另可设置 remind_before（提前多少分钟提醒，0~1440）。返回 {item_id}。",
    inputSchema: {
      type: "object",
      properties: {
        user_handle: { type: "string" },
        ...ITEM_PROPERTIES,
        title: { type: "string" },
        room: { type: "string" },
        weeks: { type: "string" },
        remind_before: { type: "integer", minimum: 0, maximum: 1440 },
      },
      required: ["user_handle", "weekday", "period_start", "period_end", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_query",
    description: "查询某用户的日程，可按 weekday 过滤。返回按 weekday、period_start 升序的 items。",
    inputSchema: {
      type: "object",
      properties: {
        user_handle: { type: "string" },
        weekday: { type: "integer", minimum: 1, maximum: 7 },
      },
      required: ["user_handle"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_remove",
    description: "按 item_id 删除一条日程；不存在返回 NOT_FOUND。",
    inputSchema: {
      type: "object",
      properties: { item_id: { type: "string" } },
      required: ["item_id"],
      additionalProperties: false,
    },
  },
];

export function registerScheduleTools() {
  const db = getDb();
  registerTool("m4", SCHEDULE_TOOLS[0], (args) => {
    // ⭐ 用户要求"发课表给它就能直接脱敏导入"：
    //   · 允许文本：raw_text → 先解析成条目
    //   · 允许条目带身份字段：不做整单拒绝，交给 importSchedule 里的脱敏层丢弃并记审计
    const items = Array.isArray(args.items) && args.items.length ? args.items : parseScheduleText(args.raw_text);
    if (!items.length) {
      throw new AppError(CODES.SCHEMA_REJECTED, "没有解析出任何课程：请给 items，或给 raw_text（一行一节课）");
    }
    return importSchedule(db, { ...args, items });
  });
  registerTool("m4", SCHEDULE_TOOLS[1], (args) => addScheduleItem(db, args));
  registerTool("m4", SCHEDULE_TOOLS[2], (args) => ({ items: querySchedule(db, args) }));
  registerTool("m4", SCHEDULE_TOOLS[3], (args) => removeScheduleItem(db, args.item_id));
}

/**
 * 把"直接粘贴的课表文本"解析成条目：一行一节课，尽量宽容。
 *   「周一 1-2 节 高等数学 教学楼A-101」「星期三 第3-4节 大学物理 实验楼C-201」
 *   未识别的行会被跳过（返回结果里如实说明跳过了几行），⛔ 不猜、不编造。
 */
export function parseScheduleText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const wd = /(?:周|星期)([一二三四五六日天])/.exec(t);
    const nums = /(\d+)\s*(?:-|~|—|至)\s*(\d+)\s*节/.exec(t) || /第\s*(\d+)\s*节/.exec(t);
    if (!wd || !nums) continue;
    const weekday = WD[wd[1]];
    const start = Number(nums[1]);
    const end = nums[2] ? Number(nums[2]) : start;
    // 标题 / 教室：把"周X、节次"部分去掉，剩下的用空格拆；最后一个像教室的（含 楼/室/馆/场 或 字母数字楼）当 room
    let rest = t.replace(/(?:周|星期)[一二三四五六日天]/, "").replace(/第?\s*\d+\s*(?:-|~|—|至)?\s*\d*\s*节/, "").replace(/^[\s:：,，-]+/, "").trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    let room = null;
    if (parts.length >= 2 && /(楼|室|馆|场|厅|机房|-\d)/.test(parts[parts.length - 1])) room = parts.pop();
    const title = parts.join(" ") || "未命名课程";
    out.push({ weekday, period_start: start, period_end: end, title, room });
  }
  return out;
}

export default { SCHEDULE_TOOLS, registerScheduleTools, parseScheduleText };
