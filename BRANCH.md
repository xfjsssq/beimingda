# 分支：feat/m2-buddy

## 本分支做什么
**M2 搭子匹配**：11 字段画像抽取 + 匹配评分（35/30/20/15）+ 双选揭示状态机 + MCP 3 个工具 + `GET/POST /api/buddies` + `static/buddy.html`。

## 依赖什么
- `contracts/core.md`（表结构、信封、鉴权）
- `contracts/m2-buddy.md`（画像 schema、算法权重、状态机，**双选状态机不得简化**）
- `tasks/M2-搭子匹配.md`（任务卡）
- T0 骨架已合入 `main`

## 完成标准
`contracts/m2-buddy.md` §8 自测清单全部勾上，外加断言测试覆盖「`revealed=0` 时返回对象里不含 `contact_code` 键」。

## 不能碰什么
- `src/db/schema.sql`、`contracts/` 下任何文件
- `src/mcp/tools.js` / `handlers.js` 里其他模块的区块
- ⛔ 由 user_id 派生 `anon_token`、未双选成功就返回联系方式、结果里出现院系全名/班级/学号/宿舍号/真实姓名
- ⛔ 把照片纳入评分、承接恋爱匹配需求

## 当前进度
- [x] `src/engine/doubleOpt.js` 双选揭示状态机（单独文件，便于评审对照；`revealed=0` 时 `contact_code` 键根本不出现）
- [x] `src/engine/buddy.js` 画像抽取 + 评分（权重 35/30/20/15、阈值 60、一票否决）
- [x] `src/services/buddy.js` 帖 CRUD + 候选检索 + 表决（`anon_token` 随机、白名单投影）
- [x] MCP 3 工具注册与 handler（`src/mcp/handlers/buddy.js`；`handlers.js` 的 MODULE_REGISTRARS 只加 m2 一行）
- [x] HTTP `/api/buddies`（`src/api/buddies.js`；`src/api/routes.js` 只加一行 `router.use("/buddies", ...)`）
- [x] `static/buddy.html` 4 区块（页面自包含，主色 #1F4E8C）
- [x] `fixtures/buddy-posts.json` 12 条（覆盖 5 种 kind + 3 组 must_have/deal_breaker 语义冲突）
- [x] `tests/m2-buddy.test.js` 覆盖契约 §8 全 9 条（含「`revealed=0` 时返回对象不含 `contact_code` 键」）

### LLM 与降级（重要，评审对照）
`.env` 未配置 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 时，本模块走**降级实现**（不是把功能删掉）：

| 环节 | 有 key（走模型） | 无 key（当前分支的实际行为） |
|---|---|---|
| 画像抽取 | OpenAI 兼容 `/chat/completions`，严格输出 §1 结构 | 关键词/同义词词典 + 正则；未提及的一律取中性值（0.5 / `[]` / `不限`），⛔ 不编造兴趣 |
| 语义 15 分 | 模型给 0..1 契合度 | `0.45×二元组 Jaccard + 0.40×兴趣关键词包含度 + 0.15×归一化编辑距离` |
| 一票否决 | 模型做语义冲突判定 | 冲突主题表（噪音/抽烟/作息/卫生/宠物/访客/气味/游戏/费用）+ 否定语义或反义立场判据 |

两条路径都保留「语义 15 分照常计入总分」；模型调用失败/超时（默认 8s）会自动回落到规则化实现并打一条 `[buddy] LLM 调用失败…` 警告。

### 本模块自加的只读辅助路由（契约 §5 两条冻结路由原样保留）
- `GET /api/buddies/search?kind=&text=&handle=&top_k=` —— 页面区块二/三要显示「总分 + 分段理由」，契约里的 `GET /api/buddies` 只给列表（无评分），因此按同一 service 另开一条只读路由
- `GET /api/buddies/mine?handle=` —— 页面区块四「我的申请」
两条都**不建用户、不写库**，所以按 core.md §4「读接口开放」不加令牌。

### 与核心层的接触面（Lead 合并时注意）
- `src/mcp/handlers.js`：新增 1 个 import + `MODULE_REGISTRARS` 里把 m2 的注释行换成 `{ module: "m2", register: registerBuddyTools },`（未动其他模块的行）
- `src/api/routes.js`：新增 1 个 import + 1 行 `router.use("/buddies", createBuddiesRouter());`（未动其他模块的行）

