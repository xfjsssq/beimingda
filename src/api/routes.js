/**
 * HTTP API 路由（冻版骨架）
 *   - 核心：GET /api/health、GET /api/demo/seed
 *   - 各模块在这里挂自己的路由：
 *       M1  GET  /api/tasks?building=&limit=      open 且未过期
 *           POST /api/tasks                       写，需 X-Demo-Token
 *           GET  /api/tasks/:id
 *           POST /api/tasks/:id/match             写，需 X-Demo-Token
 *           GET  /api/runners  /api/matches        只读门户辅助口
 *       M2  GET  /api/buddies?kind=               仅暴露 anon_token
 *           POST /api/buddies                     写，需 X-Demo-Token
 *       M3  GET  /api/map/nodes?category=
 *       M4  GET  /api/schedule?handle=
 *           POST /api/schedule                    写，需 X-Demo-Token
 *           GET  /api/scrub/audit?limit=          评委核验用
 *
 * 约定（冻版）：
 *   - 所有响应走统一信封 {ok,data,error}
 *   - 时间存库 Unix 秒、出接口 ISO 8601（用 src/util/time.js）
 *   - MCP 与 HTTP API 共用同一套 service，⛔ 不许各写一份业务逻辑
 *   - ⛔ M4 刻意不提供任何课表文件上传接口
 */
import express from "express";
import { ok, toEnvelope, CODES } from "../util/envelope.js";
import { nowSec, toIso } from "../util/time.js";
import { getDb } from "../db/index.js";
import { requireWriteToken } from "../middleware/auth.js";
import { withSession } from "../middleware/session.js";
import { createSessionRouter } from "./session.js";
import { createChatRouter } from "./chat.js";
import { addScheduleItem, getScheduleItem, listScrubAudit, querySchedule } from "../services/schedule.js";
import { createMapRouter } from "./map.js";
import { createDemoRouter } from "./demo.js";
import { createBuddiesRouter } from "./buddies.js";
import { createTaskRouter } from "./tasks.js";
import { createRunnersRouter } from "./runners.js";
import { createMatchesRouter } from "./matches.js";

const VERSION = process.env.npm_package_version || "0.1.0";

export function createApiRouter() {
  const router = express.Router();

  // ⭐ 会话：每个浏览器一份匿名身份（让"别人发的"能被看见）
  //    withSession 只解析不拦；需要身份的接口自己 requireSession
  router.use(withSession);
  router.use("/", createSessionRouter());

  router.use("/", createChatRouter());      // 私聊：双方都同意才有会话
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
  // ⛔ 只加自己模块的那一行，不要动别人的；⛔ 不要在这里写具体业务逻辑。

  // 核心：演示数据（契约 core.md §3：GET /api/demo/seed）
  router.use("/demo", createDemoRouter());

  // M3 迎新导览（GET /api/map/nodes、/api/map/summary）
  router.use("/map", createMapRouter());

  // ---------- M1 代取撮合 ----------
  router.use("/tasks", createTaskRouter());
  router.use("/runners", createRunnersRouter()); // M1 只读：活跃跑腿者（门户统计，已脱敏）
  router.use("/matches", createMatchesRouter()); // M1 只读：最近撮合记录（门户「平均匹配得分」）

  // ---------- M2 搭子匹配 ----------
  router.use("/buddies", createBuddiesRouter());

  // ---------- M4 日程提醒与脱敏审计 ----------
  // 契约 §6：本模块刻意不提供任何课表文件上传接口。
  router.get("/schedule", (req, res, next) => {
    try {
      const { handle, weekday } = req.query;
      const items = querySchedule(getDb(), {
        user_handle: handle,
        weekday: weekday === undefined || weekday === "" ? undefined : Number(weekday),
      });
      res.json(ok(items));
    } catch (e) {
      next(e);
    }
  });

  // 单条详情（只读）：评委点单条看详情时用
  router.get("/schedule/:id", (req, res, next) => {
    try {
      res.json(ok(getScheduleItem(getDb(), req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  // 写接口：按 contracts/core.md §4 必须带 X-Demo-Token
  router.post("/schedule", requireWriteToken, (req, res, next) => {
    try {
      res.json(ok(addScheduleItem(getDb(), req.body ?? {})));
    } catch (e) {
      next(e);
    }
  });

  router.get("/scrub/audit", (req, res, next) => {
    try {
      res.json(ok(listScrubAudit(getDb(), req.query.limit)));
    } catch (e) {
      next(e);
    }
  });

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
