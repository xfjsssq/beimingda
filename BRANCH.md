# 分支：feat/m1-takeout

## 本分支做什么
**M1 代取撮合**：撮合评分引擎 + 任务/跑腿 service + MCP 5 个工具 + `GET/POST /api/tasks` 路由 + `static/takeout.html`
+ 两条**只读**门户辅助口 `GET /api/runners`、`GET /api/matches`（F0 首页统计用，契约外、已按 M3 `/api/map/summary` 的先例处理）。

## 依赖什么
- `contracts/core.md`（表结构、信封、鉴权）
- `contracts/m1-takeout.md`（算法与工具契约，**权重 40/30/30 与阈值 60 不得改**）
- `tasks/M1-代取撮合.md`（任务卡）
- T0 骨架已合入 `main`（`src/server.js` `src/db/` `src/mcp/` `src/util/` 可用）

## 完成标准
`contracts/m1-takeout.md` §7 自测清单全部勾上，外加 `npm test` 有撮合断言测试。

## 不能碰什么
- `src/db/schema.sql`（要改先提 PR 到 main）
- `src/mcp/tools.js` / `src/mcp/handlers.js` 里**其他模块**的工具定义（只加 m1 区块）
- `contracts/` 下任何文件
- 截图原图落盘、从截图抽取姓名/手机号/运单号

## 当前进度
- [x] `src/engine/match.js` 撮合评分引擎（含可解释 reason，分值严格相加 = score）
- [x] `src/services/task.js` `src/services/runner.js` `src/services/users.js`
- [x] MCP 5 工具注册与 handler（`src/mcp/handlers/takeout.js`）
- [x] `src/api/tasks.js` + `src/api/routes.js` 挂 4 条路由
- [x] `static/takeout.html` 4 区块（匹配结果区显示 score 与 reason）
- [x] `fixtures/tasks.json` 10 条 / `fixtures/runners.json` 9 名（含可匹配 / 无人可接 / 不可达 / 时间不重叠 / 已过期 / done 六类样本）
- [x] `tests/m1-takeout.test.js` 覆盖契约 §7 八条 + reason 分值 = score

## 本分支新增/改动的文件（集成时看这里）
| 文件 | 说明 |
|---|---|
| `src/engine/match.js` | 新增。评分引擎，参数从 `config/match-rules.json` 读 |
| `src/services/users.js` | 新增。昵称→用户（`ensureUser`）+ 入参归一化，**与 `scripts/seed.js` 的 `demo-user-<handle>` 约定一致**，避免 handle UNIQUE 与外键冲突 |
| `src/services/task.js` | 新增。任务 CRUD / 发布校验 / 撮合落库 / 推送去重 / 截图字段理解 |
| `src/services/runner.js` | 新增。能力登记（`runners.user_id` UPSERT） |
| `src/mcp/handlers/takeout.js` | 新增。5 个工具 schema（照抄契约）+ handler（不写 SQL） |
| `src/mcp/handlers.js` | **只加 2 行**：顶部 `import { registerTakeoutTools }`；`MODULE_REGISTRARS` 里 `{ module: "m1", register: registerTakeoutTools }`（m2/m3/m4 的注释行未动） |
| `src/api/tasks.js` | 新增。4 条路由，写接口 `requireWriteToken` |
| `src/api/runners.js` | 新增。`GET /api/runners` 只读、脱敏（不出 `user_id` / 联系方式），门户「活跃跑腿者数」用 |
| `src/api/matches.js` | 新增。`GET /api/matches?limit=` 只读，最近撮合记录（含 `score`），门户「平均匹配得分」用 |
| `src/api/routes.js` | **只加 5 行**：3 个 import + `router.use("/tasks"/"/runners"/"/matches", …)`（挂在 404 兜底之前），其他模块的行未动 |
| `static/takeout.html` | 新增。自包含（内联样式+脚本），只外链 `/config.js` |
| `fixtures/tasks.json` `fixtures/runners.json` | 覆盖写（原来各 1 条占位） |
| `tests/m1-takeout.test.js` | 新增 |
| `tests/skeleton.test.js` | 由 lead 预置的 T0 过期断言修复（tools/list 不再断言为空），本分支仅原样提交 |

## 降级实现说明（无 LLM key 时）
`.env` 里 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 为空 → `task_parse_screenshot` 走**规则化兜底**：
- 只用 `hint` 文本做确定性匹配：楼栋/快递站取自 `config/map-nodes.json` 的规范 `label`，报酬区间识别「3-5元 / 3块到5块」这类写法；
- **不做 OCR、不调外部接口、图片不落盘、不打日志**；
- 识别不出的字段一律 `null`，关键字段全空时 `confidence = 0`（`<0.4` 时强制全 null，不猜测）；
- `deadline_iso` 与 `note` 在兜底路径里**刻意不填**（时间表述歧义大；自由文本可能带姓名/电话/单号，抄进库等于变相抽取）；
- 三件套配齐时才走真模型调用（`POST {LLM_BASE_URL}/chat/completions`，图片以 data URL 进请求体，25 秒超时，⛔ 单次 < 90 秒），模型返回里除契约字段外的键一律丢弃，姓名/手机号/运单号不落任何字段。
> M2 分支的语义相似度兜底同理，但那是 M2 的文件，本分支不碰。

## 其他实现约定（评审可能问）
- **可解释性**：三段得分各自四舍五入到 2 位小数，再按整数「分」相加 → `reason` 里显示的数字相加**严格等于** `score`（不会出现「+30 却 59.7」）。
- **推送**：单任务最多同时推 3 名（`max_push_per_task`），只对前 3 名写 `matches`；超出的候选仍在返回里，带 `skip_reason`。
- **去重**：同一 `(task_id, runner_id)` 300 秒内不重复写 `matches`；被跳过的候选仍然返回 score/reason，只把 `pushed` 置 false 并给出 `skip_reason`（这样演示时重复点「查看匹配」不会 401/空结果，也不会重复落库）。
- **note 脱敏**：手机号（11 位）与 ≥12 位长数字串入库前打码，并把**字段名**（`phone,tracking_no`）写进 `scrub_audit`（只记名字，绝不记值）。
- **active 过滤**：`active = 0` 的能力登记不进候选池（service 层 `WHERE active=1`，引擎里也再判一次）。

## 集成注意（lead 用）
1. `src/mcp/handlers.js` 与 `src/api/routes.js` 各只加了自己那两行，**与 m2/m3/m4 的改动不重叠**；若发生冲突，保留 m1 的那两行即可。
2. 🖊 **前端令牌**：写接口要 `X-Demo-Token`、MCP 要 `Authorization: Bearer`。`static/takeout.html` 按 `?token=` → `window.__DEMO_TOKEN__` → `localStorage` 的优先级取令牌（**不硬编码**）。若希望评委零操作就能发布/撮合，可在 `/config.js` 里注入 `window.__DEMO_TOKEN__`（我按边界要求没有改 `src/server.js`，请 lead 决定）——注入后我的页面会自动用上，无需改页面。
3. `static/takeout.html` 的楼栋下拉优先读 M3 的 `GET /api/map/nodes`，接口不存在时用与 `config/map-nodes.json` 字面一致的内置兜底清单；M3 合进来后自动切换。
4. 本分支**没有** `static/js/api.js` / `nav.js`，页面自带内联脚本；F0 合入后若要统一样式，只需替换 `<style>` 与外链，别动脚本逻辑（匹配结果区的 `score` / `reason` 渲染是评委看点）。
5. fixtures 的时间是 `*_in_minutes` 相对时间 → **路演/录制前请重跑 `npm run seed -- --reset`**，否则任务会全部过期。
6. `demo-runner-2`（同学E）刻意把报酬下限设成 4 元，让它稳定在 65~75 分；避免演示中途从候选里消失（50% 覆盖边界会随时间把 60 分卡在阈值上下）。
7. **门户两格数据**：`GET /api/runners` 已能点亮「活跃跑腿者数」（seed 后 = 8）。`GET /api/matches` 在 `seed` 之后是 **0 条**（库里的 `matches` 只有撮合过才有行）→ F0 的「平均匹配得分」会显示「—」，在 `/takeout` 点一次「查看匹配」（或调 `match_find_for_task`）后即变为真实平均分（实测 86.7）。若希望**首页开箱即有数**，需要在核心层加一步「对 open 任务跑一遍撮合」（`scripts/seed.js` 末尾或 `/api/demo/seed`）——这两个都是核心层文件/路由，我没动，请 lead 定。

## 验收证据（本分支提交时实测）
- `npm test` → **27/27 通过**（T0 的 10 条 + M1 的 17 条）
- `npm run smoke` → **8/8 通过**
- `node scripts/verify-integration.js`（lead 的跨模块验证器，临时拷入后已删）→ M1 相关 `tools/schema/call/guard/page( /takeout )/route( /api/tasks* )` 全 ✅；❌ 仅 buddy*/map*/schedule* 与 `/buddy /welcome /schedule /agent`（其他模块未合并）
- `npm run seed -- --reset && npm run seed -- --check` → tasks 10 / runners 9 灌库成功
- 起服务实测：MCP 5 工具注册、`GET/POST /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/match`（含 5 分钟去重）、`demo-task-1` 6 名候选按 score 降序、`demo-task-5` 0 候选（无人可接）、`/takeout` HTTP 200
- 门户辅助口实测（复刻 F0 `index.html` 的 `listOf()` 消费逻辑）：`GET /api/runners` → 8 人（9 名里 1 名 `active=false` 被排除），返回里**不含** `user_id` / `contact_code`；撮合一次后 `GET /api/matches?limit=20` → 3 条、平均得分 **86.7**
