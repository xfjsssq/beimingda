# 分支：feat/m3-welcome

## 本分支做什么
**M3 迎新导览**：静态截图底图 + 点位打标、节点详情、Pannellum 360° 全景查看器、MCP 2 个工具 + `GET /api/map/nodes`、`static/welcome.html`、vendor 本地化。

> ⚠️ **底图方案已变更**（2026-10-27，项目负责人决定，见 `contracts/m3-welcome.md` §1）：
> 原设计是「Leaflet + 天地图影像瓦片」，现改为**手机地图截图当底图 + 点位百分比坐标**。
> 理由：这是 demo，申请天地图 tk 的收益不值得；截图方案零申请、零依赖、断网可跑。
> 影响：**不再需要 Leaflet**（省掉一个 vendor），`TILE_PROVIDER_KEY` 不再使用（`/config.js` 注入点保留给以后）。
> 点位在图上的相对坐标写在 `static/map/map-bg.json`（⛔ 不动数据库 schema）。

## 依赖什么
- `contracts/core.md`、`contracts/m3-welcome.md`、`tasks/M3-迎新导览.md`
- T0 骨架已合入 `main`
- 底图素材：`static/map/campus-map.jpg`（手机地图截图，**由负责人提供**；当前放的是占位示意图 `campus-map.svg`）
- 全景素材：`pano/*.jpg`（**当前 0 张**，补图 SOP 见 `pano/HOWTO-补全景.md`）

## 完成标准
`contracts/m3-welcome.md` §8 自测清单全部勾上（含断网后 Pannellum 仍能加载）。
全景那一条：有实景点位能进 360°；**当前无素材时，页面如实显示"该点暂无实景"即算通过**。

## 不能碰什么
- `src/db/schema.sql`、`contracts/` 下任何文件
- ⛔ 硬编码密钥 · 依赖外部 CDN · 用非本校图片冒充实景 · 底图不标注来源
- ⛔ `pano_url` 为空时含糊说"可以看图" · 提供楼栋级以下信息（房间号、宿舍分配）
- ⛔ Agent 侧编造距离或步行时间

## 当前进度
- [x] `config/map-nodes.json`：12 个节点覆盖 5 类，label 为**楼栋规范名**（M1 需字面复用）
- [x] `static/map/map-bg.json` + `static/map/campus-map.svg`：底图与百分比坐标（等真实截图替换）
- [x] `src/services/map.js`（listNodes / getNode / mapSummary）
- [x] MCP 2 工具 `map_list_nodes` / `map_get_node` 注册并实测（含 NOT_FOUND、additionalProperties 拦截）
- [x] `GET /api/map/nodes` + `GET /api/map/summary`
- [x] `static/welcome.html`：截图底图 + 分类筛选 + 点位标记 + 详情面板 + Pannellum 全屏查看器 + 无实景诚实提示
- [x] `static/vendor/pannellum/`（pannellum.js / pannellum.css / COPYING / VERSION，v2.5.7，MIT）
- [x] `pano/HOWTO-补全景.md`：补素材保姆级 SOP（拍摄、是否需缝合、360 判定、参数、验证）
- [x] 自测：`npm test` 10/10、`npm run smoke` 8/8、接口与 MCP 工具全部实测通过
- [x] 独立复验（2026-10-27，lead，worktree `bm/m3`）：`npm test` 10/10；起服务后
      `/api/health` `/api/map/nodes` `/api/map/summary` `/welcome` `/map/map-bg.json`
      `/map/campus-map.svg` `/vendor/pannellum/pannellum.js` `/pano/manifest.json` 全部 200；
      `npm run seed` 后 `/api/map/nodes` 返回 12 个节点（5 类齐全）、`/api/map/summary` 报 `total=12, with_pano=0`
      → 页面走「该点暂无实景」诚实提示路径 ✓
- [ ] 真实底图替换（`static/map/campus-map.jpg`）＋坐标微调 —— **卡在素材**：需人工用手机地图截一张校园图存成
      `static/map/campus-map.jpg`，再把 `static/map/map-bg.json` 的 `image` 改成 `/map/campus-map.jpg`
      （该文件 `_howto` 字段里有 4 步流程图；改完刷新页面按需微调 `points` 百分比，不用重启服务）
- [ ] 全景素材补齐（≥2 个点位互加 `hotSpots` 即可演示跳转）—— 卡在素材，SOP 见 `pano/HOWTO-补全景.md`
- [x] PR 到 `main`：依赖的契约修订（PR #2 / #3）已合入 `main`，本分支已具备开 PR 条件
- [x] 全景「无实景」这条验收：当前 0 张素材即通过（页面如实显示"该点暂无实景"）
- [x] **本分支额外携带一处核心层修复**（合入 main 后 M1/M2 分支即可受益）：
      `tests/skeleton.test.js` 里 T0 留下的过期断言 `assert.deepEqual(list.result.tools, [])`
      —— 任何模块注册 MCP 工具后 `tools/list` 必然非空，该断言必挂。已改为
      「返回数组 + 每个工具 `inputSchema.additionalProperties === false` + 工具名不重复」。
      ⚠️ 集成注意：合并本分支**必须先于** M1/M2，或保证三者的该文件字节一致（当前已对齐，SHA256 前 16 位 `E092CA0D10683F77`）。
