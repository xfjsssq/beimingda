/**
 * HTTP API：搭子匹配（M2）
 *
 *   契约 §5（冻版两条）：
 *     GET  /api/buddies?kind=   → BuddyPost[]（仅暴露 anon_token / 画像 / 时间；无 user_id）
 *     POST /api/buddies         → {post_id, anon_token, profile}（写接口，需 X-Demo-Token）
 *
 *   本模块自加的两条**只读**辅助路由（页面区块二/三/四要用到评分、理由与我的申请）：
 *     GET  /api/buddies/search?kind=&text=&handle=&top_k=  → 候选（含 score / reason / 分段）
 *     GET  /api/buddies/mine?handle=                       → 我发出的意愿及状态
 *   两条都是只读的（不建用户、不落库），因此按 core.md §4「读接口开放」不加令牌。
 *
 *   ⛔ 业务逻辑一律在 src/services/buddy.js（与 MCP 共用），本文件只做参数搬运
 */
import express from "express";
import { requireWriteToken } from "../middleware/auth.js";
import { ok } from "../util/envelope.js";
import { listPosts, myApplications, publishPost, searchBuddies } from "../services/buddy.js";

/** Express 4 不会自动接住 async handler 的异常，这里统一转交 routes.js 的错误中间件 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createBuddiesRouter() {
  const router = express.Router();

  // 契约 §5：列表
  router.get("/", (req, res) => {
    res.json(ok(listPosts({ kind: req.query.kind, limit: req.query.limit })));
  });

  // 辅助（只读）：候选检索，返回与 MCP buddy_search 完全相同的候选结构
  router.get(
    "/search",
    wrap(async (req, res) => {
      const data = await searchBuddies({
        seeker_handle: req.query.handle ?? req.query.seeker_handle,
        kind: req.query.kind,
        text_profile: req.query.text ?? req.query.text_profile,
        top_k: req.query.top_k,
      });
      res.json(ok(data.candidates));
    }),
  );

  // 辅助（只读）：我发出的意愿（⛔ 只给 pending / mutual，不暴露对方个人表决位）
  router.get("/mine", (req, res) => {
    res.json(
      ok(
        myApplications({
          seeker_handle: req.query.handle ?? req.query.seeker_handle,
          limit: req.query.limit,
        }),
      ),
    );
  });

  // 契约 §5：发布（写接口 → X-Demo-Token）
  router.post(
    "/",
    requireWriteToken,
    wrap(async (req, res) => {
      res.json(ok(await publishPost(req.body ?? {})));
    }),
  );

  return router;
}

export default { createBuddiesRouter };
