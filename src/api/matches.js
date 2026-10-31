/**
 * HTTP API · M1 撮合记录路由（1 条只读门户口 + 2 条接单写口）
 *
 *   GET  /api/matches?limit=      → Match[]  最近撮合记录（含 score），按时间倒序
 *   POST /api/matches/:id/accept  → {match_id, task_id, state}  写，需 X-Demo-Token
 *   POST /api/matches/:id/decline → {match_id, task_id, state}  写，需 X-Demo-Token
 *
 * 为什么 GET 在这里：F0 的首页要显示「平均匹配得分」，契约 §4 没有这条口，
 * 按 M3 `/api/map/summary` 的先例补一条**只读**口（core.md §4：读接口开放，不加令牌）。
 *
 * 为什么 accept / decline 在这里：契约 §4 的 4 条口都是「以 task 为中心」的
 * （GET/POST /api/tasks、GET /api/tasks/:id、POST /api/tasks/:id/match），
 * 没有「对着一条撮合记录表态」的口。接单 / 拒单是状态机动作，作用对象是 `matches` 的一行，
 * 所以放在 `/api/matches/:id/*` 上，而不是硬塞进 `/api/tasks/:id/*`。
 *
 * 约定：
 *   - ⛔ 本文件只做「取参 → 调 service → 包信封」，SQL 与状态机全在 src/services/task.js
 *     （MCP 走的是同一套 service，不许各写一份）
 *   - ⛔ 只读口脱敏：只出昵称，不出 user_id / 联系方式
 *   - ⛔ 不改任务状态、不动别的候选行：置灰是展示层的事
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { requireWriteToken } from "../middleware/auth.js";
import { listRecentMatches, setMatchState } from "../services/task.js";

export function createMatchesRouter() {
  const router = express.Router();

  router.get("/", (req, res, next) => {
    try {
      res.json(ok(listRecentMatches(req.query.limit, { state: req.query.state, runner_handle: req.query.runner })));
    } catch (e) {
      next(e);
    }
  });

  // POST /api/matches/:id/accept —— 接单（matches.state: pushed → accepted）
  router.post("/:id/accept", requireWriteToken, (req, res, next) => {
    try {
      res.json(ok(setMatchState(req.params.id, "accepted", { as: req.session?.handle ?? req.body?.as })));
    } catch (e) {
      next(e);
    }
  });

  // POST /api/matches/:id/cancel —— 取消接单（accepted → pushed，回到可接单）
router.post("/:id/cancel", requireWriteToken, (req, res, next) => {
  try {
    res.json(ok(setMatchState(req.params.id, "pushed", { as: req.session?.handle ?? req.body?.as })));
  } catch (e) {
    next(e);
  }
});

// POST /api/matches/:id/decline —— 拒单（matches.state: pushed → declined）
  router.post("/:id/decline", requireWriteToken, (req, res, next) => {
    try {
      res.json(ok(setMatchState(req.params.id, "declined", { as: req.session?.handle ?? req.body?.as })));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createMatchesRouter };
