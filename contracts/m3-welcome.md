# 契约 · M3 迎新导览模块（卫星图 + 全景实景）

**依赖：** `contracts/core.md`
**对应表：** `map_nodes`
**特点：** 本模块**以纯前端为主**，后端只提供节点查询。**最适合单独开一个对话做**。

---

## 1. 技术方案

| 部分 | 选型 | 说明 |
|---|---|---|
| 底图 | **静态截图底图**（手机地图 App 截图）+ 点位百分比坐标 | 见下方「底图方案」；⛔ 不使用境外地图服务 |
| 全景实景 | **Pannellum**（本地化到 `static/vendor/pannellum/`） | MIT，纯前端 multi-scene tour |
| 素材 | 手机拍摄等距柱状全景图 | 无需专业设备；补图 SOP 见 `pano/HOWTO-补全景.md` |

### 底图方案（2026-10-27 修订 · 截图版）

**背景**：原设计为「Leaflet + 天地图影像瓦片」。本项目为**演示性质**，
申请天地图 tk 的收益不足以抵消其不确定性，故改为**截图底图**：
零申请、零外部依赖、断网可跑，且不需要引入 Leaflet。

```
底图文件：static/map/campus-map.jpg      （手机地图 App 截图，建议宽 1200~2000px、≤500KB）
坐标配置：static/map/map-bg.json
          { "image": "/map/campus-map.jpg",
            "points": { "dorm-12": { "x_pct": 62, "y_pct": 56 }, ... } }
```

- `x_pct` / `y_pct` 是点位在底图上的**百分比坐标**（左上角 `0,0` → 右下角 `100,100`）
- 换底图只需改 `image` 一行；微调点位只需改 `points`（刷新页面即生效，**不用重启服务**）
- 页面**必须可见底图来源标注**：如「底图为手机地图截图（示意，非在线地图服务）」
- `map_nodes.lat/lng` 在此方案下不参与渲染（保留字段以便将来切回瓦片地图）

> 若以后要换回在线瓦片：`/config.js` 注入点（`window.__TILE_KEY__`）仍在，
> 只需把 `static/map/map-bg.json` 的 `image` 换成瓦片层并引入 Leaflet 即可，数据库与接口都不用动。
> 截至本修订，`TILE_PROVIDER_KEY` **不再被使用**。

### 联网增强：高德卫星图（可选，2026-10-27 追加）

截图底图是**离线兜底**（路演断网也能演示）；在联网且配置了高德 key 时，页面额外提供「高德卫星图」切换，
**可拖动缩放，并把我们自己的点位画在上面**（点圆点 → 详情面板 → 可进 360°）。

| 项 | 约定 |
|---|---|
| key | `AMAP_JS_KEY`（高德 **Web端(JS API)** 类型），由 `/config.js` 注入 `window.__AMAP_KEY__`，⛔ 页面不硬编码 |
| 安全密钥 | 可选（`AMAP_SECURITY_CODE`）；本项目实测**不需要**，留空即可 |
| 域名白名单 | 填 **`knowingly.dpdns.org`**；演示域名 `demo.knowingly.dpdns.org` 作为其**子域**已实测通过（⛔ 高德不接受把 4 段域名或 IP 直接填进白名单） |
| 点位坐标 | 用 `map_nodes.lat/lng`，**高德 GCJ-02** 坐标系；⛔ 不要填 GPS 的 WGS-84（会偏几十到几百米） |
| 坐标缺失 | `lat/lng` 为 0 的节点**不画**，页面提示"点位坐标待录入"，⛔ 绝不猜位置 |
| 取点工具 | `/tools/pick.html`（开发用工具页，**不属于交付的 6 个页面**） |
| 降级 | 无 key / SDK 加载失败 / 超时 / 缺 SDK 地址配置 → **自动留在截图底图**并给出可操作提示，页面不白屏 |
| 合规 | key 仅用于**赛事演示与测试**，未购买商业技术服务许可（材料里如实标注） |

---

## 2. 数据模型：map_nodes

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT | 主键 |
| label | TEXT | 节点名，如 `"12号宿舍楼"` |
| category | TEXT | `dorm` / `canteen` / `teaching` / `gate` / `service` |
| lat / lng | REAL | 经纬度 |
| pano_url | TEXT | 全景图相对路径，**可为 null（表示该点无实景）** |
| pano_yaw | REAL | 全景初始朝向 |
| desc | TEXT | 简要描述（周边有什么） |
| sort | INTEGER | 显示顺序 |

### config/map-nodes.json 结构
```json
{
  "nodes": [
    {
      "id": "dorm-12",
      "label": "12号宿舍楼",
      "category": "dorm",
      "lat": 38.4960,
      "lng": 106.0680,
      "pano_url": "/pano/dorm-12.jpg",
      "pano_yaw": 180,
      "desc": "位于校园东侧，紧邻第二食堂，楼下有快递驿站。",
      "sort": 10
    }
  ]
}
```
`npm run seed` 时把该 JSON 灌进 `map_nodes` 表。

> ⚠️ 截图底图方案下，**点位在底图上的位置不放这里**，而是放 `static/map/map-bg.json` 的 `points`（按节点 `id` 关联）。
> 这样换底图/调坐标完全不用动数据库，也不用重新 seed。
> 另：`label` 是**楼栋规范名**，M1 的 `from_building` / `to_building` 必须与它**字面一致**（否则撮合的可达性恒为 0 分）。

---

## 3. 全景 tour 结构（Pannellum multi-scene）

`pano/manifest.json`：
```json
{
  "default": { "firstScene": "dorm-12", "sceneFadeDuration": 800 },
  "scenes": {
    "dorm-12": {
      "title": "12号宿舍楼",
      "type": "equirectangular",
      "panorama": "/pano/dorm-12.jpg",
      "yaw": 180,
      "hotSpots": [
        { "pitch": -5, "yaw": 90, "type": "scene", "text": "去往食堂", "sceneId": "canteen-2" }
      ]
    }
  }
}
```

**关键点**：`hotSpots` 里的 `type: "scene"` 让多个全景节点互相连通，
这就是"点击节点跳实景"的基础。整个 tour 是**纯静态 JSON + 图片**，无需后端参与。

### 拍摄要求（写给负责拍的人）
- 手机横屏、站在点位中心、原地慢速转一圈（或直接用手机全景模式）
- 尽量在**白天光线均匀**时拍，避免强反光与逆光
- 每个点位 1 张 360° 全景即可，导出为 `*jpg` 放 `pano/`，**单张压到 2MB 以内**
- 无实景的点位把 `pano_url` 留 `null`，前端**如实显示"该点暂无实景"**，不要糊弄

---

## 4. MCP 工具（本模块 2 个）

### 4.1 `map_list_nodes`
```json
{
  "name": "map_list_nodes",
  "inputSchema": {
    "type": "object",
    "properties": {
      "category": { "type": "string", "enum": ["dorm","canteen","teaching","gate","service"] }
    },
    "additionalProperties": false
  }
}
```
返回 `{nodes:[{id,label,category,lat,lng,pano_url,desc}]}`

### 4.2 `map_get_node`
```json
{
  "name": "map_get_node",
  "inputSchema": {
    "type": "object",
    "properties": { "node_id": { "type": "string" } },
    "required": ["node_id"],
    "additionalProperties": false
  }
}
```
返回 `{label, lat, lng, pano_url, pano_yaw, desc}`；节点不存在 → `NOT_FOUND`。

---

## 5. HTTP API

```
GET /api/map/nodes?category=   → MapNode[]
```

---

## 6. 页面要素（`static/welcome.html`）

**区块一 · 底图与点位**：按 `static/map/map-bg.json` 的 `image` 铺底图（截图），
`map_nodes` 按 `points` 的百分比坐标打点并以分类颜色区分；支持按 category 筛选。
**页面必须可见底图来源标注**（如"底图为手机地图截图（示意，非在线地图服务）"）。

**区块二 · 节点详情**：点击任一节点 → 侧栏/弹层显示：楼栋名、位置描述、周边有什么。
若 `pano_url` 非空，显示「查看 360° 实景」按钮；为空则显示"该点暂无实景"。

**区块三 · 全景查看器**：进入后全屏 Pannellum，支持拖拽环视、场景间跳转（hotSpot）。

**区块四 · 引导语**：面向新生，一句话说明"点击地图上的标记，可以先看看那里长什么样"。

---

## 7. 本模块禁止事项

- ⛔ 使用境外地图服务 / 底图不标注来源 / 用非本校图片冒充实景
- ⛔ 提供楼栋级以下的信息（房间号、宿舍分配、个人住宿信息）
- ⛔ `pano_url` 为空时含糊地说"可以看图"
- ⛔ 硬编码任何密钥（含已停用的 `TILE_PROVIDER_KEY`）
- ⛔ Agent 侧编造距离或步行时间（只能返回节点数据）

---

## 8. 完成标准（自测清单）

- [ ] 底图正常显示（`static/map/map-bg.json` 指向的图，无 404），页面可见**底图来源标注**
- [ ] `map_nodes` 全部节点在图上正确落点（百分比坐标与底图对得上）
- [ ] 点击有实景的节点能进入 360° 并可拖拽环视
- [ ] 全景场景间 hotSpot 跳转可用
- [ ] `pano_url` 为 null 的节点显示"该点暂无实景"
- [ ] `map_get_node` 传不存在的 id 返回 `NOT_FOUND`
- [ ] 换底图只需改 `static/map/map-bg.json` 的 `image` 一处（改完刷新即生效）
- [ ] 移动端（手机浏览器）也能正常操作底图与全景（拖拽 / 触摸）
