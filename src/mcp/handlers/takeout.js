/**
 * MCP 工具注册 · M1 代取撮合（5 个）
 *
 * 契约：contracts/m1-takeout.md §3（schema 照抄，全部 additionalProperties:false）
 *   task_parse_screenshot / task_publish / runner_register / match_find_for_task / task_list_open
 *
 * 硬约束：
 *   - ⛔ handler 里不写 SQL —— 全部调 src/services/*
 *   - ⛔ HTTP API 与 MCP 共用同一套 service（发布/列表/撮合都走 services/task.js）
 *   - ⛔ 幂等注册：registry 里已有同名工具就跳过（reloadHandlers / resetTools 后重注册时不炸）
 */
import { CODES, reject } from "../../util/envelope.js";
import { hasTool, registerTool } from "../tools.js";
import { parseTaskFromImage, publishTask, listOpenTasks, matchForTask } from "../../services/task.js";
import { registerRunner } from "../../services/runner.js";

/** 只有白名单字段能到达 service；MCP 层已由 validateArgs 拦一次，这里再兜一层 */
function noExtraKeys(args, allowed, label) {
  const extra = Object.keys(args ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length) reject(CODES.SCHEMA_REJECTED, `${label} 含非法字段: ${extra.join(",")}`);
}

// ------------------------------------------------------------------ schemas

const SCHEMAS = {
  task_parse_screenshot: {
    name: "task_parse_screenshot",
    description: "从快递取件截图中抽取结构化代取任务字段（图片直接进模型上下文；不抽姓名/手机号/运单号；原图不落盘）",
    inputSchema: {
      type: "object",
      properties: {
        image_base64: { type: "string", description: "base64 编码的图片" },
        hint: { type: "string", description: "用户的补充说明" },
      },
      required: ["image_base64"],
      additionalProperties: false,
    },
  },

  task_publish: {
    name: "task_publish",
    description: "发布一条代取任务（校验 reward_min <= reward_max、deadline 必须晚于当前时间；报酬由双方线下协商）",
    inputSchema: {
      type: "object",
      properties: {
        from_building: { type: "string" },
        to_building: { type: "string" },
        station: { type: "string" },
        deadline_iso: { type: "string" },
        reward_min: { type: "number" },
        reward_max: { type: "number" },
        note: { type: "string" },
        screenshot_path: { type: "string" },
        owner_handle: { type: "string" },
      },
      required: [
        "from_building",
        "to_building",
        "station",
        "deadline_iso",
        "reward_min",
        "reward_max",
        "owner_handle",
      ],
      additionalProperties: false,
    },
  },

  runner_register: {
    name: "runner_register",
    description: "跑腿方能力登记（同一 user_handle 重复登记覆盖更新；不含任何联系方式字段）",
    inputSchema: {
      type: "object",
      properties: {
        user_handle: { type: "string" },
        reachable_buildings: { type: "array", items: { type: "string" } },
        reward_floor: { type: "number" },
        time_windows: {
          type: "array",
          items: {
            type: "object",
            properties: { start_iso: { type: "string" }, end_iso: { type: "string" } },
            required: ["start_iso", "end_iso"],
            additionalProperties: false,
          },
        },
      },
      required: ["user_handle", "reachable_buildings", "reward_floor", "time_windows"],
      additionalProperties: false,
    },
  },

  match_find_for_task: {
    name: "match_find_for_task",
    description: "对指定任务找候选跑腿者（只返回 score >= 60，按 score 降序，带可解释 reason）",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        top_k: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },

  task_list_open: {
    name: "task_list_open",
    description: "列出开放中的代取任务（只含 raw_status='open' 且未过期；building 同时匹配取件楼与送达楼）",
    inputSchema: {
      type: "object",
      properties: {
        building: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
};

// ------------------------------------------------------------------ handlers

const HANDLERS = {
  /** 截图理解：图片只在本次请求内被使用，不落盘、不写日志 */
  async task_parse_screenshot(args) {
    noExtraKeys(args, ["image_base64", "hint"], "task_parse_screenshot");
    return parseTaskFromImage(args);
  },

  async task_publish(args) {
    noExtraKeys(args, Object.keys(SCHEMAS.task_publish.inputSchema.properties), "task_publish");
    return publishTask(args);
  },

  async runner_register(args) {
    noExtraKeys(args, Object.keys(SCHEMAS.runner_register.inputSchema.properties), "runner_register");
    return registerRunner(args);
  },

  async match_find_for_task(args) {
    noExtraKeys(args, ["task_id", "top_k"], "match_find_for_task");
    const result = matchForTask(args.task_id, { topK: args.top_k });
    return {
      task_id: result.task_id,
      threshold: result.threshold,
      candidates: result.candidates,
      pushed_count: result.pushed_count,
      skipped_count: result.skipped_count,
      matches: result.matches,
    };
  },

  async task_list_open(args) {
    noExtraKeys(args, ["building", "limit"], "task_list_open");
    const tasks = listOpenTasks({ building: args.building, limit: args.limit });
    return { tasks, count: tasks.length };
  },
};

/** 注册 M1 的 5 个工具（幂等） */
export function registerTakeoutTools() {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    if (hasTool(name)) continue;
    registerTool("m1", schema, HANDLERS[name]);
  }
}

export default { registerTakeoutTools, SCHEMAS, HANDLERS };
