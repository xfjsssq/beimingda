# 分支：feat/m1-takeout

## 本分支做什么
**M1 代取撮合**：撮合评分引擎 + 任务/跑腿 service + MCP 5 个工具 + `GET/POST /api/tasks` 路由 + `static/takeout.html`。

## 依赖什么
- `contracts/core.md`（表结构、信封、鉴权）
- `contracts/m1-takeout.md`（算法与工具契约，**权重 40/30/30 与阈值 60 不得改**）
- `tasks/M1-代取撮合.md`（任务卡）
- T0 骨架已合入 `main`（`src/server.js` `src/db/` `src/mcp/` `src/util/` 可用）

## 完成标准
`contracts/m1-takeout.md` §7 自测清单全部勾上，外加 `npm test` 有撮合断言测试。

## 不能碰什么
- `src/db/schema.sql`（要改先提 PR 到 main）
- `src/mcp/tools.js` / `src/mcp/handlers.js` 里**其他模块**的工具定义（只加 m1 区块）
- `contracts/` 下任何文件
- 截图原图落盘、从截图抽取姓名/手机号/运单号

## 当前进度
- [ ] `src/engine/match.js` 撮合评分引擎（含可解释 reason）
- [ ] `src/services/task.js` `src/services/runner.js`
- [ ] MCP 5 工具注册与 handler
- [ ] `src/api/routes.js` 4 条路由
- [ ] `static/takeout.html` 4 区块
- [ ] `fixtures/tasks.json` ≥8 条 / `fixtures/runners.json` ≥6 名（含匹配与不匹配样本）
