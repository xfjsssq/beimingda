# MCP 工具清单 · MCP-TOOLS

**传输：远程 Streamable HTTP，端点 `POST /mcp`**（⛔ 禁止本地 stdio，⛔ 禁止 SSE 长连接）
**鉴权：`Authorization: Bearer <DEMO_TOKEN>`**（兼容不带 `Bearer ` 前缀的裸 token）；`DEMO_TOKEN` 只从环境变量读
**限频：工具调用 30 次/分钟**；单次响应必须 < 90 秒（CF 隧道 100 秒硬限制）

## 客户端配置（贴给 WorkBuddy）

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

> ⚠️ 展示与材料里令牌**一律写占位符 `<DEMO_TOKEN>`**，不许填真实值。

## 协议方法

| 方法 | 说明 |
|---|---|
| `initialize` | 返回协议版本（`2025-06-18` / `2025-03-26` / `2024-11-05`）、`capabilities.tools`、`serverInfo` |
| `notifications/initialized` | 通知，无需响应 |
| `ping` | 连通性 |
| `tools/list` | 返回全部工具 schema（只回 `name` / `description` / `inputSchema`） |
| `tools/call` | 调用工具；结果装在 `result.content[0].text`（统一信封的 JSON）与 `result.structuredContent` |

---

## 15 个工具（分模块）

**所有工具 `inputSchema.additionalProperties` 必须为 `false`** —— 多传一个字段即 `SCHEMA_REJECTED`。

> **当前接入状态（2026-10-27，四模块全部合入 main 后实测）**：`tools/list` 返回 **14 个**
> （M1 5 + M2 3 + M3 2 + M4 4）。
> 这条状态的机检入口：`npm run verify`（会自动发现已注册工具并逐个真调）。

### M1 · 代取撮合（5 个）｜分支 `feat/m1-takeout`

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `task_parse_screenshot` | 从快递取件截图抽取结构化任务字段 | 图片直接进模型上下文；⛔ 不抽姓名/手机号/运单号；⛔ 不落盘；`confidence < 0.4` 返回 null 字段 |
| `task_publish` | 发布代取任务 | 校验 `reward_min <= reward_max`、deadline 必须晚于当前时间，否则 `SCHEMA_REJECTED` |
| `runner_register` | 跑腿方能力登记 | 同一 `user_handle` 重复登记 → 覆盖更新（`runners.user_id` UNIQUE） |
| `match_find_for_task` | 对任务找候选跑腿者 | 只返回 score ≥ 60，按 score 降序，带 `reason` |
| `task_list_open` | 列开放任务 | 只含 `raw_status='open'` 且 `deadline_ts > now` |

### M2 · 搭子匹配（3 个）｜分支 `feat/m2-buddy`

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `buddy_publish` | 发布搭子帖（服务端抽画像） | `anon_token` 随机生成，⛔ 不得由 user_id 派生 |
| `buddy_search` | 搜索候选 | 只返回 `open` 且 score ≥ 60；⛔ 结果不含院系全名/班级/学号/宿舍号/真实姓名/联系方式 |
| `buddy_consent` | 双选表决 | `revealed=0` 时返回里**完全不出现** `contact_code` 键（不是 null） |

### M3 · 迎新导览（2 个）｜分支 `feat/m3-welcome`

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `map_list_nodes` | 列地图节点（可按 category 过滤） | 节点数据只读 |
| `map_get_node` | 取单个节点详情 | 不存在 → `NOT_FOUND`；⛔ 不许编造距离/步行时间 |

### M4 · 日程与提醒（4 个）｜分支 `feat/m4-schedule`

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `schedule_import` ⭐ | 批量导入课表 | 只收 6 个白名单字段；导入前清空该用户旧课表；返回 `{imported, dropped_fields}`；service 层二次扫描禁字段 |
| `schedule_add` | 加一条日程 | `period_end >= period_start`，否则 `SCHEMA_REJECTED` |
| `schedule_query` | 查日程 | 按 weekday、period_start 升序 |
| `schedule_remove` | 删一条 | 不存在 → `NOT_FOUND` |
| `app_open_view` ⭐ | 生成"帮忙打开某界面"的深链（可带某处 360° 实景） | 只读、不改状态；`view` ∈ welcome/takeout/buddy/schedule/agent；`pano` 只在 view=welcome 有效，场景不存在时返回可用的 `available_scenes` |

---

## 返回格式

工具结果统一为信封（`contracts/core.md` §信封）：

```json
{ "ok": true,  "data": { }, "error": null }
{ "ok": false, "data": null, "error": { "code": "SCHEMA_REJECTED", "message": "..." } }
```

错误码：`SCHEMA_REJECTED` / `NOT_FOUND` / `TIMEOUT` / `QUOTA` / `INTERNAL`

传输层形态示例（`tools/call` 的 `result`）：

```json
{
  "content": [{ "type": "text", "text": "{\"ok\":true,\"data\":{...},\"error\":null}" }],
  "structuredContent": { "ok": true, "data": {}, "error": null },
  "isError": false
}
```

---

## 示例对话（`/agent` 页与路演照抄）

```
帮我发个代取，12 号楼取快递送到 15 号楼，今晚 8 点前，报酬 3 到 5 块
我今晚 6 点到 9 点有空，12 到 16 号楼都能去，报酬 2 块以上就行
我想找个一起自习的搭子，大二，工科，晚上比较有空，喜欢算法和摄影
帮我看看 15 号楼在哪，有实景吗
周三下午要交实验报告，提前两小时提醒我
```

---

## 自检

```bash
npm test && npm run smoke        # 骨架级：信封 / 鉴权 / 表清单 / 无硬编码密钥
npm run verify                   # 模块级集成：自动发现工具真调 + 6 页面 + 路由 + CDN 红线
```

> ⚠️ 本机默认 3000 端口被无关常驻进程占用，本地自测请显式指定端口：`PORT=3080 npm start`。
> 下列示例按 3080 写；部署到演示域名时用 443（Cloudflare 隧道终止 TLS）。

```bash
# 能力描述（需 token）
curl -s -X POST http://127.0.0.1:3080/mcp \
  -H "Authorization: Bearer $DEMO_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 无 token 应 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
