# main · 集成分支（模块交付名册）

> 每个模块分支在自己的 `BRANCH.md` 里写「本分支做什么 / 依赖什么 / 完成标准 / 不能碰什么」；
> 合进 `main` 后本文件改为**名册**：逐模块一行，细节回对应 `feat/*` 分支查看该分支自己的 `BRANCH.md`。

| 分支 | 模块 | 交付物 | 状态 |
|---|---|---|---|
| `feat/m3-welcome` | M3 迎新导览 | `src/services/map.js` · `src/api/map.js` · `src/mcp/handlers/map.js` · `static/welcome.html` · `static/map/map-bg.json` · `pano/` · Pannellum 本地化 | ✅ 已合（底图/全景素材待人工补，页面如实显示"该点暂无实景"） |
| `feat/m1-takeout` | M1 代取撮合 | `src/engine/match.js` · `src/services/{task,runner,users}.js` · `src/api/tasks.js` · `src/mcp/handlers/takeout.js` · `static/takeout.html` · fixtures | ✅ 已合（契约 §7 八条逐条过） |
| `feat/frontend` | F0 前端与门户 | `static/css/app.css` · `static/js/{api,nav,demo,mcp-config}.js` · `static/index.html` · `static/agent.html` | ✅ 已合（契约 §7 过） |
| `feat/m2-buddy` | M2 搭子匹配 | `src/engine/{doubleOpt,buddy}.js` · `src/services/buddy.js` · `src/api/buddies.js` · `src/mcp/handlers/buddy.js` · `static/buddy.html` · fixtures | ✅ 已合（契约 §8 九条逐条过） |
| `feat/m4-schedule` | M4 日程提醒 | 由协作者 `CJY-sys` 负责，不列在本名册 | ⏳ 队友分支 |
| `chore/integration` | 集成校验 | 跨模块合并、`scripts/verify-integration.js`、核心层收尾 | Lead 维护 |

## 共享文件接触面（多人同时改，合并时只看这几处）

| 文件 | 规则 |
|---|---|
| `src/mcp/handlers.js` | 每个模块只加自己的 `import` 与 `MODULE_REGISTRARS` 数组项，⛔ 不动别人的行、不重排 |
| `src/api/routes.js` | 每个模块只加自己的 `import` 与一行 `router.use(...)` |
| `tests/skeleton.test.js` | T0 的 `tools/list === []` 断言已过期，统一改为「返回数组 + 每个工具 `additionalProperties:false` + 工具名不重复」，**各分支内容字节一致**（SHA256 前 16 位 `E092CA0D10683F77`） |
| `BRANCH.md` | 各分支各写自己的；合进 main 后以本名册为准，冲突时保名册、细节回分支看 |
| `config/map-nodes.json` | M3 维护；M1 的 `from_building`/`to_building` 必须与它的 `label` **字面一致**（可达性得分的唯一依据） |

## 集成校验（一条命令跑完）

```bash
npm test          # 单测（信封 / schema / 各模块引擎与 service）
npm run smoke     # 骨架级冒烟（鉴权 / 表清单 / 无硬编码密钥）
npm run verify    # 模块级集成：自动发现 MCP 工具真调 + 6 页面 + HTTP 路由 + CDN 红线
```

## 已知限制（如实记录，不是待修 bug）

1. **LLM 能力默认关闭**：`.env` 里 `LLM_*` 为空时，M1 的截图字段理解、M2 的语义 15 分都走**规则化降级实现**（功能不阻塞、精度下降）。有 key 时自动走模型；未为自测调用过付费模型。
2. **M1 fixtures 用相对时间**（`*_in_minutes`）：路演/录制前必须重跑 `npm run seed -- --reset`，否则任务全部过期。
3. **M2 契约标题「11 字段」是概数**：以 `contracts/m2-buddy.md` §1 的 JSON 结构为权威（9 个顶层键 / 13 个叶子字段）。
4. **M2 发布方"拒绝后不可反悔"仅在进程内记忆**：三个 bit 列无法区分"没表态"与"拒绝了"；寻找方侧由数据库 `UNIQUE(post_id, seeker_id)` 硬保证（契约要求的那一条）。
5. **M3 底图与全景是人工素材**：底图需一张手机地图截图（`static/map/campus-map.jpg`），全景按 `pano/HOWTO-补全景.md` 补；缺素材时页面诚实提示，不拿别的图糊弄。
6. **本机 3000 端口被无关常驻进程占用**：本地演示请 `PORT=3080 npm start`，MCP 地址相应变为 `http://<host>:3080/mcp`。
