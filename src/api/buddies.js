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
import { ensureThreadForBuddy, threadIdForBuddy } from "../services/chat.js";   // 双方同意 → 站内私聊（替代旧"中转码"）
import { ok } from "../util/envelope.js";
import {
  castConsent,
  listMessages,
  listPosts,
  myApplications,
  myConsole,
  postMessage,
  publishPost,
  searchBuddies,
} from "../services/buddy.js";

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
  // 我的申请：默认仍是「我发出的意愿」数组（契约口径不变）；
  // ?shape=console 时给站内用的三块结构 { posts, intents, mutual }
  router.get("/mine", (req, res) => {
    const handle = req.query.handle ?? req.query.seeker_handle ?? req.session?.handle;
    if (req.query.shape === "console") {
      return res.json(ok(myConsole({ handle, limit: req.query.limit })));
    }
    res.json(ok(myApplications({ seeker_handle: handle, limit: req.query.limit })));
  });

  // 表达意愿（站内直接点，不再必须走 MCP）/ 回复（留言）
  router.post(
    "/:id/consent",
    requireWriteToken,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const me = req.session?.handle;   // ⭐ 有会话就用会话身份
      const r = castConsent({ post_id: req.params.id, seeker_handle: me ?? body.handle ?? body.seeker_handle ?? body.from_handle, agree: body.agree !== false });
      if (body.message) postMessage({ post_id: req.params.id, from_handle: me ?? body.handle ?? body.seeker_handle, body: body.message, kind: "message" });
      // 双方都同意 → 直接把站内私聊会话给它（⛔ 不再给"中转码"）
      if (r && r.revealed === 1) {
        ensureThreadForBuddy(req.params.id);
        r.chat_ready = true;
        r.thread_id = threadIdForBuddy(req.params.id, req.session?.uid) || null;
      }
      res.json(ok(r));
    }),
  );

  router.post(
    "/:id/reply",
    requireWriteToken,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      res.json(ok(postMessage({
        post_id: req.params.id,
        consent_id: body.to_consent_id ?? null,
        from_handle: req.session?.handle ?? body.handle ?? body.from_handle,
        to_handle: body.to_handle ?? null,
        body: body.message,
        kind: body.to_consent_id ? "reply" : "message",
      })));
    }),
  );

  // 留言与回复（只读）
  router.get("/:id/messages", (req, res) => {
    res.json(ok(listMessages(req.params.id)));
  });

  // 契约 §5：发布（写接口 → X-Demo-Token）
  router.post(
    "/",
    requireWriteToken,
    wrap(async (req, res) => {
      const b = req.body ?? {};
      // ⭐ 有会话就用会话身份发帖（谁发的 = 谁）；无会话保留 body（MCP/老调用）
      res.json(ok(await publishPost({ ...b, author_handle: req.session?.handle ?? b.author_handle })));
    }),
  );

  return router;
}

export default { createBuddiesRouter };
