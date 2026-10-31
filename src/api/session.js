/**
 * 会话接口（2026-10-31）
 *
 *   POST  /api/session   { nickname? }  → { token, uid, nickname }   匿名开户，**不需要**演示令牌
 *   GET   /api/me                        → { uid, nickname, stats }   需要会话令牌
 *   PATCH /api/me        { nickname }    → 改名（唯一性冲突给明确提示）
 *
 * 为什么开户不要求 X-Demo-Token：
 *   演示令牌是"允许写演示数据"的闸门；而匿名开户是真实用户的第一步，
 *   如果也要令牌，真用户根本进不来（那就又变成"只有演示数据"了）。
 *   防滥用交给限频（写接口 60 次/分钟）与昵称校验。
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { requireSession } from "../middleware/session.js";
import { createSession, meView, renameSessionUser, sessionFromToken } from "../services/session.js";

export function createSessionRouter() {
  const router = express.Router();

  // 匿名开户 / 恢复会话：带上已有 token 时直接返回同一个身份
  router.post("/session", (req, res, next) => {
    try {
      const body = req.body ?? {};
      const existing = sessionFromToken(body.token);
      if (existing) {
        return res.json(ok({
          token: body.token, uid: existing.uid, nickname: existing.handle,
          contact_code: existing.contact_code, resumed: true,
        }));
      }
      res.json(ok(createSession({ nickname: body.nickname })));
    } catch (e) {
      next(e);
    }
  });

  router.get("/me", requireSession, (req, res, next) => {
    try {
      res.json(ok(meView(req.session.uid)));
    } catch (e) {
      next(e);
    }
  });

  router.patch("/me", requireSession, (req, res, next) => {
    try {
      res.json(ok(renameSessionUser(req.session.uid, (req.body ?? {}).nickname)));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default { createSessionRouter };
