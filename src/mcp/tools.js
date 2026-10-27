/**
 * MCP 工具注册表（冻版骨架）
 *   ⭐ 各模块往这里注册自己的工具：M1 五个 / M2 三个 / M3 两个 / M4 四个 = 14 个。
 *   注册必须满足：
 *     1. inputSchema 里 additionalProperties: false
 *     2. handler 返回统一信封（{ok,data,error}），抛 AppError 会被自动转成信封
 *     3. 业务逻辑写在 src/services/*，⛔ 不许与 HTTP API 各写一套
 *
 * ⚠️ 本文件是"冲突高发区"：多个模块会同时改它。
 *    改的时候只加自己模块那几行（在对应模块区块内），不要动别人的行、不要重排顺序。
 */

import { CODES, ok, toEnvelope } from "../util/envelope.js";

/** name -> { module, schema, handler } */
const registry = new Map();

/**
 * @param {string} module   模块名，如 "m1" / "m2" / "m3" / "m4"
 * @param {object} schema   MCP tool 定义：{ name, description, inputSchema }
 * @param {Function} handler async (args, ctx) => envelope | data
 */
export function registerTool(module, schema, handler) {
  if (!schema?.name) throw new Error("registerTool: schema.name is required");
  if (typeof handler !== "function") throw new Error("registerTool: handler must be a function");
  if (schema.inputSchema && schema.inputSchema.additionalProperties !== false) {
    throw new Error(`registerTool: ${schema.name} 必须设置 additionalProperties:false`);
  }
  if (registry.has(schema.name)) {
    throw new Error(`registerTool: duplicated tool name ${schema.name}`);
  }
  registry.set(schema.name, { module, schema, handler });
  return schema.name;
}

export function listTools() {
  return [...registry.values()].map((t) => ({ ...t.schema, _module: t.module }));
}

/** MCP tools/list 的严格形态：只回 name/description/inputSchema */
export function listToolSchemas() {
  return [...registry.values()].map((t) => ({
    name: t.schema.name,
    description: t.schema.description || "",
    inputSchema: t.schema.inputSchema || { type: "object", additionalProperties: false },
  }));
}

export function getTool(name) {
  return registry.get(name) || null;
}

export function hasTool(name) {
  return registry.has(name);
}

/** 简单 JSON-Schema 子集校验：required / additionalProperties:false / type 基本判定 */
export function validateArgs(schema, args) {
  const s = schema?.inputSchema;
  if (!s) return { valid: true };
  const a = args ?? {};
  if (s.type === "object" && (typeof a !== "object" || Array.isArray(a))) {
    return { valid: false, message: "arguments 必须是对象" };
  }
  for (const key of s.required || []) {
    if (a[key] === undefined || a[key] === null) {
      return { valid: false, message: `缺少必填字段: ${key}` };
    }
  }
  if (s.additionalProperties === false) {
    const allowed = new Set(Object.keys(s.properties || {}));
    const extra = Object.keys(a).filter((k) => !allowed.has(k));
    if (extra.length) return { valid: false, message: `含非法字段: ${extra.join(",")}` };
  }
  return { valid: true };
}

/**
 * 统一调用入口：校验 → 执行 → 归一化成信封
 * @returns {Promise<{ok:boolean,data:any,error:any}>}
 */
export async function callTool(name, args, ctx = {}) {
  const entry = getTool(name);
  if (!entry) {
    return { ok: false, data: null, error: { code: CODES.NOT_FOUND, message: `unknown tool: ${name}` } };
  }
  const check = validateArgs(entry.schema, args);
  if (!check.valid) {
    return {
      ok: false,
      data: null,
      error: { code: CODES.SCHEMA_REJECTED, message: check.message },
    };
  }
  try {
    const out = await entry.handler(args ?? {}, ctx);
    // handler 可以返回裸数据（自动包信封）或已经包好的信封
    if (out && typeof out === "object" && "ok" in out && "data" in out) return out;
    return ok(out);
  } catch (e) {
    return toEnvelope(e);
  }
}

/** 仅供测试：清空注册表 */
export function resetTools() {
  registry.clear();
}

/** 供文档与自检使用：14 个工具的归属统计 */
export function toolCountByModule() {
  const acc = {};
  for (const t of registry.values()) acc[t.module] = (acc[t.module] || 0) + 1;
  return acc;
}

export default {
  registerTool,
  listTools,
  listToolSchemas,
  getTool,
  hasTool,
  validateArgs,
  callTool,
  resetTools,
  toolCountByModule,
};
