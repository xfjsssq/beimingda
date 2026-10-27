# 数据库表结构 · DB-SCHEMA

**权威来源：`contracts/core.md` §2 与 `src/db/schema.sql`。三者不一致时以 `contracts/` 为准并提 PR 修正。**
⛔ 全站不允许出现可存储真实身份信息的字段。

时间一律 **Unix 秒（INTEGER）** 存库，出接口转 ISO 8601（用 `src/util/time.js`）。

---

## 九张表

| 表 | 归属模块 | 用途 |
|---|---|---|
| `users` | core | 用户：**仅昵称**，无任何身份字段 |
| `tasks` | M1 | 代取任务 |
| `runners` | M1 | 跑腿方可达楼栋 / 报酬下限 / 可用时段 |
| `matches` | M1 | 撮合记录（score + state） |
| `buddy_posts` | M2 | 搭子帖（匿名，含结构化画像） |
| `buddy_consents` | M2 | 双选表决与揭示状态 |
| `schedule_items` | M4 | 日程（只收 6 类匿名字段） |
| `map_nodes` | M3 | 地图节点（含全景图路径） |
| `scrub_audit` | M4 | ★ 脱敏审计：**只记字段名，绝不记值** |

---

## users

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | uuid |
| handle | TEXT | NOT NULL UNIQUE | 昵称，如"同学A" |
| contact_code | TEXT |  | 双选揭示后才返回的联系代号 |
| created_at | INTEGER | NOT NULL | Unix 秒 |
| demo | INTEGER | NOT NULL DEFAULT 0 | 演示数据标记 |

## tasks（代取任务）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | |
| owner_id | TEXT | NOT NULL REFERENCES users(id) | 发布者 |
| from_building / to_building | TEXT | NOT NULL | 楼栋**规范名**（与 `config/map-nodes.json` 的 label 字面一致） |
| station | TEXT | NOT NULL | 快递站名 |
| deadline_ts | INTEGER | NOT NULL | 截止时刻 |
| reward_min / reward_max | REAL | NOT NULL | 报酬区间，必须 `reward_min <= reward_max` |
| note | TEXT |  | 备注（已脱敏） |
| screenshot_path | TEXT |  | 打码后截图相对路径，可 null |
| raw_status | TEXT | NOT NULL DEFAULT 'open' | `open` / `matched` / `done` / `cancelled` |
| created_at | INTEGER | NOT NULL | |
| demo | INTEGER | NOT NULL DEFAULT 0 | |

索引：`idx_tasks_status_deadline(raw_status, deadline_ts)` —— 撮合查询走它。

## runners（跑腿方能力）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | |
| user_id | TEXT | NOT NULL **UNIQUE** REFERENCES users(id) | 同一用户重复登记 → 覆盖更新 |
| reachable_buildings | TEXT | NOT NULL | JSON 数组 `["12号宿舍楼","15号宿舍楼"]` |
| reward_floor | REAL | NOT NULL | 可接受报酬下限 |
| time_windows | TEXT | NOT NULL | JSON `[{"start":ts,"end":ts}]` |
| active | INTEGER | NOT NULL DEFAULT 1 | |
| created_at | INTEGER | NOT NULL | |
| demo | INTEGER | NOT NULL DEFAULT 0 | |

## matches（撮合记录）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PK |
| task_id | TEXT | NOT NULL REFERENCES tasks(id) |
| runner_id | TEXT | NOT NULL REFERENCES runners(id) |
| score | REAL | NOT NULL（0~100） |
| state | TEXT | NOT NULL DEFAULT 'pushed'（`pushed` / `accepted` / `declined` / `expired`） |
| created_at | INTEGER | NOT NULL |

索引：`idx_matches_task(task_id, score DESC)`。推送去重查 `(task_id, runner_id, created_at > now-300)`。

## buddy_posts（搭子帖 · 匿名）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | |
| author_id | TEXT | NOT NULL REFERENCES users(id) | ⛔ 对外**绝不**透出 |
| kind | TEXT | NOT NULL | `study`/`roommate`/`project`/`sport`/`other` |
| profile_json | TEXT | NOT NULL | 11 字段画像（见 `contracts/m2-buddy.md` §1） |
| anon_token | TEXT | NOT NULL **UNIQUE** | 随机 12 位，⛔ 不得由 user_id 派生 |
| raw_status | TEXT | NOT NULL DEFAULT 'open' | |
| created_at | INTEGER | NOT NULL | |
| demo | INTEGER | NOT NULL DEFAULT 0 | |

## buddy_consents（双选）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PK |
| post_id | TEXT | NOT NULL REFERENCES buddy_posts(id) |
| seeker_id | TEXT | NOT NULL REFERENCES users(id) |
| score | REAL | NOT NULL |
| author_ok / seeker_ok / revealed | INTEGER | NOT NULL DEFAULT 0 |
| created_at | INTEGER | NOT NULL |
| — | — | **UNIQUE(post_id, seeker_id)**：同一人对同一帖只能表决一次（靠数据库兜底） |

## schedule_items（日程）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | |
| user_id | TEXT | NOT NULL REFERENCES users(id) | |
| weekday | INTEGER | NOT NULL | 1~7 |
| period_start / period_end | INTEGER | NOT NULL | 节次，`period_end >= period_start` |
| title | TEXT | NOT NULL | 课程名（入库前去掉人名部分） |
| room | TEXT |  | 教室，可空 |
| weeks | TEXT |  | 形如 `"1-16"` 或 `"1-8,10-16"` |
| remind_before | INTEGER |  | 提前多少分钟提醒；null = 不提醒 |
| created_at | INTEGER | NOT NULL | |
| demo | INTEGER | NOT NULL DEFAULT 0 | |

索引：`idx_sched_user_weekday(user_id, weekday, period_start)`。

## map_nodes（地图节点）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | 如 `dorm-12` |
| label | TEXT | NOT NULL | 如 `"12号宿舍楼"`（与 M1 楼栋规范名一致） |
| category | TEXT | NOT NULL | `dorm`/`canteen`/`teaching`/`gate`/`service` |
| lat / lng | REAL | NOT NULL | 经纬度 |
| pano_url | TEXT |  | **可 null**：表示该点无实景，前端如实提示 |
| pano_yaw | REAL | DEFAULT 0 | 全景初始朝向 |
| desc | TEXT |  | 周边描述 |
| sort | INTEGER | NOT NULL DEFAULT 0 | 显示顺序 |

## scrub_audit（★ 脱敏审计）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| item_type | TEXT | NOT NULL | 如 `schedule` |
| dropped_fields | TEXT | NOT NULL | JSON 数组，**只含字段名**，⛔ 绝不写值 |
| created_at | INTEGER | NOT NULL | |

对外只读：`GET /api/scrub/audit?limit=`（评委核验用）。

---

## 禁字段黑名单（M4 双层防御的第二层）

```
name  realName  studentNo  studentId  stuNo  teacher  teacherName
className  major  college  grade  score  gpa  rank  phone  mobile  idCard
```

`src/services/scrub.js` 逐字段扫描：命中黑名单 → **丢弃该字段** + 写 `scrub_audit`（只记字段名）。
⛔ 只靠 schema 防御不算完成，service 层必须独立再扫一遍。
