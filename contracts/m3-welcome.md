# 契约 · M3 迎新导览模块（卫星图 + 全景实景）

**依赖：** `contracts/core.md`
**对应表：** `map_nodes`
**特点：** 本模块**以纯前端为主**，后端只提供节点查询。**最适合单独开一个对话做**。

---

## 1. 技术方案

| 部分 | 选型 | 说明 |
|---|---|---|
| 卫星底图 | **Leaflet** + **天地图** 影像瓦片 | 官方合规通道，**不自建底图** |
| 全景实景 | **Pannellum** | MIT，纯前端 multi-scene tour |
| 素材 | 手机拍摄等距柱状全景图 | 无需专业设备 |

### 天地图瓦片 URL（影像底图）
```
https://t{0-7}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0
  &LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles
  &TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={TILE_PROVIDER_KEY}
```
`TILE_PROVIDER_KEY` **从环境变量 / 前端配置读，不硬编码**，并在页面上标注"地图服务由天地图提供"。

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

**区块一 · 卫星地图**：Leaflet 铺满，天地图影像底图，`map_nodes` 以分类图标标注，
**地图上标注"地图服务由天地图提供"**。

**区块二 · 节点详情**：点击任一节点 → 侧栏/弹层显示：楼栋名、位置描述、周边有什么。
若 `pano_url` 非空，显示「查看 360° 实景」按钮；为空则显示"该点暂无实景"。

**区块三 · 全景查看器**：进入后全屏 Pannellum，支持拖拽环视、场景间跳转（hotSpot）。

**区块四 · 引导语**：面向新生，一句话说明"点击地图上的标记，可以先看看那里长什么样"。

---

## 7. 本模块禁止事项

- ⛔ 自建底图 / 使用未授权地图数据源 / 使用境外地图服务
- ⛔ 提供楼栋级以下的信息（房间号、宿舍分配、个人住宿信息）
- ⛔ `pano_url` 为空时含糊地说"可以看图"
- ⛔ 硬编码 `TILE_PROVIDER_KEY`
- ⛔ Agent 侧编造距离或步行时间（只能返回节点数据）

---

## 8. 完成标准（自测清单）

- [ ] 卫星地图能加载天地图影像瓦片，无 403/401
- [ ] `map_nodes` 全部节点在图上正确落点
- [ ] 点击有实景的节点能进入 360° 并可拖拽环视
- [ ] 全景场景间 hotSpot 跳转可用
- [ ] `pano_url` 为 null 的节点显示"该点暂无实景"
- [ ] `map_get_node` 传不存在的 id 返回 `NOT_FOUND`
- [ ] 页面可见"地图服务由天地图提供"字样
- [ ] 移动端（手机浏览器）也能正常拖动地图与全景
