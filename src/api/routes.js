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
import { createBuddiesRouter } from "./buddies.js";

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

  // ---------- 骨架占位：模块路由挂载点 ----------
  // 各模块在自己的分支里 import 自己的 router，并 router.use(...) 到下面这两个前缀上。
  // 例：router.use("/tasks", createTaskRouter());
  //     router.use("/buddies", createBuddyRouter());
  // ⛔ 不要在这里写具体业务逻辑。

  // ---------- M2 搭子匹配 ----------
  router.use("/buddies", createBuddiesRouter());

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
