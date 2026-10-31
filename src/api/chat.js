/**
 * 私聊接口（2026-10-31）
 *
 *   GET  /api/threads                       我的会话列表（双方都同意才有）
 *   GET  /api/threads/:id                   会话详情（含"在聊哪一单/哪一帖"摘要）
 *   GET  /api/threads/:id/messages?after=   消息（after=最后一条 id → 增量拉取，配合 3 秒轮询）
 *   POST /api/threads/:id/messages          发消息（只允许双方；≤500 字；纯表情记为 emoji）
 *
 * 鉴权：全部需要 X-Session-Token（代表"我是谁"）。
 *   ⛔ 与写接口的 X-Demo-Token 严格分开：聊天是用户行为，不该被演示令牌挡住。
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { requireSession } from "../middleware/session.js";
import { getThread, listThreadMessages, listThreads, postThreadMessage } from "../services/chat.js";

export function createChatRouter() {
  const router = express.Router();

  router.get("/threads", requireSession, (req, res, next) => {
    try {
      res.json(ok(listThreads(req.session.uid, { limit: req.query.limit })));
    } catch (e) {
      next(e);
    }
  });

  router.get("/threads/:id", requireSession, (req, res, next) => {
    try {
      res.json(ok(getThread(req.params.id, req.session.uid)));
    } catch (e) {
      next(e);
    }
  });

  router.get("/threads/:id/messages", requireSession, (req, res, next) => {
    try {
      res.json(ok(listThreadMessages(req.params.id, req.session.uid, {
        after: req.query.after, limit: req.query.limit,
      })));
    } catch (e) {
      next(e);
    }
  });

  router.post("/threads/:id/messages", requireSession, (req, res, next) => {
    try {
      res.json(ok(postThreadMessage(req.params.id, req.session.uid, (req.body ?? {}).body)));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createChatRouter };
