# 分支：main

## 本分支做什么
主分支。**只接受 PR**，不直接推。当前已包含 T0 骨架与核心层（由 `feat/core` 合入）。

## 依赖什么
- 无（这是基准分支）

## 完成标准
- 所有模块分支的验收清单合并后，`npm start` + `npm run seed` + `npm test` + `npm run smoke` 全绿
- 部署站点 `https://demo.knowingly.dpdns.org` 可用

## 不能碰什么
- ⛔ 不许直接 push（必须走 PR）
- ⛔ 不许把 `.env` / `*.db` / `node_modules` 提交进来

## 当前进度
- [x] T0 骨架与核心（`feat/core`）：目录结构、`package.json`、`schema.sql`、DB 初始化、
      auth/ratelimit 中间件、`GET /api/health`、`POST /mcp`（initialize / tools/list / tools/call）、
      `npm run seed`、`npm run smoke`、`npm test`
- [x] G0 协作文件：`.gitignore`、`.env.example`、PR 模板、`CONTRIBUTING.md`、7 个分支与各自 `BRANCH.md`
- [ ] M1 代取撮合（`feat/m1-takeout`）
- [ ] M2 搭子匹配（`feat/m2-buddy`）
- [ ] M3 迎新导览（`feat/m3-welcome`）
- [ ] M4 日程与提醒（`feat/m4-schedule`）
- [ ] F0 门户与 `/agent` 页（`feat/frontend`）
- [ ] 参赛材料（`docs/materials`）

## 合并完成后要做的两件事（仓库管理员）
1. `main` 开分支保护（Settings → Branches），禁止直接 push
2. 给对方 GitHub 账号加 Write 权限（Settings → Collaborators）
