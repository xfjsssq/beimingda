/**
 * 会话中间件（2026-10-31）
 *
 *   withSession   —— 可选身份：有合法 token 就挂 req.session，没有也放行（读接口不强制登录）
 *   requireSession—— 需要身份：没有就 401，返回统一信封
 *
 * 令牌从哪来：
 *   · X-Session-Token: <token>        （唯一通道；与 DEMO_TOKEN 的 Authorization 头错开）
 *   ⛔ 与写接口的 X-Demo-Token / MCP 的 Bearer DEMO_TOKEN 是两套东西，别混：
 *      会话 token 代表"我是谁"，DEMO_TOKEN 代表"允许写演示数据"
 */
import { getDb } from "../db/index.js";
import { err, CODES } from "../util/envelope.js";
import { sessionFromToken } from "../services/session.js";

/**
 * 从请求里取会话 token
 *   ⚠️ 只认 X-Session-Token —— 不能读 Authorization：
 *   Authorization: Bearer 是"演示令牌 / MCP 令牌"的通道，两会话混用会让写接口全部 401。
 */
export function extractSessionToken(req) {
  const x = req.get?.("x-session-token") || req.headers?.["x-session-token"] || "";
  return String(x).trim();
}

export function withSession(req, res, next) {
  try {
    const token = extractSessionToken(req);
    req.session = token ? sessionFromToken(token) : null;
  } catch {
    req.session = null;                       // 身份解析失败绝不影响读接口
  }
  next();
}

export function requireSession(req, res, next) {
  if (!req.session) {
    return res.status(401).json(err(CODES.SCHEMA_REJECTED, "缺少或无效的会话令牌（先 POST /api/session 拿一个）"));
  }
  next();
}

/** 是否装了 sessions 表（老库没迁移时不要炸） */
export function sessionsReady() {
  try {
    getDb().prepare("SELECT 1 FROM sessions LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

export default { withSession, requireSession, extractSessionToken, sessionsReady };
