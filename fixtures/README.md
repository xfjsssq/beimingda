# fixtures · 演示数据

**⛔ 全部数据必须是虚构的，`demo=1`。** 姓名一律"同学A / 同学B…"，
学校/学号一律 `2025XXXX`（表结构里本来也没有学号字段）。

| 文件 | 归属分支 | 要求 |
|---|---|---|
| `tasks.json` | `feat/m1-takeout` | ≥8 条代取任务，**故意构造"能匹配 / 不能匹配"两类** |
| `runners.json` | `feat/m1-takeout` | ≥6 名跑腿者，可达楼栋、报酬下限、时段各不相同 |
| `buddy-posts.json` | `feat/m2-buddy` | ≥10 条帖，覆盖 5 种 `kind`，**含 `must_have` vs `deal_breaker` 语义冲突组合** |
| `schedule.json` | `feat/m4-schedule` | ≥20 条课表，**只含 6 个白名单字段** + `remind_before` |

## 时间写法（三种任选）

- 绝对：`deadline_iso: "2026-10-30T20:00:00+08:00"`
- 绝对（秒）：`deadline_ts: 1793000000`
- 相对：`deadline_in_minutes: 360`（相对执行 `npm run seed` 的时刻）

时段同理：`start_iso/end_iso`、`start_ts/end_ts`、`start_in_minutes/end_in_minutes`。

## 幂等性

`npm run seed` 用"确定性主键 + `INSERT OR IGNORE`"实现幂等：
重复执行不会产生重复行，也不会覆盖你手动改过的数据。
需要重灌演示数据时用 `npm run seed -- --reset`。

## 楼栋规范名

`from_building` / `to_building` 必须与 `config/map-nodes.json` 里 `category: "dorm"` 的
`label` **字面一致**（例：`"12号宿舍楼"`）。M1 与 M3 两条分支都要守这条，否则拿不到可达性得分。
