# 分支：feat/m3-welcome

## 本分支做什么
**M3 迎新导览**（纯前端为主）：Leaflet + 天地图影像瓦片卫星图、节点详情、Pannellum 全景 tour、MCP 2 个工具 + `GET /api/map/nodes`、`static/welcome.html`、vendor 本地化。

## 依赖什么
- `contracts/core.md`、`contracts/m3-welcome.md`、`tasks/M3-迎新导览.md`
- T0 骨架已合入 `main`；`config/map-nodes.json` 为占位（坐标待实测）
- 前端配置注入：T0 已在 `src/server.js` 提供 `GET /config.js`，页面用 `window.__TILE_KEY__` 取天地图 key（⛔ 不许硬编码）

## 完成标准
`contracts/m3-welcome.md` §8 自测清单全部勾上（含断网后 Leaflet/Pannellum 仍能加载）。

## 不能碰什么
- `src/db/schema.sql`、`contracts/` 下任何文件
- ⛔ 自建底图 / 未授权或境外地图源 · 硬编码 `TILE_PROVIDER_KEY` · 依赖外部 CDN
- ⛔ `pano_url` 为空时含糊说"可以看图" · 提供楼栋级以下信息（房间号、宿舍分配）
- ⛔ Agent 侧编造距离或步行时间

## 当前进度
- [ ] `src/services/map.js` + MCP 2 工具 + `GET /api/map/nodes`
- [ ] `static/welcome.html` 4 区块
- [ ] `static/vendor/leaflet/` `static/vendor/pannellum/`（含各自 LICENSE）
- [ ] `config/map-nodes.json` ≥12 节点覆盖 5 类
- [ ] `pano/manifest.json` + 占位全景图（正式素材后续补）
