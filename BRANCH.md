# 分支：feat/m2-buddy

## 本分支做什么
**M2 搭子匹配**：11 字段画像抽取 + 匹配评分（35/30/20/15）+ 双选揭示状态机 + MCP 3 个工具 + `GET/POST /api/buddies` + `static/buddy.html`。

## 依赖什么
- `contracts/core.md`（表结构、信封、鉴权）
- `contracts/m2-buddy.md`（画像 schema、算法权重、状态机，**双选状态机不得简化**）
- `tasks/M2-搭子匹配.md`（任务卡）
- T0 骨架已合入 `main`

## 完成标准
`contracts/m2-buddy.md` §8 自测清单全部勾上，外加断言测试覆盖「`revealed=0` 时返回对象里不含 `contact_code` 键」。

## 不能碰什么
- `src/db/schema.sql`、`contracts/` 下任何文件
- `src/mcp/tools.js` / `handlers.js` 里其他模块的区块
- ⛔ 由 user_id 派生 `anon_token`、未双选成功就返回联系方式、结果里出现院系全名/班级/学号/宿舍号/真实姓名
- ⛔ 把照片纳入评分、承接恋爱匹配需求

## 当前进度
- [ ] `src/engine/buddy.js` 画像抽取 + 评分
- [ ] `src/engine/doubleOpt.js` 双选揭示状态机（单独文件，便于评审对照）
- [ ] `src/services/buddy.js`
- [ ] MCP 3 工具注册与 handler
- [ ] `src/api/routes.js` 2 条路由
- [ ] `static/buddy.html` 4 区块
- [ ] `fixtures/buddy-posts.json` ≥10 条（覆盖 5 种 kind + 语义冲突组合）
