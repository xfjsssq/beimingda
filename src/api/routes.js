/**
 * HTTP API 路由（冻版骨架）
 *   - 已实现：GET /api/health（T0 验收项）
 *   - 各模块在这里挂自己的路由：
 *       M1  GET  /api/tasks?building=&limit=      open 且未过期
 *           POST /api/tasks                       写，需 X-Demo-Token
 *           GET  /api/tasks/:id
 *           POST /api/tasks/:id/match
 *       M2  GET  /api/buddies?kind=               仅暴露 anon_token
 *           POST /api/buddies
 *       M3  GET  /api/map/nodes?category=
 *       M4  GET  /api/schedule?handle=
 *           POST /api/schedule
 *           GET  /api/scrub/audit?limit=          评委核验用
 *
 * 约定（冻版）：
 *   - 所有响应走统一信封 {ok,data,error}
 *   - 时间存库 Unix 秒、出接口 ISO 8601（用 src/util/time.js）
 *   - MCP 与 HTTP API 共用同一套 service，⛔ 不许各写一份业务逻辑
 */
import express from "express";
import { ok, toEnvelope, CODES } from "../util/envelope.js";
import { nowSec, toIso } from "../util/time.js";
import { createMapRouter } from "./map.js";
import { createDemoRouter } from "./demo.js";
import { createBuddiesRouter } from "./buddies.js";
import { createTaskRouter } from "./tasks.js";
import { createRunnersRouter } from "./runners.js";
import { createMatchesRouter } from "./matches.js";

const VERSION = process.env.npm_package_version || "0.1.0";

export function createApiRouter() {
  const router = express.Router();

  // ---------- 核心：健康检查 ----------
  router.get("/health", (req, res) => {
    res.json(
      ok({
        version: VERSION,
        time: toIso(nowSec()),
        uptime_s: Math.round(process.uptime()),
        mcp: "/mcp",
      }),
    );
  });

  // ---------- 模块路由挂载点 ----------
  // 各模块在自己的分支里 import 自己的 router，并 router.use(...) 到对应前缀上。
  // ⛔ 只加自己模块的那一行，不要动别人的；⛔ 不要在这里写具体业务逻辑。

  // ---------- 核心：演示数据（契约 core.md §3：GET /api/demo/seed） ----------
  router.use("/demo", createDemoRouter());

  // M3 迎新导览（GET /api/map/nodes、/api/map/summary）
  router.use("/map", createMapRouter());

  // ---------- M1 代取撮合 ----------
  router.use("/tasks", createTaskRouter());
  router.use("/runners", createRunnersRouter()); // M1 只读：活跃跑腿者（门户统计，已脱敏）
  router.use("/matches", createMatchesRouter()); // M1 只读：最近撮合记录（门户「平均匹配得分」）

  // ---------- M2 搭子匹配 ----------
  router.use("/buddies", createBuddiesRouter());

  // ---------- M4 日程提醒（待合） ----------
  // router.use("/schedule", createScheduleRouter());
  // router.use("/scrub",    createScrubRouter());

  router.use((req, res) => {
    res.status(404).json({
      ok: false,
      data: null,
      error: { code: CODES.NOT_FOUND, message: `no route for ${req.method} ${req.originalUrl}` },
    });
  });

  // 错误中间件：任何异常都转成统一信封
  // eslint-disable-next-line no-unused-vars
  router.use((e, req, res, next) => {
    const env = toEnvelope(e);
    const status = env.error.code === CODES.NOT_FOUND ? 404 : 400;
    res.status(status).json(env);
  });

  return router;
}

export default { createApiRouter };
