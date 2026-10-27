/**
 * HTTP API · M1 只读辅助路由（契约外的门户统计口）
 *
 *   GET /api/runners   → Runner[]  活跃（active=1）跑腿者列表，**已脱敏**
 *
 * 为什么在这里：F0 的首页要显示「活跃跑腿者数」，契约 §4 没有这条口，
 * 按 M3 `/api/map/summary` 的先例补一条**只读**口（core.md §4：读接口开放，不加令牌）。
 *
 * ⛔ 只读：不写库
 * ⛔ 脱敏：不出 user_id（内部主键）、不出 contact_code / 任何联系方式，只出昵称
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { listActiveRunnerViews } from "../services/runner.js";

export function createRunnersRouter() {
  const router = express.Router();

  router.get("/", (req, res, next) => {
    try {
      res.json(ok(listActiveRunnerViews()));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createRunnersRouter };
