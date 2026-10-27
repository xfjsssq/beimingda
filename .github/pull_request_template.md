<!-- 本模板由 T0 骨架放在 main，供所有分支开 PR 时使用。⛔ 不要删字段，按需填写。 -->

## 本 PR 做了什么

<!-- 一段话说清：改了什么、为什么 -->

## 对应任务卡

<!-- 例：tasks/M1-代取撮合.md；分支：feat/m1-takeout -->

## 归属分支与目标分支

- 来源分支：
- 目标分支：`main`（⛔ 不许直接推 main）

## 自测清单完成情况

<!-- 把契约里的验收清单贴过来，逐条勾 -->

- [ ]
- [ ]

## 是否改动了契约

<!-- 是 → 说明改了什么、为什么、影响哪些分支；否 → 写"未改动" -->
未改动

## 是否碰到冲突高发区

<!-- src/db/schema.sql / src/mcp/tools.js / src/api/routes.js / contracts/ 下任何文件 -->

- [ ] 未碰
- [ ] 碰了 → 已在此说明并已在群里同步

## 提交前检查

- [ ] `npm test` 通过
- [ ] 没有提交 `.env` / `*.db` / `node_modules`（`git status` 自查）
- [ ] commit message 为 `feat(模块): 描述` 格式
- [ ] 新增的 MCP 工具 `inputSchema.additionalProperties === false`
- [ ] 没有硬编码任何密钥（`grep -rn "sk-\|token=" --include=*.js .` 自查）
