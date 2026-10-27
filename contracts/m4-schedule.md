# 契约 · M4 日程与主动提醒模块（含脱敏审计）

**依赖：** `contracts/core.md`
**对应表：** `schedule_items` `scrub_audit`
**合规等级：** ⭐⭐⭐ **本模块是全站合规最敏感的地方，代码里必须体现白名单**

---

## 1. ⭐ 字段白名单（本模块的立命之本）

### 允许进入平台的字段 —— 只有这 6 个

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `weekday` | integer | ✅ | 1~7 |
| `period_start` | integer | ✅ | 起始节次 |
| `period_end` | integer | ✅ | 结束节次，`>= period_start` |
| `title` | string | ✅ | 课程名 |
| `room` | string | ❌ | 教室 |
| `weeks` | string | ❌ | 形如 `"1-16"` 或 `"1-8,10-16"` |

### ⛔ 禁字段黑名单（服务端必须主动拦，不能只靠 schema）

```
name  realName  studentNo  studentId  stuNo  teacher  teacherName
className  major  college  grade  score  gpa  rank  phone  mobile  idCard
```

**双层防御（缺一不可）：**
1. **MCP schema 层**：`additionalProperties: false`，items 里只列那 6 个字段
2. **service 层二次校验**：即使绕过了 schema，`services/scrub.js` 也要逐字段扫描，
   命中黑名单 → **丢弃该字段** + 写 `scrub_audit`（**只记字段名，绝不记值**）

---

## 2. 脱敏审计（必须在 UI 与材料里可见）

每次导入后：
```sql
INSERT INTO scrub_audit(item_type, dropped_fields, created_at)
VALUES ('schedule', '["name","studentNo","teacher"]', <now>);
```
- `dropped_fields` 是 **JSON 数组，只含字段名**
- ⛔ **绝不写入任何字段值**（哪怕一个字符）
- 该表对外只读，提供 `GET /api/scrub/audit?limit=` 供评委核验

**Agent 每次导入后必须向用户汇报**：写入了多少条、丢弃了哪些类别的字段。
这个汇报不是客套，是本模块的合规证明环节 —— **prompt 里要写死，代码里要返回 `dropped_fields`**。

---

## 3. 数据模型：schedule_items

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | TEXT | 关联 users |
| weekday | INTEGER | 1~7 |
| period_start / period_end | INTEGER | 节次区间 |
| title | TEXT | 课程名 |
| room | TEXT | 可空 |
| weeks | TEXT | 可空 |
| remind_before | INTEGER | 提前多少分钟提醒，`null` = 不提醒 |

---

## 4. MCP 工具（本模块 4 个）

### 4.1 `schedule_import` ⭐ 最关键
```json
{
  "name": "schedule_import",
  "inputSchema": {
    "type": "object",
    "properties": {
      "user_handle": { "type": "string" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "weekday":      { "type": "integer", "minimum": 1, "maximum": 7 },
            "period_start": { "type": "integer", "minimum": 1, "maximum": 14 },
            "period_end":   { "type": "integer", "minimum": 1, "maximum": 14 },
            "title":        { "type": "string", "maxLength": 100 },
            "room":         { "type": "string", "maxLength": 50 },
            "weeks":        { "type": "string", "maxLength": 50 }
          },
          "required": ["weekday","period_start","period_end","title"],
          "additionalProperties": false
        }
      }
    },
    "required": ["user_handle","items"],
    "additionalProperties": false
  }
}
```
返回 `{imported: n, dropped_fields: string[]}`

**行为要求**
- 导入前**先清空该用户的旧课表**（同一用户重复导入不叠加）
- `period_end < period_start` → 返回 `SCHEMA_REJECTED`
- `title` 为空字符串 → 跳过该条并计入 `dropped_fields` 的 `title`
- **服务端二次扫描禁字段**（见 §1 黑名单），命中即丢弃并记审计
- 即使 schema 挡住了，**service 层也必须独立再扫一遍**

### 4.2 `schedule_add`
```json
{
  "name": "schedule_add",
  "inputSchema": {
    "type": "object",
    "properties": {
      "user_handle":   { "type": "string" },
      "weekday":       { "type": "integer", "minimum": 1, "maximum": 7 },
      "period_start":  { "type": "integer", "minimum": 1, "maximum": 14 },
      "period_end":    { "type": "integer", "minimum": 1, "maximum": 14 },
      "title":         { "type": "string" },
      "room":          { "type": "string" },
      "weeks":         { "type": "string" },
      "remind_before": { "type": "integer", "minimum": 0, "maximum": 1440 }
    },
    "required": ["user_handle","weekday","period_start","period_end","title"],
    "additionalProperties": false
  }
}
```
返回 `{item_id}`

### 4.3 `schedule_query`
```json
{
  "name": "schedule_query",
  "inputSchema": {
    "type": "object",
    "properties": {
      "user_handle": { "type": "string" },
      "weekday":     { "type": "integer", "minimum": 1, "maximum": 7 }
    },
    "required": ["user_handle"],
    "additionalProperties": false
  }
}
```
返回 `{items:[{weekday,period_start,period_end,title,room,weeks,remind_before}]}`
（按 weekday、period_start 升序）

### 4.4 `schedule_remove`
```json
{
  "name": "schedule_remove",
  "inputSchema": {
    "type": "object",
    "properties": { "item_id": { "type": "string" } },
    "required": ["item_id"],
    "additionalProperties": false
  }
}
```
返回 `{ok: true}`；不存在 → `NOT_FOUND`

---

## 5. 提醒机制

**前提：本模块不接学校任何系统，提醒由平台侧定时任务触发。**

```
scripts/reminder.js  —— 由系统 cron 每 5 分钟跑一次
  1. 查出所有 remind_before 非空、且 today 有课的记录
  2. 计算"该课当天 period_start 对应的时刻 - remind_before"
  3. 落在 [now, now+5min) 区间内的 → 触发提醒
  4. 触达方式：写入 reminders 队列表 / 调 WorkBuddy 定时任务
     ⛔ 不使用 SSE 长连接保活（CF 100 秒限制）
```

**前提说明**：必须先有节次→时刻的映射表，放 `config/periods.json`，形如：
```json
{ "1": "08:00", "2": "08:50", "3": "10:00", "4": "10:50" }
```
没有这张表就算不出提醒时刻。

---

## 6. HTTP API（本模块）

```
GET  /api/schedule?handle=   → ScheduleItem[]
POST /api/schedule           → {item_id}
GET  /api/scrub/audit?limit= → ScrubAudit[]   （评委核验用）
```

⚠️ **本模块不提供 `POST /api/schedule/upload` 这类文件上传接口。刻意不做。**

---

## 7. 页面要素（`static/schedule.html`）

**区块一 · 周视图**：7 列 × 节次的网格，课程块填充。

**区块二 · 导入指引**（⭐ 合规说明区，必须显眼）：
> 课表文件**不要上传到这里**。请在学校官方渠道导出课表后，
> 在你的本机 WorkBuddy 对话中交给 Agent 处理 —— Agent 只会把
> 「周几 / 起止节次 / 课程名 / 教室 / 周次」写入平台，**姓名与学号不会离开你的设备**。

**区块三 · 手动添加**：给不想用对话的用户兜底（表单只含那 6 个字段）。

**区块四 · 提醒设置**：对每门课设置提前多少分钟提醒。

**区块五 · 脱敏审计**（可选但强烈建议）：展示"最近一次导入丢弃了哪些字段"，
让评委直观看到合规设计真实生效。

---

## 8. 本模块禁止事项

- ⛔ **任何形式的课表文件上传接口或按钮**
- ⛔ 代用户登录学校系统拉取课表
- ⛔ `schedule_items` 里出现任何白名单外的字段
- ⛔ `scrub_audit` 里记录任何字段**值**
- ⛔ 用 SSE 长连接做提醒
- ⛔ 只靠 schema 防御、service 层不二次扫描

---

## 9. 完成标准（自测清单）

- [ ] `additionalProperties:false` 生效：items 里多传 `studentNo` → `SCHEMA_REJECTED`
- [ ] **即使**绕过 schema 直接调 service，`service/scrub.js` 仍能拦下禁字段
- [ ] 拦截后 `scrub_audit` 新增一条，**`dropped_fields` 里只有字段名，无任何值**
- [ ] `period_end < period_start` 返回 `SCHEMA_REJECTED`
- [ ] 同一用户重复导入不叠加（先清旧数据）
- [ ] `/api/scrub/audit` 能查到审计记录
- [ ] 全仓搜索 `upload` 找不到课表上传接口
- [ ] 全仓搜索 `studentNo`/`realName` 只出现在黑名单常量与测试里
- [ ] 提醒脚本能在测试数据上正确算出触发时刻
