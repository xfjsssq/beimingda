# 分支：feat/m4-schedule

## 本分支做什么
**M4 日程与主动提醒**（全站合规最敏感）：字段白名单 + 禁字段黑名单**双层防御**、脱敏审计、MCP 4 个工具、`GET/POST /api/schedule` + `GET /api/scrub/audit`、`scripts/reminder.js`、`static/schedule.html`。

## 依赖什么
- `contracts/core.md`、`contracts/m4-schedule.md`、`tasks/M4-日程提醒.md`
- T0 骨架已合入 `main`；`config/periods.json`（节次→时刻）已就位

## 完成标准
`contracts/m4-schedule.md` §9 自测清单全部勾上，特别是：
- 绕过 schema 直调 service 仍被 `scrub.js` 拦下
- `scrub_audit.dropped_fields` **只有字段名、无任何值**
- 全仓 `grep -ri upload` 找不到课表上传接口

## 不能碰什么
- `src/db/schema.sql`、`contracts/` 下任何文件
- ⛔ **任何形式的课表文件上传接口或按钮** · 代用户登录学校系统拉课表
- ⛔ `schedule_items` 出现白名单外字段 · `scrub_audit` 记录任何字段值
- ⛔ 用 SSE 长连接做提醒 · 只靠 schema 防御而 service 层不二次扫描

## 当前进度
- [ ] `src/services/scrub.js` ⭐（黑名单 + 二次扫描 + 审计写入）
- [ ] `src/services/schedule.js`（导入前先清旧数据）
- [ ] MCP 4 工具注册与 handler
- [ ] `src/api/routes.js` 3 条路由（含 `/api/scrub/audit`）
- [ ] `scripts/reminder.js` 定时提醒计算
- [ ] `static/schedule.html` 5 区块（导入指引必须显眼）
- [ ] `fixtures/schedule.json` ≥20 条 + 恶意请求测试用例
