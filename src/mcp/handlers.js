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
import { registerAppTools } from "./handlers/app.js";
import { registerBuddyTools } from "./handlers/buddy.js";
import { registerTakeoutTools } from "./handlers/takeout.js";
import { registerScheduleTools } from "./handlers/schedule.js";

/**
 * 各模块在合并进 main 后，请把自己的注册调用补进下面这个数组。
 * 已接入：M1（5 个）/ M2（3 个）/ M3（2 个）/ M4（4 个）→ **合计 15 个**。
 * ⛔ 只加自己模块那一行，不要动别人的行、不要重排顺序。
 */
const MODULE_REGISTRARS = [
  { module: "m1", register: registerTakeoutTools },
  { module: "m2", register: registerBuddyTools },
  { module: "m3", register: registerMapTools },
  { module: "m4", register: registerScheduleTools },
  { module: "app", register: registerAppTools },   // 跨模块：生成"帮忙打开某界面"的深链
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
