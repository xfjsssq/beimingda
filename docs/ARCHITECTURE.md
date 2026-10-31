# 架构说明 · ARCHITECTURE

> 面向本仓库的所有开发者。契约的**解释**在这里，契约的**权威**在 `contracts/`。

---

## 1. 分层

```
┌─────────────────────────────── 接入层 ───────────────────────────────┐
│  HTTP API  /api/*            │  MCP 远程端点  POST /mcp               │
│  src/api/routes.js           │  src/mcp/server.js (Streamable HTTP)   │
│  单 IP 60 次/分钟             │  工具调用 30 次/分钟                    │
└──────────────┬───────────────┴───────────────┬───────────────────────┘
               │                               │
               │            统一信封 src/util/envelope.js
               │            时间转换 src/util/time.js
               ▼                               ▼
┌───────────────────────── 业务层 src/services/* ──────────────────────┐
│  task.js  runner.js  buddy.js  schedule.js  map.js  scrub.js         │
│  ⛔ HTTP 与 MCP 必须共用这一层，不许各写一份业务逻辑                    │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
┌───────────────────────── 引擎层 src/engine/* ────────────────────────┐
│  match.js（代取撮合 40/30/30，阈值 60）                                │
│  buddy.js（搭子匹配 35/30/20/15，阈值 60）                             │
│  doubleOpt.js（双选揭示状态机：揭示前绝不返回 chat_ready / thread_id）  │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
┌───────────────────────── 数据层 src/db/* ────────────────────────────┐
│  better-sqlite3 · schema.sql（冻版 13 张表）· PRAGMA foreign_keys=ON   │
└──────────────────────────────────────────────────────────────────────┘
```

**浏览器侧**：`static/*.html` 是纯静态页（零构建），统一用 `static/js/api.js` 解信封，
共用样式 `static/css/app.css` 与导航 `static/js/nav.js`（由 `feat/frontend` 交付）。

---

## 2. 请求生命周期（以 MCP 工具调用为例）

```
对话（WorkBuddy）
  → POST /mcp  Authorization: Bearer <DEMO_TOKEN>
  → 鉴权 src/middleware/auth.js（定长比较，兼容裸 token）
  → 解析 JSON-RPC：initialize / tools/list / tools/call
  → tools/call 先做限频（30 次/分钟）
  → src/mcp/tools.js::callTool：查表 → validateArgs（required + additionalProperties:false）
  → handler → service → engine → db
  → 统一信封 {ok,data,error} → 放进 result.structuredContent，同时序列化成 content[0].text
  → 单请求单响应返回（⛔ 无 SSE、无长连接，单次 < 90 秒）
```

---

## 3. 三条不可违反的技术约束

1. **禁止本地 stdio MCP** —— 评委必须零配置接入，只能远程 URL 型
2. **CF 隧道 100 秒硬限制** —— 短请求 + 单响应；禁止 SSE 保活；任何单次响应 < 90 秒
3. **密钥只从 `process.env` 读** —— 代码里一个字都不许硬编码

---

## 4. 目录职责速查

| 路径 | 谁维护 | 说明 |
|---|---|---|
| `src/server.js` | core | Express 入口、静态托管、6 页路由映射、`/config.js` 注入 |
| `src/db/*` | core | 表结构与连接；模块**不要**改 schema，需要新表先提出来 |
| `src/util/*` | core | 信封与时间；所有模块共用 |
| `src/middleware/*` | core | 鉴权与限频 |
| `src/mcp/server.js` | core | MCP 传输层，模块不要改 |
| `src/mcp/tools.js` | 各模块 | 各自注册自己的工具（冲突高发区，只加自己的行） |
| `src/mcp/handlers.js` | 各模块 | 挂自己模块的 handler 注册函数 |
| `src/api/routes.js` | 各模块 | 加自己的路由（冲突高发区） |
| `src/services/*` `src/engine/*` | 各模块 | 业务与算法 |
| `static/*` | 各模块 + frontend | 页面；共用样式由 frontend 主改 |
| `fixtures/*` `config/*` | 各模块 | 演示数据与配置 |

---

## 5. 部署链路

```
本地 3000 → Cloudflare 隧道 → https://demo.knowingly.dpdns.org
```
- 健康检查 `GET /api/health` 用于隧道看门狗探测
- 演示与路演**一律带 `?demo=1`**
- 长耗时能力（如截图理解）必须在服务端做超时保护，避免撞上隧道 100 秒上限
