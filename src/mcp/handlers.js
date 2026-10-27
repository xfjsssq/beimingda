/**
 * MCP 工具处理器（冻版骨架）
 *   模块的 handler 实现按模块分区写在这里，或写在模块自己的文件里、
 *   由本文件在 loadHandlers() 里 import 后统一注册。
 *
 * 契约要求：
 *   - 一个模块的 handler 只能调用自己模块的 service（src/services/*）
 *   - ⛔ 不许在这里写 SQL —— 落库一律走 service 层
 *   - 抛 AppError / 返回信封都可以，callTool 会统一归一化
 */

import { registerMapTools } from "./handlers/map.js";
import { registerBuddyTools } from "./handlers/buddy.js";

/**
 * 各模块在合并进 main 后，请把自己的注册调用补进下面这个函数。
 * 目前只有 M3（迎新导览）已接入 = 2 个工具。
 *
 * 示例（M1 合进来之后的样子）：
 *   import { registerTakeoutTools } from "./handlers/takeout.js";
 *   { module: "m1", register: registerTakeoutTools }
 */
const MODULE_REGISTRARS = [
  { module: "m3", register: registerMapTools },
  // { module: "m1", register: registerTakeoutTools },
  { module: "m2", register: registerBuddyTools },
  // { module: "m4", register: registerScheduleTools },
];

let loaded = false;

export function loadHandlers() {
  if (loaded) return;
  for (const r of MODULE_REGISTRARS) {
    r.register();
  }
  loaded = true;
}

/** 仅供测试 */
export function reloadHandlers() {
  loaded = false;
  loadHandlers();
}

export default { loadHandlers, reloadHandlers };
