/**
 * 限频（冻版）
 *   - 单 IP 60 次/分钟（HTTP API）
 *   - MCP 工具 30 次/分钟
 * 内存固定窗口实现，够用且无外部依赖；⛔ 不许引入 Redis 之类新组件。
 */

const buckets = new Map();

export function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function createRateLimiter({ windowMs = 60_000, max = 60, label = "api" } = {}) {
  const hits = new Map();

  const limiter = (req, res, next) => {
    const key = `${label}:${clientIp(req)}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      res.setHeader("X-RateLimit-Limit", String(max));
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(Math.ceil((rec.start + windowMs - now) / 1000)));
      return res.status(429).json({
        ok: false,
        data: null,
        error: { code: "QUOTA", message: `rate limit exceeded (${max}/${windowMs / 1000}s)` },
      });
    }
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - rec.count)));
    return next();
  };

  limiter.reset = () => hits.clear();
  limiter._buckets = hits;
  limiter.windowMs = windowMs;
  limiter.max = max;
  limiter.label = label;
  return limiter;
}

/**
 * 手动消费一次配额（给 MCP 这种"要按方法粒度限频"的场景用）
 * @returns {{allowed:boolean, remaining?:number, retryAfter?:number}}
 */
export function tryConsume(limiter, req) {
  const key = clientIp(req);
  const now = Date.now();
  const rec = limiter._buckets.get(key);
  if (!rec || now - rec.start >= limiter.windowMs) {
    limiter._buckets.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: limiter.max - 1 };
  }
  rec.count += 1;
  if (rec.count > limiter.max) {
    return {
      allowed: false,
      retryAfter: Math.ceil((rec.start + limiter.windowMs - now) / 1000),
    };
  }
  return { allowed: true, remaining: limiter.max - rec.count };
}

/** HTTP API：单 IP 60 次/分钟 */
export const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60, label: "api" });

/** MCP 端点：单 IP 30 次/分钟（按"工具调用"粒度计算，见 src/mcp/server.js） */
export const mcpLimiter = createRateLimiter({ windowMs: 60_000, max: 30, label: "mcp" });

/** 进程级全局限频桶（可选，供 scripts/ 复用） */
export function bucket(name) {
  if (!buckets.has(name)) buckets.set(name, createRateLimiter({ label: name }));
  return buckets.get(name);
}

export default { createRateLimiter, apiLimiter, mcpLimiter, clientIp, bucket, tryConsume };
