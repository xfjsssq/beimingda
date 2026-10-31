# API 文档 · 北民大小助手（beimingda）

> **适用版本**：`main`（2026-10-31 起的会话/私聊版）｜**接口面**：REST + MCP（远程 Streamable HTTP）
> **本文件的字段名与状态码都是对着运行中的服务实测抄下来的**（未实测的部分会明确标注"未实测"）。
> ⛔ 全文令牌一律写作 `<DEMO_TOKEN>`；真实值只存在于服务器 `.env`。
> **配套**：`docs/MCP-TOOLS.md`（MCP 工具细节，注意它内部"14 个"的旧注已过时，以本文 §7 的 **15 个**为准）、
> `docs/ARCHITECTURE.md`（分层）、`部署与运维.md`（部署与运维）。

---

## 1. 概览

| 项 | 值 |
|---|---|
| 生产基础地址 | `https://demo.knowingly.dpdns.org` |
| 本机地址（调试） | `http://127.0.0.1:3000`（由 `PORT` 决定） |
| REST 前缀 | `/api` |
| MCP 端点 | `POST /mcp`（**单请求单响应**；⛔ 不支持 SSE / WebSocket） |
| 请求体 | `application/json`（`express.json({ limit: "2mb" })`） |
| 时间口径 | **出接口统一 ISO 8601**（UTC，形如 `2026-10-31T09:25:23.000Z`）；库里存 Unix 秒 |
| 页面 | `/` `/takeout` `/buddy` `/welcome` `/schedule` `/agent`（加 `?demo=1` 显示演示徽章） |

### 统一信封

**所有 REST 接口**（含错误）都是这个形状：

```json
{ "ok": true,  "data": { }, "error": null }
{ "ok": false, "data": null, "error": { "code": "SCHEMA_REJECTED", "message": "…" } }
```

- `data` 在列表接口里是数组，在详情接口里是对象。
- **MCP 的 `tools/call` 也返回同一个信封**，但套在 JSON-RPC 的 `result` 里：
  `result.structuredContent` 是信封本体，`result.content[0].text` 是它的 JSON 字符串。

### 错误码

| code | HTTP | 含义 | 说明 |
|---|---|---|---|
| `SCHEMA_REJECTED` | 400 / **401** | 参数不合法 **或** 鉴权失败 | 🚩 现状：**401 鉴权失败也复用这个码**（`src/middleware/auth.js::deny`），message 为 `invalid or missing DEMO_TOKEN`；会话缺失时 message 为 `缺少或无效的会话令牌（先 POST /api/session 拿一个）` |
| `NOT_FOUND` | 404 | 资源不存在 / 路由不存在 | 路由兜底 message：`no route for <METHOD> <URL>` |
| `QUOTA` | 429 | 触发限频 | 响应头带 `Retry-After`、`X-RateLimit-Remaining` |
| `TIMEOUT` / `INTERNAL` | 500 | 服务端异常 | `INTERNAL` 通常意味着**代码 bug**（例如改完没重启导致 `X is not defined`） |

---

## 2. ⭐ 两套令牌的分工（务必分清，这是踩过的坑）

| 令牌 | 放哪个头 | 代表什么 | 谁能拿到 | 用在哪 |
|---|---|---|---|---|
| **会话令牌** | `X-Session-Token: <token>` | **我是谁**（浏览器身份） | `POST /api/session` 自助领取，**不需要任何令牌** | `/api/me`、`/api/threads*`、以及所有"谁发的算谁的"写接口（发布 / 发帖 / 表决 / 接单） |
| **演示令牌** | `Authorization: Bearer <DEMO_TOKEN>`（MCP）<br>`X-Demo-Token: <DEMO_TOKEN>`（HTTP） | **允许写演示数据** | 站长配置 + 单独发给评委 | MCP `/mcp` 端点（所有方法）、REST 写接口 |

**三条硬规则**

1. **`X-Session-Token` 只在 `X-Session-Token` 头里传**，⛔ 不能借 `Authorization`：
   `Authorization: Bearer` 是演示/MCP 令牌的通道，两者混用会让写接口**全部 401**
   （历史 bug：浏览器把会话令牌塞进 Authorization，结果发布会话身份失效）。
2. **写接口要"两把钥匙"**：`POST /api/tasks` 既需要 `X-Demo-Token`（允许写）**又**可以带 `X-Session-Token`（决定归属）。
   只带会话令牌 → 401；只带演示令牌 → 成功，但归属取 body 里的 `owner_handle`（MCP/脚本调用就是这种形态）。
3. **`POST /api/session` 免演示令牌**（刻意设计）：演示令牌是"允许写演示数据"的闸门，
   而匿名开户是真实用户的第一步；若也要令牌，真用户根本进不来。防滥用靠限频与昵称校验。

> 页面侧：服务端通过 `GET /config.js` 注入 `window.__DEMO_TOKEN__` 供前端调写接口（按契约它本就是"只读+限频+可轮换"的演示令牌）。
> 因此**不要把 `/config.js` 的返回值当秘密**；真正的秘密是"谁能拿到它"——目前它对任何访客可见。

---

## 3. 限频与响应头

| 维度 | 默认 | 可配置 | 出处 |
|---|---|---|---|
| REST 读（GET/HEAD） | **240 次/分钟/IP** | `API_READ_LIMIT` | `src/server.js` |
| REST 写（POST/PATCH…） | **60 次/分钟/IP** | `API_WRITE_LIMIT` | `src/server.js` |
| MCP `tools/call` | **30 次/分钟/IP**（**硬编码**） | ⛔ 不可配 | `src/middleware/ratelimit.js` |

- IP 取 `X-Forwarded-For` **第一段**（`clientIp()`）；在 Cloudflare 后面要正确限频，nginx 必须配 `real_ip`（见 `deploy/nginx-demo.conf`）。
- 正常响应会带 `X-RateLimit-Remaining`；窗口首个请求还会带 `X-RateLimit-Limit`。
- 超限：HTTP 429 + `Retry-After: <秒>` + `{"error":{"code":"QUOTA"}}`；
  MCP 侧返回 JSON-RPC error（`code -32000`，`data.code = "QUOTA"`）并带 `Retry-After`。

---

## 4. 会话与身份

### `POST /api/session` — 匿名开户 / 恢复会话（**免演示令牌**）

```jsonc
// 请求（都可选）
{ "nickname": "同学A",          // 不传 → 自动生成「同学xxxx」
  "token": "<已有会话令牌>" }    // 传了且有效 → 直接返回同一个身份（resumed: true）
// 返回
{ "ok": true, "data": {
    "token": "<会话令牌，只在这里出现一次，前端存 sessionStorage>",
    "uid": "u-…", "handle": "同学A", "nickname": "同学A",
    "created_at": "2026-10-31T09:25:23.000Z", "has_password": false,
    "resumed": true            // 仅"恢复"时出现
}, "error": null }
```

**昵称规则（合规向）**：2~12 个中文/字母/数字/下划线；**拒绝纯数字**、**拒绝 11 位以上连续数字**
（避免看起来像学号/手机号）；重名会自动加后缀，改名冲突会明确报错而不是 500。

| 实测 | 结果 |
|---|---|
| `POST /api/session {}` | `200`，自动昵称（例：`同学x9vj`） |
| `POST /api/session {"nickname":"20250101"}` | `400 SCHEMA_REJECTED`（纯数字） |
| `POST /api/session {"nickname":"<13 个字>"}` | `400 SCHEMA_REJECTED`（超长） |
| `POST /api/session {"token":"<已有>"}` | `200`，`resumed=true`，同一个 uid |

- 令牌在库里**只存 sha256**（`sessions.token_hash`），明文只在返回里出现一次；删一行即失效。
- **不存姓名 / 学号 / 手机号 / IP**；表结构见 `src/db/schema.sql` 的 `sessions`。

### `GET /api/me` — 我的资料与活动量（需要 `X-Session-Token`）

```json
{ "ok": true, "data": {
    "uid": "u-…", "nickname": "同学A", "has_password": false, "demo": false,
    "created_at": "…", "stats": {
      "tasks_published": 0, "interests_expressed": 0, "buddy_posts": 0,
      "buddy_messages": 0, "schedule_items": 0 } }, "error": null }
```

不带令牌 → `401`（`缺少或无效的会话令牌（先 POST /api/session 拿一个）`）。

### `PATCH /api/me` — 改昵称（需要 `X-Session-Token`）

```jsonc
{ "nickname": "新昵称" }   // 校验规则同上；被别人占用 → 400，"昵称「X」已经有人用了，换一个吧"
```

---

## 5. 私聊（站内消息）

> **设计**：以前的"双方都同意 → 给一串中转码，让人去别的软件加好友"被拿掉了。
> 现在 **双方都同意 → 站内直接开聊**（`chat_ready` + `thread_id`），⛔ 表里不存任何联系方式。

### 5.1 谁能聊（严格执行，service 层校验，不是前端藏按钮）

| 场景 | 建立会话的条件 | 参与人 |
|---|---|---|
| 代取（`kind="task"`） | 该任务的 `matches.state = 'accepted'` | 任务发布者 ↔ 接单者 |
| 搭子（`kind="buddy"`） | 该帖 `buddy_consents.revealed = 1`（双方都点头） | 帖主 ↔ 申请者 |

会话是**按需物化**的：读列表时把符合条件的关系 upsert 成 `threads` 行（幂等），不需要"建群"接口。

### 5.2 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/threads?limit=50` | 会话令牌 | 我的会话列表：对方昵称、头像名、在聊哪一单/哪一帖、最后一条消息 |
| `GET` | `/api/threads/:id` | 会话令牌 | 会话详情（含 `subject`）；非双方 → 400 |
| `GET` | `/api/threads/:id/messages?after=<message_id>&limit=200` | 会话令牌 | 消息列表；`after` 传最后一条 id → **增量拉取**（配合前端 2~5 秒轮询） |
| `POST` | `/api/threads/:id/messages` | 会话令牌 | 发消息；`body` ≤500 字；**纯表情记为 `kind:"emoji"`** |

```jsonc
// GET /api/threads 的 data[0]（实测）
{ "thread_id": "th_…", "kind": "task", "ref_id": "task_…",
  "subject": { "kind":"task", "ref_id":"task_…", "title":"12号宿舍楼 → 15号宿舍楼",
               "subtitle":"取件点：快递驿站 · 报酬 ¥3-5", "status":"open", "deadline":"2026-10-31T12:25:57.000Z" },
  "peer": { "uid":"u-…", "nickname":"同学D", "avatar":"panda" },
  "message_count": 0, "last_message": null, "created_at": "…" }

// GET /api/threads/:id/messages 的 data[0]（实测）
{ "message_id":"msg_…", "body":"你好，快递我放 15 号楼门口了", "kind":"text",
  "mine": true, "from": { "uid":"u-…", "nickname":"私聊甲", "avatar":"ox" }, "at":"…" }
```

### 5.3 端到端实测（2026-10-31，本机 3091 端口）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 会话 A `POST /api/tasks`（发单） | `200` `{task_id: task_…, status:"open"}` |
| 2 | `POST /api/tasks/:id/match` | `200`，候选 3 条（`state=pushed`） |
| 3 | **会话 B 冒充发布者** `POST /api/matches/:id/accept` | `400` `只有发布者（私聊甲）能选人接单，别人不能替他决定` |
| 4 | 会话 A（真发布者）接单 | `200` `{state:"accepted"}` |
| 5 | 会话 A `GET /api/threads` | `200`，1 条会话（对方=同学D，主题=12号宿舍楼 → 15号宿舍楼） |
| 6 | 会话 B `GET /api/threads/:id` | `400` `这个会话与你无关（只有双方都同意之后才能聊）` |
| 7 | 会话 A 发消息 | `200` `kind=text` |
| 8 | 会话 B 发消息 | `400` `这个会话与你无关…` |
| 9 | 空消息 / 501 字 | `400` `消息不能为空` / `400` `一条消息最多 500 个字` |
| 10 | 纯表情 `👍` | `200` `kind=emoji` |
| 11 | `GET …/messages?after=<第一条 id>` | `200`，增量 1 条 |

---

## 6. 四模块 REST 端点

> 约定：带 🔒 的接口需要 `X-Demo-Token`；带 👤 的接口"若带 `X-Session-Token` 则按会话身份归属，不带则按 body 里的 handle"。

### 6.1 M1 代取（`/api/tasks` `/api/runners` `/api/matches`）

| 方法 | 路径 | 鉴权 | 参数 | 返回 |
|---|---|---|---|---|
| `GET` | `/api/tasks?building=&limit=` | 开放 | `building` 同时匹配取件/送达楼栋；只返回 `raw_status='open'` 且未过期 | `Task[]` |
| `POST` | `/api/tasks` | 🔒 👤 | `from_building` `to_building` `station` `deadline_iso` `reward_min` `reward_max` `note?` `screenshot_path?` `owner_handle?` | `{task_id, status}` |
| `GET` | `/api/tasks/:id` | 开放 | — | `Task` |
| `POST` | `/api/tasks/:id/match` | 🔒 | `top_k?`（默认 3） | `Match[]`（含 `pushed` / `skip_reason`，便于核验 5 分钟去重） |
| `POST` | `/api/tasks/:id/interest` | 🔒 👤 | `runner_handle?` | 意愿记录（不改变任务归属） |
| `GET` | `/api/runners` | 开放 | — | `Runner[]`（**已脱敏**：只出昵称，不出 user_id / 联系方式） |
| `GET` | `/api/matches?limit=&state=&runner=` | 开放 | — | `Match[]`（首页"平均匹配得分"用） |
| `POST` | `/api/matches/:id/accept` | 🔒 👤 | — | `{match_id, task_id, state:"accepted"}`；**只有任务发布者能选人** |
| `POST` | `/api/matches/:id/decline` | 🔒 | — | `{…, state:"declined"}`（pushed → declined） |
| `POST` | `/api/matches/:id/cancel` | 🔒 | — | `{…, state:"pushed"}`（accepted → pushed，取消接单） |

```jsonc
// GET /api/tasks 的 data[0]（实测）
{ "task_id":"demo-task-6", "owner_handle":"同学A", "from_building":"15号宿舍楼", "to_building":"12号宿舍楼",
  "station":"南门", "deadline_ts":1793441423, "deadline_iso":"2026-10-31T10:10:23.000Z",
  "reward_min":3, "reward_max":4, "note":"急件，尽快取", "screenshot_path":null, "photo":null,
  "raw_status":"open", "created_at_ts":1793438723, "created_at_iso":"2026-10-31T09:25:23.000Z", "demo":true }

// GET /api/matches 的 data[0]（实测）
{ "match_id":"match_…", "task_id":"task_…", "runner_handle":"同学D", "score":100,
  "state":"accepted", "source":"engine", "created_at":1793438757, "created_at_iso":"…" }
```

**为什么多了 `/api/runners` 与 `/api/matches`**：契约里没有这两条，是首页统计需要的只读口
（按 `/api/map/summary` 的先例补的），不加令牌。

### 6.2 M2 搭子（`/api/buddies`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/buddies?kind=&limit=` | 开放 | 匿名帖列表（**只暴露 `anon_token` 与画像，没有 `user_id`**） |
| `GET` | `/api/buddies/search?kind=&handle=&text=&top_k=` | 开放 | 候选；与 MCP `buddy_search` **同一套评分**（只读、不落库） |
| `GET` | `/api/buddies/mine?handle=&shape=` | 开放 | 我发出的意愿；`shape=console` 给站内用三块结构 `{posts,intents,mutual}` |
| `POST` | `/api/buddies` | 🔒 👤 | 发帖（服务端抽画像）；返回 `{post_id, anon_token, profile}` |
| `POST` | `/api/buddies/:id/consent` | 🔒 👤 | 双选表决：**昵称=帖主 → 记发布方同意；其它 → 记寻找方同意**；可带 `message` 顺带留言 |
| `POST` | `/api/buddies/:id/reply` | 🔒 👤 | 留言/回复（`message`、`to_handle?`、`to_consent_id?`） |
| `GET` | `/api/buddies/:id/messages` | 开放 | 该帖的留言与回复列表 |

```jsonc
// GET /api/buddies/search 的 data[0]（实测）
{ "post_id":"post-…", "anon_token":"anon_…", "kind":"study", "score":95,
  "reason":"共同兴趣 1 项(自习) +35；作息接近 +30；性格接近 +20；期望契合 +10（总分 95）",
  "reveal_status":"pending", "parts":{ "interest":35, "schedule":30, "traits":20, "semantic":10 } }

// 双选实测
// ① 寻找方同意 → {author_ok:0, seeker_ok:1, revealed:0}      ← 不含任何联系方式字段
// ② 帖主同意   → {author_ok:1, seeker_ok:1, revealed:1, chat_ready:true,
//                 thread_id:"th_…"}                          ← 双方同意 → 直接开聊
// ③ 任一方重复表决 → 400 SCHEMA_REJECTED（UNIQUE(post_id,seeker_id) / 已表决过）
```

> **关于 `contact_code`（"中转码"）**：2026-10-31 起**整体废弃**——
> 出口按状态机推导（`src/engine/doubleOpt.js::toResponse`），`revealed=0` 时返回对象里**没有** `contact_code` 键；
> `revealed=1` 时**也不再给中转码**，改为 `chat_ready:true` +（API 层附加的）`thread_id`，让双方**站内直接聊**。
> 候选列表同一口径：`reveal_status="mutual"` 时才带 `chat_ready` / `thread_id`。
> 单方同意时 `GET /api/threads` **不会**出现该帖的会话（实测：0 条）；双方同意后才出现。

### 6.3 M3 地图（`/api/map`）

| 方法 | 路径 | 鉴权 | 返回 |
|---|---|---|---|
| `GET` | `/api/map/nodes?category=` | 开放 | `MapNode[]`（12 个节点；`category` ∈ `dorm/canteen/teaching/gate/service`） |
| `GET` | `/api/map/summary` | 开放 | `{total, with_pano, by_category[], categories[]}` |

```jsonc
// 实测：{"total":12,"with_pano":0,"by_category":[{"category":"canteen","n":2,"with_pano":0},…]}
// 单节点：{"id":"dorm-12","label":"12号宿舍楼","category":"dorm","lat":0,"lng":0,
//          "pano_url":null,"desc":"位于校园东侧，紧邻第二食堂，楼下有快递驿站。"}
```

### 6.4 M4 日程与脱敏审计

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/schedule?handle=&weekday=` | 开放 | 周视图数据；按 `weekday, period_start` 升序 |
| `GET` | `/api/schedule/:id` | 开放 | 单条详情（评委点单条看详情） |
| `POST` | `/api/schedule` | 🔒 | 手动加一条（**只接受 6 个白名单字段**；多传的字段会被 service 层丢弃并写审计） |
| `GET` | `/api/scrub/audit?limit=` | 开放 | **脱敏审计**：`dropped_fields` 只含字段名，绝不含值 |

```jsonc
// GET /api/schedule 的 data[0]（实测）
{ "weekday":1, "period_start":1, "period_end":2, "title":"高等数学",
  "room":"教学楼A-101", "weeks":"1-16", "remind_before":15 }

// GET /api/scrub/audit 的 data[0]（实测：POST /api/schedule 带 studentNo/phone 之后）
{ "id":1, "item_type":"schedule", "dropped_fields":["studentNo","phone"], "created_at":"2026-10-31T09:34:05.000Z" }
```

> ⛔ 本模块**没有**课表文件上传接口（`POST /api/schedule/upload` 之类刻意不做）；
> MCP `schedule_import` 的 items 只允许 `weekday / period_start / period_end / title / room / weeks`。

### 6.5 核心与其它

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | 开放 | `{version, time, uptime_s, mcp:"/mcp"}`；探活用 |
| `GET` | `/api/demo/seed?reset=&warm=` | `reset=1` 需 🔒 | **幂等**灌演示数据；`warm=1`（默认）顺手热身撮合；返回各表 counts |
| `GET` | `/config.js` | 开放 | 注入 `window.__TILE_KEY__ / __SITE_DOMAIN__ / __DEMO_TOKEN__ / __AMAP_KEY__ / __APP_VERSION__` |
| `GET` | `/favicon.ico` | 开放 | `301 → /favicon.svg`（避免每页 console 404 噪音） |
| `GET` | 其它未知路径 | 开放 | 浏览器（`Accept: text/html`）→ `static/404.html`（404）；接口路径 → 统一信封 404 |

---

## 7. MCP（远程 Streamable HTTP）

### 7.1 接入配置

```json
{
  "mcpServers": {
    "beimingda": {
      "url": "https://demo.knowingly.dpdns.org/mcp",
      "headers": { "Authorization": "Bearer <DEMO_TOKEN>" }
    }
  }
}
```

### 7.2 协议方法

| 方法 | 说明 |
|---|---|
| `initialize` | 返回协议版本（`2025-06-18` / `2025-03-26` / `2024-11-05`，请求给哪个支持的就回哪个）、`capabilities.tools`、`serverInfo` |
| `notifications/initialized` 等通知 | 无响应（HTTP 202） |
| `ping` | 连通性 |
| `tools/list` | 只回 `name` / `description` / `inputSchema` |
| `tools/call` | 结果 = `{content:[{type:"text",text:"<信封 JSON>"}], structuredContent:<信封>, isError:<bool>}` |

- `GET /mcp`：返回能力描述（`transport: "streamable-http"`、`sse: false`、`tools: 15`），方便自检。
- `GET /mcp/sse`：**显式 405**，避免客户端误以为要挂长连接。
- ⛔ 不支持 SSE / WebSocket；单次响应必须 < 90 秒。

### 7.3 15 个工具（`tools/list` 实测返回）

| 模块 | # | 工具 | 一句话作用 |
|---|---|---|---|
| M1 代取撮合（5） | 1 | `task_parse_screenshot` | 从取件截图抽楼栋/驿站/时间（⛔ 不抽姓名、手机号、运单号，图不落盘） |
| | 2 | `task_publish` | 发布代取任务（报酬区间与截止时间必须合法） |
| | 3 | `runner_register` | 跑腿方登记可达楼栋 / 报酬下限 / 可用时段 |
| | 4 | `match_find_for_task` | 为任务找候选跑腿者，返回 `score` + `reason` |
| | 5 | `task_list_open` | 列出开放且未过期的代取任务 |
| M2 搭子匹配（3） | 6 | `buddy_publish` | 发布搭子帖（服务端抽匿名画像，`anon_token` 随机） |
| | 7 | `buddy_search` | 搜索候选（只回 ≥60，不含任何联系方式） |
| | 8 | `buddy_consent` | 双选表决（双方都点头才揭示/开聊） |
| M3 迎新导览（2） | 9 | `map_list_nodes` | 按类别列校园地图节点 |
| | 10 | `map_get_node` | 取单个节点详情（⛔ 不编造距离与步行时间） |
| M4 日程提醒（4） | 11 | `schedule_import` | 批量导入课表（只收 6 个白名单匿名字段） |
| | 12 | `schedule_add` | 加一条日程（`period_end ≥ period_start`） |
| | 13 | `schedule_query` | 按星期与节次升序查日程 |
| | 14 | `schedule_remove` | 删除一条日程 |
| 跨模块（1） | 15 | `app_open_view` | 生成站点深链（可带某处 360° 实景场景 id），把界面替用户打开；只读、不改状态 |

**通用约束**：所有工具的 `inputSchema.additionalProperties = false` → 多传字段直接 `SCHEMA_REJECTED`；
参数错误/业务校验失败一律返回统一信封（`ok:false` + `error.code`），而**不是**抛 JSON-RPC 层错误
（只有"unknown tool"、限频、`params.name` 缺失才在 JSON-RPC 层报错）。

### 7.4 调用示例（实测）

```bash
curl -fsS --max-time 10 -X POST https://demo.knowingly.dpdns.org/mcp \
  -H 'Authorization: Bearer <DEMO_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 实测：tools 数组长度 = 15（名称见上表）

# 不带令牌 → 401，信封：{"ok":false,"data":null,"error":{"code":"SCHEMA_REJECTED","message":"invalid or missing DEMO_TOKEN"}}
```

---

## 8. ⭐ 接真实数据只改 3 处

现在这套东西是"演示可用、匿名身份、SQLite 单文件"。要变成**真校园服务**，改动集中在这三处：

### ① 数据源适配：`src/services/*`（唯一碰数据的地方）

- 所有 SQL 都在 service 层（`task.js` / `runner.js` / `buddy.js` / `schedule.js` / `map.js` / `chat.js` / `session.js`），
  **HTTP 与 MCP 共用同一套 service**（契约硬要求：不许各写一份）。
- 落地换库（PostgreSQL / MySQL / 学校提供的库）时：改这几个文件的实现 + `src/db/index.js`，
  **`src/api/**` 与 `src/mcp/**` 基本不用动**（它们只做参数搬运与信封打包）。
- 迁移注意：`src/db/schema.sql`（13 张表）里的 `users.handle` 唯一性是会话身份的基础；
  `buddy_consents.UNIQUE(post_id,seeker_id)` 与 `threads.UNIQUE(kind,ref_id,a_uid,b_uid)` 是状态机的硬保证，**换库必须保留**。

### ② 定时任务 / 主动推送（**现在没有**，落地要加）

- 现状：没有任何后台任务/推送；提醒只做到"数据侧具备（`schedule_items.remind_before` + `config/periods.json`）"，
  页面靠轮询（搭子墙 2~5 秒）拿新数据。
- 落地要做：
  1. 一个 5 分钟一次的定时任务（systemd timer 或 cron），扫当天课程算触发时刻，
     写入队列表/直接调用推送通道（**⛔ 不要用 SSE 长连接，CF 有 100 秒硬超时**）；
  2. 代取"被接单/被拒"、搭子"双方同意"这类事件的通知同上；
  3. 若要多实例，限频与任务锁要从"进程内 Map"换成共享存储（现在是内存固定窗口）。

### ③ 鉴权口径：现在匿名会话 + 演示令牌 → 落地接**学校统一身份认证**

- 现状：`POST /api/session` 自助发匿名令牌（`X-Session-Token`，库里只存 sha256）；
  写接口另外要 `X-Demo-Token`（演示闸门，给评委用）。
- 落地要改：
  1. `src/middleware/session.js` 的 `sessionFromToken()` → 换成校验学校统一身份认证（CAS / OIDC）返回的票据，
     并把 `users` 绑定到学校身份（**真要存学号就在这里存——但那是"落地决策"，不是本演示版本做的事**）；
  2. 去掉/收窄 `X-Demo-Token` 这把"写演示数据"的闸门（它只是演示期让评委零配置能玩的开关）；
  3. 同步收紧限频：现在按 IP（240/60/30 每分钟），多实例 + 真用户量要按账号维度限频。
- ⛔ 演示版本刻意**不收集**姓名/学号/手机号/证件号/校内系统口令，数据库里也没有对应字段；
  这条红线在落地方案里也要写清楚"收集什么、为什么、谁能看"。

---

## 9. 兼容性与变更记录（近期）

| 日期 | 变更 | 影响 |
|---|---|---|
| 2026-10-31 | 新增匿名会话（`POST /api/session`、`/api/me`、`sessions` 表） | 写接口的归属从"body 里的 handle"改为"有会话就用会话身份"；**老调用（只带 `X-Demo-Token`）仍兼容** |
| 2026-10-31 | 新增站内私聊（`/api/threads*`、`threads` / `thread_messages` 表） | 双方同意后**不再返回"中转码"**（`contact_code` 整体废弃），改为 `chat_ready + thread_id`；`/api/session` 与 `/api/me` 也不再输出 `contact_code` |
| 2026-10-31 | 新增搭子留言（`buddy_messages`、`/api/buddies/:id/messages`、`/:id/reply`） | 只读口开放 |
| 2026-10-31 | 新增 MCP 工具 `app_open_view`（第 15 个） | 只读；`/agent` 页工具一览同步为 15 |
| 2026-10-31 | REST 读接口默认限频 60 → **240**/分钟（`API_READ_LIMIT`） | 页面轮询与演示翻页不再被自己的限频挡住 |

---

## 10. 本文件的验证方式

本文件里的**状态码、字段名、错误 message、工具数量**都来自对着运行实例的真实请求
（本机 `PORT=3091`，`DB_PATH` 指向临时库，`GET /api/demo/seed` 灌数据后逐条探测），
覆盖：会话三连、私聊全链路（含越权与边界）、四模块只读口、写接口鉴权、MCP `tools/list`、
限频头、favicon 跳转与 404 分流。

⚠️ **`contact_code` 相关结论是二次核对过的**：工作树在我探测期间被并行修改，
第一次探测拿到的双选响应还带 `contact_code: null`（中间版本）；
随后我重启服务、用当前代码重跑，确认现状是
`{"author_ok":1,"seeker_ok":1,"revealed":1,"chat_ready":true,"thread_id":"th_…"}`
（**没有 `contact_code`**），`POST /api/session` 也返回 `has_password` 而不是 `contact_code`——本文按**当前代码**写。

**未实测**（如需请自测）：真机多实例的共享限频、接入学校统一身份认证后的行为、
以及 `POST /api/tasks/:id/interest` 在并发下的表现。
