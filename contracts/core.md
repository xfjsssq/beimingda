# 契约 · 核心层（数据库 / HTTP API / 目录结构）

> **2026-10-31 修订：中转码（`contact_code`）机制已废弃 —— 双方都同意后改为站内私聊（`chat_ready` + `thread_id`，见 `docs/API.md` §5/§7）。**
> 口径同时说清两点：① `users.contact_code` 这一列**保留在库里**，仅为兼容老数据/老会话；
> ② **接口一律不再输出它**，也不再有「拿一串码去站外加好友」的流程（新的会话身份走 `X-Session-Token`）。

## 全局冻结项（每个模块文件都自带，便于单独开对话）

| 项 | 值 |
|---|---|
| 比赛 | 第一届"银移杯"校园 AI Agent 创新大赛 · **赛道一 智慧校园 Agent 创意赛道** |
| 队伍 | **啊对对**（TM202610160004，李天齐 / 曹津源） |
| 项目名 | **北民大小助手**（名内禁止半角 `-`） |
| 站点 | `https://demo.knowingly.dpdns.org` |
| **提交截止** | **2026-10-31 23:59:59** |

### 技术栈（冻版，不得更换）

| 层 | 选型 |
|---|---|
| 前端 | 静态 HTML + 原生 JS（Vue 3 CDN 或本地 vendor），**零构建门槛** |
| 地图 | **Leaflet** + **天地图**官方瓦片（不自建底图） |
| 全景 | **Pannellum**（MIT，纯前端 multi-scene tour） |
| 后端 | Node.js 20+ Express + **better-sqlite3** |
| MCP | **远程 Streamable HTTP** `POST /mcp`（**禁止本地 stdio**） |
| 部署 | 现有 Cloudflare 隧道 → `https://demo.knowingly.dpdns.org` |

### ⚠️ 三条不可违反的技术约束

1. **禁止做本地 stdio MCP** —— 评委必须零配置接入，只能远程 URL 型。
2. **CF 隧道有 100 秒硬限制** —— MCP 端点用**短请求 + 流式 HTTP**，**禁止 SSE 长连接保活**；任何单次响应必须 < 90 秒。
3. **所有密钥只从 `process.env` 读**，代码里一个字都不许硬编码。

### 统一返回信封 / 错误码

```json
{"ok":true,  "data":{...}, "error":null}
{"ok":false, "data":null,  "error":{"code":"SCHEMA_REJECTED","message":"..."}}
```
错误码：`SCHEMA_REJECTED` / `NOT_FOUND` / `TIMEOUT` / `QUOTA` / `INTERNAL`

### ⛔ 合规红线（全局）

1. 全站**不收集**真实姓名 / 学号 / 手机号 / 身份证 / 学生证照片 / 校园网账号口令；
   **数据库里不允许出现能存这些的字段**。
2. 全站**不接入、不登录、不抓取学校任何内部系统**；业务代码里**绝不允许出现**
   "输入学号 / 校园网密码"的字段或方案。任何材料里都不提 ATrust / VPN。
3. 站点**没有「上传课表文件」按钮**——这是刻意设计，课表入口只能走对话（MCP）。
4. 演示数据一律 `demo=1`，姓名用"同学A/同学B"，学号用 `2025XXXX`；演示开关 `?demo=1`。
5. 仓库根目录必须有 `.gitignore`，至少包含：
   ```
   .env
   *.env
   node_modules/
   *.db
   *.sqlite
   _recon/
   dist/
   .DS_Store
   *.log
   ```

### 仓库约定

- 每个分支根部放 `BRANCH.md`，写清：**本分支做什么 / 依赖什么 / 完成标准 / 不能碰什么**
- **每完成一个功能点就 commit 并 push**，commit message 用 `feat(模块): 描述` 格式
- 不许直接推 `main`，走 PR


---

## 1. 目录结构（冻版）

```
beimingda/
├── README.md
├── LICENSE
├── package.json                  scripts: start / seed / test
├── .env.example
├── .gitignore
├── src/
│   ├── server.js                 HTTP 入口与路由注册
│   ├── db/
│   │   ├── schema.sql            建表语句
│   │   └── index.js              数据库连接与初始化
│   ├── engine/
│   │   ├── match.js              代取撮合评分引擎
│   │   ├── buddy.js              搭子匹配评分引擎
│   │   └── doubleOpt.js          双选揭示状态机
│   ├── services/
│   │   ├── task.js  runner.js  buddy.js  schedule.js  map.js  scrub.js
│   ├── mcp/
│   │   ├── server.js             MCP Streamable HTTP 端点
│   │   ├── tools.js              ★ 15 个工具 schema（additionalProperties:false）
│   │   └── handlers.js           15 个工具处理器
│   ├── api/
│   │   └── routes.js             HTTP API 路由
│   └── middleware/
│       ├── auth.js               演示令牌鉴权（只读 + 限频）
│       └── ratelimit.js
├── static/
│   ├── index.html  takeout.html  buddy.html  schedule.html  welcome.html  agent.html
│   ├── css/  js/
│   └── vendor/                   leaflet/ pannellum/ vue/（含各自 LICENSE）
├── config/
│   ├── map-nodes.json
│   └── match-rules.json
├── fixtures/                     ★ 全虚构演示数据，demo=1
│   ├── tasks.json  runners.json  buddy-posts.json  schedule.json  README.md
├── pano/
│   ├── manifest.json
│   └── *.jpg
├── scripts/
│   ├── seed.js
│   └── export-clean.sh
└── docs/
    ├── ARCHITECTURE.md  DB-SCHEMA.md  MCP-TOOLS.md
```

---

## 2. 数据库表结构（冻版 · 字段名不得改）

> ⚠️ 这张表在 `src/db/schema.sql` 里实现。**全站不允许出现可存储真实身份信息的字段**。
>
> ℹ️ 下面这段是**冻版快照**（9 张表）。现库共 **13 张表**：另加 `buddy_messages` / `sessions` / `threads` / `thread_messages`，
> `users` 另有 `pass_hash` / `pass_salt`（昵称+密码登录用）。HTTP 侧另有 `POST /api/session`、`GET /api/me`、
> `GET /api/threads*`（站内私聊）——**以 `src/db/schema.sql` 与 `docs/DB-SCHEMA.md` / `docs/API.md` 为准**。

```sql
PRAGMA foreign_keys = ON;

-- 用户：仅昵称，无任何身份字段
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  contact_code  TEXT,  -- 历史遗留列（旧"中转码"已废弃）：保留仅为兼容老库，⛔ 接口不再输出
  created_at    INTEGER NOT NULL,
  demo          INTEGER NOT NULL DEFAULT 0
);

-- 代取任务
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  from_building   TEXT NOT NULL,
  to_building     TEXT NOT NULL,
  station         TEXT NOT NULL,
  deadline_ts     INTEGER NOT NULL,
  reward_min      REAL NOT NULL,
  reward_max      REAL NOT NULL,
  note            TEXT,
  screenshot_path TEXT,
  raw_status      TEXT NOT NULL DEFAULT 'open',
  created_at      INTEGER NOT NULL,
  demo            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tasks_status_deadline ON tasks(raw_status, deadline_ts);

-- 跑腿方能力
CREATE TABLE runners (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id),
  reachable_buildings TEXT NOT NULL,
  reward_floor        REAL NOT NULL,
  time_windows        TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  demo                INTEGER NOT NULL DEFAULT 0
);

-- 撮合记录
CREATE TABLE matches (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  runner_id  TEXT NOT NULL REFERENCES runners(id),
  score      REAL NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pushed',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_matches_task ON matches(task_id, score DESC);

-- 搭子帖（匿名）
CREATE TABLE buddy_posts (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  anon_token   TEXT NOT NULL UNIQUE,
  raw_status   TEXT NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL,
  demo         INTEGER NOT NULL DEFAULT 0
);

-- 双选
CREATE TABLE buddy_consents (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES buddy_posts(id),
  seeker_id  TEXT NOT NULL REFERENCES users(id),
  score      REAL NOT NULL,
  author_ok  INTEGER NOT NULL DEFAULT 0,
  seeker_ok  INTEGER NOT NULL DEFAULT 0,
  revealed   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, seeker_id)
);

-- 日程（只收 6 类匿名字段）
CREATE TABLE schedule_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  weekday       INTEGER NOT NULL,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  title         TEXT NOT NULL,
  room          TEXT,
  weeks         TEXT,
  remind_before INTEGER,
  created_at    INTEGER NOT NULL,
  demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sched_user_weekday ON schedule_items(user_id, weekday, period_start);

-- 地图节点
CREATE TABLE map_nodes (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  category  TEXT NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  pano_url  TEXT,
  pano_yaw  REAL DEFAULT 0,
  desc      TEXT,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- ★ 脱敏审计：只记字段名，绝不记值
CREATE TABLE scrub_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type      TEXT NOT NULL,
  dropped_fields TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
```

**索引与约束不是可选项** —— 撮合查询会走 `idx_tasks_status_deadline`，
`buddy_consents` 的 `UNIQUE(post_id, seeker_id)` 保证同一人对同一帖只能表决一次。

---

## 3. HTTP API 契约（冻版）

```
GET  /api/health                  → {ok, version, time}
GET  /api/tasks?building=&limit=  → Task[]
POST /api/tasks                   → {task_id}
GET  /api/tasks/:id               → Task
POST /api/tasks/:id/match         → Match[]
GET  /api/buddies?kind=           → BuddyPost[]（仅暴露 anon_token）
POST /api/buddies                 → {post_id, anon_token}
GET  /api/schedule?handle=        → ScheduleItem[]
POST /api/schedule                → {item_id}
GET  /api/map/nodes               → MapNode[]
GET  /api/demo/seed               → 灌演示数据（幂等）
```

**约定**
- 所有响应走统一信封 `{ok, data, error}`
- 时间统一用 **Unix 秒（INTEGER）** 存库，**ISO 8601 带时区**出接口。转换封装在 service 层。
- `handle` 为昵称字符串，`user_id` 为 uuid，两者不混用
- MCP 与 HTTP API **共用同一套 service 层**，不允许各写一份业务逻辑

---

## 4. 鉴权（冻版）

```
MCP 端点：  Authorization: Bearer <DEMO_TOKEN>   —— 裸 token，无 Bearer 前缀的兼容也要留
HTTP API：  读接口开放；写接口需 X-Demo-Token 头
限频：      单 IP 60 次/分钟；MCP 工具 30 次/分钟
```

- `DEMO_TOKEN` **只从环境变量读**
- 令牌设计为**只读 + 限频 + 短周期轮换**，泄露无风险
- 材料里一律写占位符 `<DEMO_TOKEN>`，**真实值不进任何参赛材料**

---

## 5. 命名约定

| 对象 | 规则 | 例 |
|---|---|---|
| 数据库表 | 小写下划线，复数 | `tasks`, `buddy_posts` |
| 数据库字段 | 小写下划线 | `reward_min`, `created_at` |
| MCP 工具 | 小写下划线，`模块_动作` | `task_publish`, `buddy_search` |
| HTTP 路径 | 小写中划线 | `/api/tasks/:id/match` |
| JS 文件 | 小驼峰 | `doubleOpt.js` |
| 分支 | `feat/模块名` | `feat/m1-takeout` |
| commit | `feat(模块): 描述` | `feat(m1): 实现撮合评分引擎` |
