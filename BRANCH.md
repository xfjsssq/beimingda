# 分支：feat/frontend

## 本分支做什么
**F0 前端与门户**：共用样式 `static/css/app.css`、共用导航 `static/js/nav.js`、统一 API 封装 `static/js/api.js`、演示模式 `static/js/demo.js`、**门户首页 `static/index.html`**（4 区块，统计走真实 API）、**⭐ 评委核心页 `static/agent.html`**（6 区块，含一键复制 MCP 配置）、工具模块 `static/js/mcp-config.js`（MCP 配置生成，供 Node 单测直接校验）。

## 依赖什么
- `contracts/core.md`、`contracts/frontend.md`、`tasks/F0-前端总览.md`
- 各模块 API 至少 `GET /api/health` 可用（T0 已提供）
- 其余 4 个页面（takeout / buddy / welcome / schedule）由各自分支负责，**本分支只提供共用文件**

## 完成标准
`contracts/frontend.md` §7 自测清单全部勾上（含 `/agent` 页复制出来是合法 JSON、令牌为占位符、断网可跑、375px 不破）。

## 不能碰什么
- 其他模块的 html（只引用共用文件；要改共用文件先沟通）
- ⛔ 依赖外部 CDN（第三方库必须本地化到 `static/vendor/` 且带 LICENSE）
- ⛔ 首页统计数字写死 · 课表上传控件 · 页面出现真实姓名/学号/手机号
- ⛔ 在没有实景的点位上假装有实景

## 当前进度
- [x] `static/css/app.css` 按视觉规范（主色 #1F4E8C 等）
- [x] `static/js/nav.js` 6 页导航 + 移动端底部 tab
- [x] `static/js/api.js` 统一 fetch 封装解信封
- [x] `static/js/demo.js` `?demo=1` 徽章与假名替换
- [x] `static/index.html` 门户 4 区块
- [x] `static/agent.html` ⭐ 6 区块 + 复制按钮
- [x] 未使用 Vue 3 → `static/vendor/` 里没有任何前端框架需要本地化（第三方库只有各模块自己的 leaflet / pannellum）

---

## 交付细节（供 Lead 集成时对照）

### 共用文件（其他模块页可直接 `<link>` / `import`）
| 文件 | 说明 |
|---|---|
| `static/css/app.css` | 全站样式：令牌（`--color-primary` 等）、卡片、统计块、按钮、徽章、步骤、工具清单、`≤768px` 底部 tab、`≤380px` 再收一档 |
| `static/js/nav.js` | `mountNav()` 注入页头（自动复用已有 `[data-site-header]`）；`PAGES` / `currentPageId()`；只出 `<a href>`，**不 fetch 任何页面**，别的页暂时 404 也不影响本页 |
| `static/js/api.js` | `api()`（解 `{ok,data,error}` 信封，失败抛带 `code` 的 `ApiError`）、`apiSafe()` / `apiList()`（未就绪返回 `null`，不炸页面）、`mcpRpc()` / `mcpToolNames()`（POST /mcp 探测）、`apiToken()` |
| `static/js/demo.js` | `isDemo()` / `initDemo()` / `displayName()` / `aliasFor()` / `maskDom()` |
| `static/js/mcp-config.js` | 纯函数：`buildMcpConfig()` / `toMcpConfigJson()` / `resolveMcpUrl()` / `TOOLS_BY_MODULE` / `SAMPLE_DIALOGUES` / `SETUP_STEPS`（可被 Node 直接 import 单测） |

### 写接口令牌的来源（重要）
`static/js/api.js` 的令牌优先级：**① 服务端注入 `window.__DEMO_TOKEN__`（或 `<meta name="demo-token">`）→ ② 本机 `sessionStorage`（由 `?token=xxx` 或 `setApiToken()` 写入，写入后立刻从地址栏抹掉）**。
⛔ 页面与脚本里没有任何真实令牌字面量。
**待办（Lead 侧，属 `src/**`）**：`src/server.js` 的 `/config.js` 目前只注入 `__TILE_KEY__` / `__SITE_DOMAIN__` / `__APP_VERSION__`，若希望写接口在页面上也能用，需要在那里补一行 `window.__DEMO_TOKEN__`（读 `process.env.DEMO_TOKEN`）。不补也能跑：读接口开放，写接口返回 401 且页面会提示，不会白屏。

### `/agent` 页 MCP 配置
- 默认 `url = location.origin + "/mcp"`；可一键切到「正式站点域名」= `https://${window.__SITE_DOMAIN__}/mcp`（域名只从 `/config.js` 注入读，⛔ 页面里没有 `demo.knowingly.dpdns.org` 字面量）
- 令牌恒为 `<DEMO_TOKEN>` 占位符；复制/下载内容与页面展示内容同源（同一个 `toMcpConfigJson()`）
- 剪贴板：`navigator.clipboard` 失败时退到 `execCommand('copy')`；再失败就自动帮你选中 JSON，按一次 Ctrl/⌘+C 即可

### 与并行分支的接口约定
- 首页「活跃跑腿者数」依次尝试 `GET /api/runners` → `GET /api/stats`（`.active_runners`）。**M1 若愿意多暴露一个 `GET /api/runners`，这个数字就能直接点亮**；不暴露则显示「—」+ 说明，绝不编数字。
- 「平均匹配得分」尝试 `GET /api/matches`（取 `score` 平均）→ `GET /api/stats`（`.avg_match_score`）。
- 「开放代取任务数」= `GET /api/tasks` 的 length（按契约只含 open 且未过期）；「搭子帖数」= `GET /api/buddies` 的 length。
- 契约 §5 的演示数据接口 `/api/demo/seed` 尚未实现：`?demo=1` 时首页会**如实说明**“演示数据接口尚未就绪”，不会假装有数据。

### 自测
`npm test`（含 `tests/f0-frontend.test.js` 12 条）与 `npm run smoke` 全绿；
真实浏览器（Edge/CDP，375px + 1280px）实测：`/`、`/agent` 无横向溢出、无 JS 异常、复制出的 JSON `JSON.parse` 通过。
