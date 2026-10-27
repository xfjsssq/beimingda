# 契约 · M2 搭子匹配模块

**依赖：** `contracts/core.md`
**对应表：** `buddy_posts` `buddy_consents`

---

## 1. 画像 Schema（必填 11 字段，字段名不得增删改）

LLM 抽取的输出必须严格是这个结构，`additionalProperties: false`：

```json
{
  "kind": "study|roommate|project|sport|other",
  "grade": "大一|大二|大三|大四|研一|研二|不限",
  "major_group": "工科|理科|文科|经管|艺术|不限",
  "schedule": {
    "early_bird": 0.0,
    "weekend_free": 0.0,
    "busy_slots": [{ "weekday": 3, "period_start": 1, "period_end": 2 }]
  },
  "interests": ["算法", "摄影"],
  "traits": { "chatty": 0.0, "planner": 0.0, "tidy": 0.0 },
  "wanted": "想找一起刷算法题的同学",
  "must_have": ["不抽烟"],
  "deal_breaker": ["凌晨打游戏外放"]
}
```

**取值约定**
- `early_bird`：0 = 夜猫子，1 = 早睡早起
- `weekend_free`：0 = 周末忙，1 = 周末空
- `chatty`：0 = 安静，1 = 话多；`planner`：0 = 随性，1 = 计划控；`tidy`：0 = 随意，1 = 洁癖
- `interests`：最多 5 项，去重
- **用户未提及的可选字段取中性值**（0.5 或空数组），**不得编造**兴趣或性格

---

## 2. ⭐ 匹配评分算法（冻版，不得改权重）

```
buddyScore(post.profile, seeker.profile) -> 0..100

【一票否决】
  seeker.must_have 与 post.deal_breaker 语义冲突  -> 返回 0（出局）
  kind 不一致                                        -> 出局
  （冲突判断用 LLM 做语义判断，不是字符串相等）

【兴趣 35】
  Jaccard(post.interests, seeker.interests) * 35

【作息 30】
  penalty = |Δearly_bird| / 2 * 0.4
          + |Δweekend_free| / 2 * 0.4
          + (busy_slots 冲突 ? 0.2 : 0)
  score_30 = (1 - penalty) * 30
  busy_slots 冲突定义：同 weekday 且节次区间有交集

【性格 20】
  d = sqrt(Δchatty² + Δplanner² + Δtidy²) / sqrt(3)     // 归一化到 0..1
  score_20 = (1 - d) * 20

【语义 15】
  LLM 对 post.wanted 与 seeker.wanted 的契合度 (0..1) * 15

总分 = 35 + 30 + 20 + 15 = 0..100
阈值 = 60，仅返回 >= 60 的候选
```

**每个候选必须带 `reason`**，说清是兴趣重合、作息兼容还是性格接近。
例：`"共同兴趣 2 项(算法/摄影) +26；作息接近 +25；性格互补 +15"（总分 66）`

---

## 3. ⭐ 双选揭示状态机（冻版，不可简化）

```
初始：       author_ok=0, seeker_ok=0, revealed=0
寻找方同意： 设置 seeker_ok=1     -> author_ok 保持 0，revealed 保持 0
发布方同意： 设置 author_ok=1
双方都为 1： revealed=1，此时才返回 contact_code
```

**硬性要求**
- ⛔ 任何一方未同意时，**绝不返回 `contact_code`**
- ⛔ 绝不向一方暗示"对方已经同意了"
- ⛔ 不得把 `anon_token` 与真实身份关联后展示给另一方
- ✅ 同一 `(post_id, seeker_id)` 只能表决一次（靠数据库 UNIQUE 约束）

---

## 4. MCP 工具（本模块 3 个）

### 4.1 `buddy_publish`
```json
{
  "name": "buddy_publish",
  "inputSchema": {
    "type": "object",
    "properties": {
      "author_handle": { "type": "string" },
      "kind":          { "type": "string", "enum": ["study","roommate","project","sport","other"] },
      "text_profile":  { "type": "string", "description": "用户的自然语言描述，服务端负责抽取画像" },
      "photo_path":    { "type": "string" }
    },
    "required": ["author_handle","kind","text_profile"],
    "additionalProperties": false
  }
}
```
返回 `{post_id, anon_token, profile}`。
**服务端负责把 `text_profile` 抽取成 §1 的结构化画像。**
`anon_token` 生成：随机 12 位，**不得由 user_id 派生**（否则可反推身份）。

### 4.2 `buddy_search`
```json
{
  "name": "buddy_search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "seeker_handle": { "type": "string" },
      "kind":          { "type": "string", "enum": ["study","roommate","project","sport","other"] },
      "text_profile":  { "type": "string" },
      "top_k":         { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 }
    },
    "required": ["seeker_handle","kind","text_profile"],
    "additionalProperties": false
  }
}
```
返回 `{candidates:[{anon_token, score, reason, reveal_status}]}`。
- 只返回 `raw_status='open'` 的帖
- 只返回 score >= 60
- `reveal_status`：`"pending"` / `"mutual"`（`"mutual"` 时才附 `contact_code`）
- ⛔ 结果里**不得出现**院系全名、班级、学号、宿舍号、真实姓名、联系方式

### 4.3 `buddy_consent`
```json
{
  "name": "buddy_consent",
  "inputSchema": {
    "type": "object",
    "properties": {
      "post_id":       { "type": "string" },
      "seeker_handle": { "type": "string" },
      "agree":         { "type": "boolean" }
    },
    "required": ["post_id","seeker_handle","agree"],
    "additionalProperties": false
  }
}
```
返回 `{author_ok, seeker_ok, revealed, contact_code?}`。
`revealed=0` 时 **`contact_code` 字段必须完全不出现在返回里**（不是返回 null，是不返回）。

---

## 5. HTTP API（本模块）

```
GET  /api/buddies?kind=   → BuddyPost[]    （仅暴露 anon_token、画像、时间；无 user_id）
POST /api/buddies         → {post_id, anon_token}
```

---

## 6. 页面要素（`static/buddy.html`）

**区块一 · 发布**：类型选择 + 大文本框（引导用户说清：类型/年级/专业大类/作息/兴趣/性格/期望/硬性要求/雷点）+ 可选照片。

**区块二 · 搜索**：类型选择 + 描述框 → 候选列表。

**区块三 · 候选卡片**：每条显示 —— 匿名标识、总分、**匹配理由（分段显示兴趣/作息/性格各多少分）**、
双选状态徽章（待对方同意 / 已互相可见）。

**区块四 · 我的申请**：列出我发出的意愿及当前状态。

⚠️ 候选卡片上**不得有**任何可反推身份的字段。

---

## 7. 本模块禁止事项

- ⛔ 把 `anon_token` 由 user_id 派生
- ⛔ 未双选成功就返回联系方式
- ⛔ 结果里出现院系全名 / 班级 / 学号 / 宿舍号 / 真实姓名
- ⛔ 用中性值硬填后直接发布（`kind` 与 `wanted` 必填，缺失要追问）
- ⛔ 把照片纳入评分
- ⛔ 承接恋爱匹配需求（本模块定位同伴场景）

---

## 8. 完成标准（自测清单）

- [ ] `buddy_publish` 能从一段自然语言抽取出 §1 的全部 11 字段
- [ ] 未提及的字段被填成中性值，**没有编造兴趣**
- [ ] `must_have` 与 `deal_breaker` 语义冲突的候选被排除（测一个真实冲突用例）
- [ ] `kind` 不同的候选被排除
- [ ] 只有一方同意时，返回里**不含** `contact_code` 这个键
- [ ] 双方同意后 `revealed=1` 且 `contact_code` 出现
- [ ] 同一 `(post_id, seeker_id)` 重复表决被数据库 UNIQUE 拦住
- [ ] `anon_token` 与 user_id 无任何可推导关系
- [ ] 候选 `reason` 里的分值相加等于 score
