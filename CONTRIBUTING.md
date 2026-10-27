# CONTRIBUTING · 协作规范

> 两个人 + 各自多开 AI 对话并行开发，**目标是不互相阻塞、不互相覆盖**。
> 完整背景见 `tasks/G0-GitHub仓库初始化.md`。

---

## 1. 分支模型

```
main                      只接受 PR（受保护，禁止直接 push）
├── feat/core             T0 骨架（已完成，已合入 main）
├── feat/m1-takeout       M1 代取撮合
├── feat/m2-buddy         M2 搭子匹配
├── feat/m3-welcome       M3 迎新导览
├── feat/m4-schedule      M4 日程与提醒
├── feat/frontend         F0 门户 + /agent 页 + 共用样式
└── docs/materials        参赛材料
```

**一个任务 = 一个分支**。分支根部的 `BRANCH.md` 必须写清：本分支做什么 / 依赖什么 / 完成标准 / 不能碰什么 / 当前进度。
开工第一件事是同步上游，避免基于旧代码开发：

```bash
git fetch origin
git checkout feat/m1-takeout
git merge origin/main            # 或 git rebase origin/main，二选一，全队统一用 merge
```

---

## 2. 提交规范

```
feat(模块): 描述          新功能   例：feat(m1): 实现撮合评分引擎
fix(模块): 描述           修 bug   例：fix(m4): 修正 period_end < period_start 的校验
docs(模块): 描述          文档     例：docs(materials): 补技术方案架构图
chore(模块): 描述         杂项     例：chore(core): 补 .gitignore 漏项
refactor(模块): 描述      重构
test(模块): 描述          测试
```

- **每完成一个可验证的功能点就 commit 并 push**，不要憋一个巨大的提交
- 提交信息用中文描述，模块名与分支后缀一致（`feat/core` → `core`，`feat/m1-takeout` → `m1`）
- ⛔ 不要提交：`.env`、`*.db`、`node_modules/`、`static/uploads/`、任何密钥

自查（提交前跑一次）：

```bash
git status --short                                  # 不该出现 .env / *.db / node_modules
git log --all -p | grep -iE "sk-[A-Za-z0-9]{16,}|token=|password|secret"
```

---

## 3. 冲突高发区（改之前先在群里说一声）

| 文件 | 为什么容易冲突 | 约定 |
|---|---|---|
| `contracts/` 下任何文件 | 接口契约，一改影响所有人 | 只走 PR 到 main，并在 PR 描述写明影响面 |
| `src/db/schema.sql` | 表结构全局唯一 | 只能由 T0/core 改；模块需要新表先提出来 |
| `src/mcp/tools.js` | 各模块都往里注册工具 | **只加自己模块区块里的几行**，不重排、不格式化整文件 |
| `src/mcp/handlers.js` | 同上 | 同上 |
| `src/api/routes.js` | 各模块都加路由 | 只在自己的挂载点加，不动别人的 |
| `static/css/app.css` | 5 个页面共用 | 由 `feat/frontend` 主改；别人要加类名先沟通 |

---

## 4. PR 流程

1. 分支开发完成 → `git push origin feat/<模块>`
2. 在 GitHub 开 PR：**base = `main`**，填写 `.github/pull_request_template.md`（模板会自动带入）
3. PR 描述里必须贴出契约验收清单的勾选结果 + 是否改动了契约
4. 另一人 review（至少看：是否违反契约硬约束、是否误提交密钥、是否动了他人的冲突高发区）
5. 合并后**立即同步**：

```bash
git checkout main && git pull
git checkout feat/<模块> && git merge origin/main
```

> ⚠️ 不要用一个 PR 干多个模块。模块越小越好合。

---

## 5. 代码约定（协议层面，不是风格偏好）

- 所有 HTTP API 与 MCP 返回**必须**走 `src/util/envelope.js` 的统一信封
- 时间：**存库 Unix 秒**、**出接口 ISO 8601**，转换只用 `src/util/time.js`
- 业务逻辑只在 `src/services/*`，**HTTP API 与 MCP 共用同一套 service**，⛔ 不许各写一份
- MCP 工具 `inputSchema` 必须 `additionalProperties: false`
- 密钥只从 `process.env` 读，⛔ 代码里一个字都不许硬编码
- 第三方前端库必须本地化到 `static/vendor/` 且带 LICENSE，⛔ 不许依赖外部 CDN

---

## 6. AI 协作约定（两人各自多开对话）

- 每个开发对话**只投喂对应该模块的两份文档**（`contracts/m*.md` + `tasks/M*.md`），不要整目录塞进去
- 让 AI 先读 `BRANCH.md` 再动手，它就知道边界
- AI 产出必须**人工过一遍契约硬约束**：权重、阈值、状态机、白名单、信封格式
- AI 不许自行改 `contracts/` 与 `schema.sql`；确实需要改，走 PR + 群里同步
- 每个模块完成标准里的自测清单**逐条跑过一次**才算完成，别只看代码

---

## 7. 建仓配置（一次性，已由负责人完成，留档备查）

- [x] 仓库建立（Public），`.gitignore` 在**第一次 commit 之前**就位
- [x] `.env.example` 只有键名、无任何真实值
- [x] 7 个分支已建，每个分支根部有 `BRANCH.md`
- [x] PR 模板、`CONTRIBUTING.md`、根 `README.md`
- [ ] **`main` 分支保护**（仓库管理员在 GitHub 页面手动开）：
      Settings → Branches → Add branch protection rule → Branch name pattern 填 `main`
      → 勾 *Require a pull request before merging*（可选再勾 *Require approvals: 1*）
      → 勾 *Do not allow bypassing the above settings* → Save
- [ ] **添加协作者**：Settings → Collaborators → Add people → 填对方 GitHub 用户名（角色 Write）
- [ ] 若误提交了密钥：立即**轮换密钥**，再用 `git filter-repo` 清历史（见 `tasks/G0-GitHub仓库初始化.md`）
