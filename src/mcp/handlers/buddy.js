/**
 * MCP 工具：搭子匹配（M2 · 3 个）
 *
 *   buddy_publish  —— 发布搭子帖（服务端负责把 text_profile 抽成 §1 的 11 字段画像）
 *   buddy_search   —— 检索候选（kind 一致 + 未一票否决 + score >= 60）
 *   buddy_consent  —— 双选表决（🔒 revealed=0 时不返回 chat_ready；双方同意后可直接站内私聊）
 *
 *   ⛔ inputSchema 严格照抄 contracts/m2-buddy.md §4，且全部 additionalProperties:false
 *   ⛔ handler 里不写 SQL、不写业务逻辑 —— 一律调 src/services/buddy.js（MCP 与 HTTP 共用）
 */
import { registerTool } from "../tools.js";
import { castConsent, publishPost, searchBuddies } from "../../services/buddy.js";

const KIND_ENUM = ["study", "roommate", "project", "sport", "other"];

/** 契约 §4.1 */
export const BUDDY_PUBLISH = {
  name: "buddy_publish",
  description:
    "发布一条匿名搭子帖：给出匿名昵称、类型和一段自然语言描述，服务端负责抽取 11 字段画像并返回匿名标识。照片参数会被接收但不参与评分、也不落库。",
  inputSchema: {
    type: "object",
    properties: {
      author_handle: { type: "string" },
      kind: { type: "string", enum: KIND_ENUM },
      text_profile: {
        type: "string",
        description: "用户的自然语言描述，服务端负责抽取画像",
      },
      photo_path: { type: "string" },
    },
    required: ["author_handle", "kind", "text_profile"],
    additionalProperties: false,
  },
};

/** 契约 §4.2 */
export const BUDDY_SEARCH = {
  name: "buddy_search",
  description:
    "按类型与一段自然语言描述检索搭子候选：只返回 open 且评分 >= 60 的帖，附匹配理由与双选状态。结果里不含任何可反推身份的字段。",
  inputSchema: {
    type: "object",
    properties: {
      seeker_handle: { type: "string" },
      kind: { type: "string", enum: KIND_ENUM },
      text_profile: { type: "string" },
      top_k: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    required: ["seeker_handle", "kind", "text_profile"],
    additionalProperties: false,
  },
};

/** 契约 §4.3 */
export const BUDDY_CONSENT = {
  name: "buddy_consent",
  description:
    "对某条搭子帖表决同意或拒绝（同一帖同一人只能表决一次）。只有**双方都同意**（revealed=1）才会返回 chat_ready；此后双方可在站内直接私聊（GET /api/threads 拿会话）。⛔ 不再下发任何联系方式；平台不交换、也不下发任何联系方式。未揭示时 chat_ready 不会出现。",
  inputSchema: {
    type: "object",
    properties: {
      post_id: { type: "string" },
      seeker_handle: { type: "string" },
      agree: { type: "boolean" },
    },
    required: ["post_id", "seeker_handle", "agree"],
    additionalProperties: false,
  },
};

export const BUDDY_TOOL_SCHEMAS = Object.freeze([BUDDY_PUBLISH, BUDDY_SEARCH, BUDDY_CONSENT]);

/** 各模块在 handlers.js 的 MODULE_REGISTRARS 里调用本函数 */
export function registerBuddyTools() {
  registerTool("m2", BUDDY_PUBLISH, async (args) => publishPost(args));
  registerTool("m2", BUDDY_SEARCH, async (args) => searchBuddies(args));
  registerTool("m2", BUDDY_CONSENT, async (args) => castConsent(args));
  return BUDDY_TOOL_SCHEMAS.length;
}

export default { registerBuddyTools, BUDDY_TOOL_SCHEMAS };
