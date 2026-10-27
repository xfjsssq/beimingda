# 北名大小助手 · 开发文档索引

> 本目录按**功能模块拆分**，目的是让每个开发对话**只加载自己需要的那一份文档**，
> 避免把全栈内容塞进一个上下文里造成污染。

**团队：** 啊对对 · **赛道：** 智慧校园 Agent 创意赛道
**提交截止：** 2026-10-31 23:59:59

---

## 怎么用（重要）

**不要**整个目录一起读。按你这次要做的模块，**只读对应的两个文件**：

| 你要做的事 | 读这两个文件 | 上下文占用 |
|---|---|---|
| 搭整体骨架、建表、写 HTTP 路由 | `tasks/T0-骨架与核心.md` | 中 |
| 代取撮合模块 | `contracts/m1-takeout.md` + `tasks/M1-代取撮合.md` | 小 |
| 搭子匹配模块 | `contracts/m2-buddy.md` + `tasks/M2-搭子匹配.md` | 小 |
| 迎新导览模块 | `contracts/m3-welcome.md` + `tasks/M3-迎新导览.md` | 小 |
| 日程与提醒模块 | `contracts/m4-schedule.md` + `tasks/M4-日程提醒.md` | 小 |
| 门户首页 + 各页面 UI | `contracts/frontend.md` + `tasks/F0-前端总览.md` | 中 |
| 开 GitHub 仓库、配协作流程 | `tasks/G0-GitHub仓库初始化.md` | 小 |

**每个 `tasks/*.md` 文件都是自包含的**：里面已包含全局冻结项、验收标准、禁止事项，
单独开一个对话把该文件整份贴进去就能开工，不需要再读别的。

---

## 目录结构

```
开发/
├── README.md                    本文件
├── contracts/                   ★ 接口契约（改这里必须通知所有人）
│   ├── core.md                  数据库表结构 + HTTP API + 目录结构 + 命名约定
│   ├── m1-takeout.md            代取撮合：数据模型 / 算法 / MCP 5 个工具 / API
│   ├── m2-buddy.md              搭子匹配：画像 schema / 算法 / 双选状态机 / MCP 3 个工具
│   ├── m3-welcome.md            迎新导览：地图节点 / 全景 tour / MCP 2 个工具
│   ├── m4-schedule.md           日程提醒：字段白名单 / 脱敏审计 / MCP 4 个工具
│   └── frontend.md              页面清单 / 各页要素 / /agent 页规范
├── tasks/                       ★ 可直接投喂给单个对话的任务卡
│   ├── T0-骨架与核心.md
│   ├── M1-代取撮合.md
│   ├── M2-搭子匹配.md
│   ├── M3-迎新导览.md
│   ├── M4-日程提醒.md
│   ├── F0-前端总览.md
│   └── G0-GitHub仓库初始化.md
└── prompts/                     （预留：可放给 WorkBuddy 投喂的提示词变体）
```

---

## 并行开发的分工建议

| 分支 | 负责 | 内容 |
|---|---|---|
| `main` | 共同 | **只接受 PR**，不直接推 |
| `feat/core` | A | 骨架 + SQLite 建表 + HTTP 路由 + 鉴权 |
| `feat/m1-takeout` | A | 代取撮合（后端 + MCP + 页面） |
| `feat/m2-buddy` | B | 搭子匹配（后端 + MCP + 页面） |
| `feat/m3-welcome` | B | 迎新导览（地图 + 全景，纯前端为主） |
| `feat/m4-schedule` | A | 日程与提醒（含脱敏审计） |
| `feat/frontend` | B | 门户首页 + 共用样式 |
| `docs/materials` | 共同 | 4 份参赛材料 |

**冲突预防**：两人**不要同时改** `contracts/` 下的文件、也不要同时改 `src/db/schema.sql`
和 `src/mcp/tools.js`。这几处要改，先在群里说一声。
