/**
 * HTTP API · M1 只读辅助路由（契约外的门户统计口）
 *
 *   GET /api/matches?limit=   → Match[]  最近撮合记录（含 score），按时间倒序
 *
 * 为什么在这里：F0 的首页要显示「平均匹配得分」，契约 §4 没有这条口，
 * 按 M3 `/api/map/summary` 的先例补一条**只读**口（core.md §4：读接口开放，不加令牌）。
 *
 * ⛔ 只读：不写库、不触发撮合
 * ⛔ 脱敏：只出昵称，不出 user_id / 联系方式
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { listRecentMatches } from "../services/task.js";

export function createMatchesRouter() {
  const router = express.Router();

  router.get("/", (req, res, next) => {
    try {
      res.json(ok(listRecentMatches(req.query.limit)));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createMatchesRouter };
