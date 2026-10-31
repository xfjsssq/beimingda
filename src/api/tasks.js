/**
 * HTTP API · M1 代取任务（4 条路由）
 *
 * 契约：contracts/m1-takeout.md §4
 *   GET  /api/tasks?building=&limit=   → Task[]    （只返回 raw_status='open' 且未过期）
 *   POST /api/tasks                    → {task_id} （写接口，需 X-Demo-Token）
 *   GET  /api/tasks/:id                → Task
 *   POST /api/tasks/:id/match          → Match[]   （触发撮合并写 matches；写接口，需 X-Demo-Token）
 *
 * 约定：
 *   - 所有响应走统一信封 {ok,data,error}；时间出接口一律 ISO 8601
 *   - ⛔ 本文件只做「取参 → 调 service → 包信封」，业务逻辑全在 src/services/task.js
 *     （MCP 走的是同一套 service，不许各写一份）
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { requireWriteToken } from "../middleware/auth.js";
import { expressInterest, getTask, listOpenTasks, matchForTask, publishTask } from "../services/task.js";

export function createTaskRouter() {
  const router = express.Router();

  // GET /api/tasks?building=12号宿舍楼&limit=20
  router.get("/", (req, res, next) => {
    try {
      const tasks = listOpenTasks({ building: req.query.building, limit: req.query.limit });
      res.json(ok(tasks));
    } catch (e) {
      next(e);
    }
  });

  // POST /api/tasks （写接口）
  router.post("/", requireWriteToken, (req, res, next) => {
    try {
      const body0 = req.body ?? {};
    // 有会话就用会话身份发布（谁发的 = 谁）；无会话保留 body 里的 handle（MCP/老调用不受影响）
    res.json(ok(publishTask({ ...body0, owner_handle: req.session?.handle ?? body0.owner_handle })));
    } catch (e) {
      next(e);
    }
  });

  // GET /api/tasks/:id
  // POST /api/tasks/:id/interest —— 表达意愿（别人对我发布的单说"我想接"；不改变任务归属）
router.post("/:id/interest", requireWriteToken, (req, res, next) => {
  try {
    res.json(ok(expressInterest(req.params.id, req.session?.handle ?? req.body?.runner_handle)));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", (req, res, next) => {
    try {
      res.json(ok(getTask(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  // POST /api/tasks/:id/match （写接口：会把撮合结果写进 matches）
  router.post("/:id/match", requireWriteToken, (req, res, next) => {
    try {
      const topK = req.body?.top_k ?? req.query.top_k;
      const result = matchForTask(req.params.id, { topK });
      // 契约 §4：data 是 Match[]（撮合明细里带 pushed / skip_reason，便于核验 5 分钟去重）
      res.json(ok(result.matches));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createTaskRouter };
