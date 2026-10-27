/**
 * M3 · HTTP API 路由
 *   GET /api/map/nodes?category=   → MapNode[]（只读，开放）
 *   GET /api/map/summary           → 类别统计与实景覆盖（自检/首页统计用，非契约必需）
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { listNodes, mapSummary } from "../services/map.js";

export function createMapRouter() {
  const router = express.Router();

  router.get("/nodes", (req, res) => {
    res.json(ok(listNodes({ category: req.query.category })));
  });

  router.get("/summary", (req, res) => {
    res.json(ok(mapSummary()));
  });

  return router;
}

export default { createMapRouter };
