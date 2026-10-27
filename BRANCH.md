# 分支：feat/core

## 本分支做什么
**T0 骨架与核心层** —— 已完成并合入 `main`（本分支保留作为历史与后续核心改动的落点）。

## 依赖什么
无（这是所有分支的祖先）

## 交付内容（已完成）
- 目录结构、`package.json`（`type: module`，`express` + `better-sqlite3`）、`.gitignore`、`.env.example`
- `src/db/schema.sql`（冻版 9 张表 + 索引 + `UNIQUE(post_id, seeker_id)`）、`src/db/index.js`
- `src/util/envelope.js`（统一信封）、`src/util/time.js`（Unix 秒 ↔ ISO 8601）
- `src/middleware/auth.js`（`DEMO_TOKEN` 从 env 读、兼容裸 token）、`src/middleware/ratelimit.js`（60/30 每分钟）
- `src/api/routes.js`（`GET /api/health`）、`src/server.js`（静态托管、6 页路由、`/config.js` 注入）
- `src/mcp/server.js`（远程 Streamable HTTP `POST /mcp`：initialize / tools/list / tools/call；⛔ 无 SSE）
- `src/mcp/tools.js`（工具注册表，强制 `additionalProperties:false`）、`src/mcp/handlers.js`（模块注册挂载点）
- `scripts/seed.js`（幂等灌演示数据）、`scripts/smoke.js`（8 项端到端自检）
- `tests/skeleton.test.js`（10 项单测）
- `contracts/` `tasks/` 随代码入库冻结

## 完成标准（自测结果）
- [x] `npm test` → 10/10 通过
- [x] `npm run smoke` → 8/8 通过
- [x] `npm run seed` 幂等（重复执行不新增重复行）
- [x] `POST /mcp` 错 token → 401；`tools/list` 返回数组
- [x] `schema.sql` 与 `contracts/core.md` §2 逐字段一致
- [x] `git status` 里看不到 `.env` / `*.db` / `node_modules`

## 不能碰什么
- ⛔ 改 `contracts/core.md` 里的表结构与 API 路径（要改先提出并全队同步）
- ⛔ 在骨架层写具体业务逻辑（那是各模块的事）
- ⛔ 引入 SSE 长连接 / 本地 stdio MCP / 任何硬编码密钥

## 当前进度
- [x] 全部完成，已合入 `main`
