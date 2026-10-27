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
          items: {
            type: "object",
            properties: ITEM_PROPERTIES,
            required: ["weekday", "period_start", "period_end", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["user_handle", "items"],
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
    assertItemsNoExtraKeys(args.items);
    return importSchedule(db, args);
  });
  registerTool("m4", SCHEDULE_TOOLS[1], (args) => addScheduleItem(db, args));
  registerTool("m4", SCHEDULE_TOOLS[2], (args) => ({ items: querySchedule(db, args) }));
  registerTool("m4", SCHEDULE_TOOLS[3], (args) => removeScheduleItem(db, args.item_id));
}

export default { SCHEDULE_TOOLS, registerScheduleTools };
