# 任务卡 · G0 · GitHub 仓库初始化与协作流程

> **用法：把本文件整份贴进一个新对话即可开工。本文件自包含，不需要再读其他文档。**

**前置依赖：** 无（可以和 T0 并行，建议最先做）
**对应契约：** 见下方"必读契约"一节
**截止：** 2026-10-31 23:59:59

---

## 本任务目标

建好 GitHub 仓库、配好协作流程，让两个人（以及各自的多开 AI 对话）
能够**并行开发而互不阻塞**。

---

## 交付清单

1. **建仓库**：`beimingda`（**Private**，赛期内不公开）
2. **`.gitignore`**（⭐ 第一件事，必须在首次 commit 之前就位）：
```
.env
*.env
node_modules/
*.db
*.sqlite
*.db-shm
*.db-wal
_recon/
dist/
.DS_Store
Thumbs.db
*.log
static/uploads/
```
3. **`.env.example`**（只有键名，没有值）：
```
SITE_DOMAIN=demo.knowingly.dpdns.org
PORT=3000
DEMO_TOKEN=replace_me
TILE_PROVIDER_KEY=replace_me
DB_PATH=./data/beimingda.db
```
4. **分支保护**：`main` 设为受保护分支，**禁止直接 push**，必须走 PR
5. **建立全部分支**：
```
feat/core          T0 骨架
feat/m1-takeout    M1 代取
feat/m2-buddy      M2 搭子
feat/m3-welcome    M3 迎新导览
feat/m4-schedule   M4 日程
feat/frontend      F0 前端
docs/materials     参赛材料
```
6. **每个分支根部放 `BRANCH.md`**，模板：
```markdown
# 分支：feat/m1-takeout

## 本分支做什么
代取撮合模块：撮合引擎 + MCP 5 工具 + takeout 页面

## 依赖什么
- contracts/core.md（表结构、信封、鉴权）
- contracts/m1-takeout.md（算法与工具契约）
- T0 骨架已合并到 main

## 完成标准
见 contracts/m1-takeout.md §7 自测清单，全部勾上

## 不能碰什么
- src/db/schema.sql（要改先提 PR 到 main）
- src/mcp/tools.js 里其他模块的工具定义
- contracts/ 下任何文件

## 当前进度
- [ ] 撮合引擎 match.js
- [ ] services/task.js
- [ ] MCP 5 工具
- [ ] takeout.html
```
7. **PR 模板** `.github/pull_request_template.md`：
```markdown
## 本 PR 做了什么

## 对应任务卡
（例：tasks/M1-代取撮合.md）

## 自测清单完成情况
（贴出契约里的验收清单，逐条勾）

## 是否改动了契约
（是 → 说明改了什么、为什么；否 → 写"未改动"）
```
8. **`CONTRIBUTING.md`**：写清 commit message 规范（`feat(模块): 描述`）、
   分支命名规范、冲突处理约定（谁都不要同时改 `src/db/schema.sql` 和 `src/mcp/tools.js`）
9. **仓库根 `README.md`**：项目一句话介绍 + 快速开始 + 指向 `开发/README.md` 文档索引

---

## ⚠️ 安全要求（必做）

**在建仓库的第一次 commit 之前**就把 `.gitignore` 放好。原因：

> 一旦密钥进过 commit 历史，即使后来删除，**fork、缓存、搜索引擎快照都会留下**。

若已经误提交过密钥，补救（需要 `git-filter-repo`）：
```bash
git filter-repo --path .env --invert-paths
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force --all
```

并**立即轮换该密钥**（删历史不等于密钥失效）。

---

## 赛期内不公开的理由

1. 承诺书写明「**参赛作品及成果的产权归大赛组委会所有**」，赛期内公开全量源码条款上站不住
2. 初审核查项含「敏感信息脱敏」，公开仓库会被人肉放大风险
3. 提交给评委的源码走**移动云盘 ZIP**，不走 GitHub 链接，所以不需要公开

**赛后**想开源就开源，届时改 Public 即可。

---

## 交付给评委的源码包怎么导出

```bash
git archive --format=zip --prefix=beimingda/ HEAD -o 源码.zip
```
`git archive` 天然**不含 `.git` 目录**，正合工程文件模板那句
「目录内不得包含隐藏文件、系统缓存及与作品无关的大体积文件」。

导出后核对：
```bash
unzip -l 源码.zip | grep -E "\.env$|\.db$|node_modules|\.git/"   # 应无输出
```

---

## 完成标准

- [ ] 仓库已建，`.gitignore` 在首次 commit 之前就位
- [ ] `.env.example` 只有键名，无任何真实值
- [ ] `main` 受保护，不能直接 push
- [ ] 7 个分支已建，每个都有 `BRANCH.md`
- [ ] PR 模板已配
- [ ] `CONTRIBUTING.md` 已写
- [ ] `git log --all -p | grep -iE "sk-|token=|password|secret" ` **无输出**
- [ ] `git status` 里看不到 `*.db` / `.env`

---

## 禁止事项

- ⛔ 在放好 `.gitignore` 之前就 commit
- ⛔ 把 `.env` 或任何密钥提交进仓库
- ⛔ 赛期内把仓库改成 Public
- ⛔ 把 `node_modules` 或数据库文件提交进仓库
