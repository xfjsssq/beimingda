# 契约 · M1 代取撮合模块

**依赖：** `contracts/core.md`（表结构、信封、鉴权）
**对应表：** `tasks` `runners` `matches`

---

## 1. 数据模型

### tasks（代取任务）
| 字段 | 类型 | 说明 |
|---|---|---|
| from_building | TEXT | 取件楼栋（平台规范名） |
| to_building | TEXT | 送达楼栋（平台规范名） |
| station | TEXT | 快递站名 |
| deadline_ts | INTEGER | 截止时间（Unix 秒） |
| reward_min / reward_max | REAL | 报酬区间（元），`reward_min <= reward_max` |
| note | TEXT | 备注（已脱敏） |
| screenshot_path | TEXT | 打码后的截图相对路径，可为 null |
| raw_status | TEXT | `open` / `matched` / `done` / `cancelled` |

### runners（跑腿方能力）
| 字段 | 类型 | 说明 |
|---|---|---|
| reachable_buildings | TEXT | JSON 数组，如 `["12号楼","15号楼"]` |
| reward_floor | REAL | 可接受报酬下限 |
| time_windows | TEXT | JSON，`[{"start":ts,"end":ts}]`（Unix 秒） |
| active | INTEGER | 1/0 |

### matches（撮合记录）
| 字段 | 类型 | 说明 |
|---|---|---|
| score | REAL | 0~100 |
| state | TEXT | `pushed` / `accepted` / `declined` / `expired` |

---

## 2. ⭐ 撮合评分算法（冻版，不得改权重）

```
matchScore(task, runner) -> 0..100

【可达性 40】
  runner.reachable_buildings 命中 task.to_building          -> 40
  仅命中 task.from_building                                  -> 20
  两者都不命中                                               -> 出局（不计入结果）

【时间 30】
  runner 的某个 time_window 完全覆盖 [now, task.deadline_ts] -> 30
  部分重叠 >= 50%                                            -> 20
  部分重叠 < 50%                                             -> 10
  完全不重叠                                                 -> 出局

【报酬 30】
  ratio = clamp((task.reward_max - runner.reward_floor)
                / (task.reward_max - task.reward_min + 1e-6), 0, 1)
  ratio * 30

总分 = 可达性 + 时间 + 报酬        // 0..100
推送阈值 = 60，仅返回 >= 60 的候选
```

**必须返回可解释理由**：每个候选带 `reason` 字段，说明是靠可达性、时间还是报酬拿到的分。
例：`"可达 15号楼(+40)，时段 18:00-21:00 完全覆盖(+30)，报酬 5元>下限2元(+30)"`

### 推送规则（冻版）
- 单任务**最多同时推 3 名** runner，按 score 降序
- 同一 runner **5 分钟内不重复推送同一任务**
- 推送写入 `matches`（state=`pushed`），由平台侧定时任务触达（**非长连接**）

---

## 3. MCP 工具（本模块 5 个）

所有 schema 设 `additionalProperties: false`。

### 3.1 `task_parse_screenshot`
```json
{
  "name": "task_parse_screenshot",
  "description": "从快递取件截图中抽取结构化代取任务字段",
  "inputSchema": {
    "type": "object",
    "properties": {
      "image_base64": { "type": "string", "description": "base64 编码的图片" },
      "hint":         { "type": "string", "description": "用户的补充说明" }
    },
    "required": ["image_base64"],
    "additionalProperties": false
  }
}
```
返回：`{from_building, to_building, station, deadline_iso, reward_min, reward_max, note, confidence}`
识别失败的字段返回 `null`。

**必须遵守的抽取规则：**
- 图片**直接进模型上下文**理解，不做独立 OCR 再转换
- ⛔ **收件人姓名、手机号、运单号一律不抽取、不复述、不写入**
- `confidence < 0.4` 或关键字段全空 → 返回 `null` 字段而非猜测值
- 图片**不落服务器磁盘**

### 3.2 `task_publish`
```json
{
  "name": "task_publish",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from_building": { "type": "string" },
      "to_building":   { "type": "string" },
      "station":       { "type": "string" },
      "deadline_iso":  { "type": "string" },
      "reward_min":    { "type": "number" },
      "reward_max":    { "type": "number" },
      "note":          { "type": "string" },
      "screenshot_path": { "type": "string" },
      "owner_handle":  { "type": "string" }
    },
    "required": ["from_building","to_building","station","deadline_iso","reward_min","reward_max","owner_handle"],
    "additionalProperties": false
  }
}
```
返回 `{task_id, status}`。**校验 `reward_min <= reward_max`，否则返回 `SCHEMA_REJECTED`。**
**校验 `deadline` 必须晚于当前时间**，过期则拒绝。

### 3.3 `runner_register`
```json
{
  "name": "runner_register",
  "inputSchema": {
    "type": "object",
    "properties": {
      "user_handle":         { "type": "string" },
      "reachable_buildings": { "type": "array", "items": { "type": "string" } },
      "reward_floor":        { "type": "number" },
      "time_windows": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "start_iso": {"type":"string"}, "end_iso": {"type":"string"} },
          "required": ["start_iso","end_iso"],
          "additionalProperties": false
        }
      }
    },
    "required": ["user_handle","reachable_buildings","reward_floor","time_windows"],
    "additionalProperties": false
  }
}
```
返回 `{runner_id}`。同一 `user_handle` 重复登记 → **覆盖更新**（走 `runners.user_id` 唯一约束）。

### 3.4 `match_find_for_task`
```json
{
  "name": "match_find_for_task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task_id": { "type": "string" },
      "top_k":   { "type": "integer", "minimum": 1, "maximum": 10, "default": 3 }
    },
    "required": ["task_id"],
    "additionalProperties": false
  }
}
```
返回 `{matches:[{runner_handle, score, reason}]}`，按 score 降序，**只含 >= 60 的**。

### 3.5 `task_list_open`
```json
{
  "name": "task_list_open",
  "inputSchema": {
    "type": "object",
    "properties": {
      "building": { "type": "string" },
      "limit":    { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 }
    },
    "additionalProperties": false
  }
}
```
返回 `{tasks:[...]}`，只含 `raw_status='open'` 且 `deadline_ts > now` 的。
`building` 参数同时匹配 `from_building` 与 `to_building`。

---

## 4. HTTP API（本模块）

```
GET  /api/tasks?building=&limit=   → Task[]        （只返回 open 且未过期）
POST /api/tasks                    → {task_id}
GET  /api/tasks/:id                → Task
POST /api/tasks/:id/match          → Match[]       （触发撮合，写 matches）
```

---

## 5. 页面要素（`static/takeout.html`）

**区块一 · 发布任务**：楼栋选择（下拉，取自 `config/map-nodes.json` 的 dorm 类）、
快递站、截止时间、报酬区间（双输入）、备注、截图上传。

**区块二 · 跑腿登记**：可达楼栋多选、报酬下限、时段（多个 start/end）。

**区块三 · 任务看板**：开放的代取任务列表，每条显示楼栋路径、时限倒计时、报酬区间。

**区块四 · 匹配结果**：点某任务展示候选跑腿者 —— **必须显示 score 与 reason**
（这是展示"引擎真的在算"的关键，不能只显示一个列表）。

---

## 6. 本模块禁止事项

- ⛔ 截图原图落服务器磁盘
- ⛔ 从截图里抽取姓名 / 手机号 / 运单号
- ⛔ 修改评分权重或阈值
- ⛔ 平台参与交易、代收款、承诺履约（弹窗话术：报酬双方线下协商）
- ⛔ 用 HTTP API 与 MCP **各写一套业务逻辑**（必须共用 `services/task.js`）

---

## 7. 完成标准（自测清单）

- [ ] `task_publish` 对 `reward_min > reward_max` 返回 `SCHEMA_REJECTED`
- [ ] `task_publish` 对已过期 deadline 返回 `SCHEMA_REJECTED`
- [ ] `match_find_for_task` 对不可达的 runner **不出现在结果里**
- [ ] 同一 runner 连续调用两次，第二次 5 分钟内不重复推送
- [ ] 候选理由里的分值相加等于 score
- [ ] `task_list_open` 不返回已过期任务
- [ ] 截图路径为 null 时 `task_publish` 仍然成功
- [ ] `additionalProperties:false` 生效：多传一个字段返回 `SCHEMA_REJECTED`
