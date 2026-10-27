# pano · 全景素材

**归属分支：`feat/m3-welcome`**

- 每个点位 1 张 360° 等距柱状（equirectangular）全景，导出 `*.jpg` 放本目录，**单张压到 2MB 以内**
- 拍摄：手机横屏、站在点位中心、原地慢速转一圈（或用手机全景模式）；白天光线均匀、避免强反光与逆光
- **不要**把人脸、车牌、门牌号等可识别信息拍进画面；拍进去的要打码
- `manifest.json` 里的 `scenes.<id>` 与 `config/map-nodes.json` 的 `id` 一一对应
- 场景互跳靠 `hotSpots` 里的 `{ "type": "scene", "sceneId": "xxx" }`
- **没有实景的点位**：`map-nodes.json` 里 `pano_url` 留 `null`，前端如实显示"该点暂无实景"，不许糊弄

> ⚠️ 提交前检查本目录总体积：全套素材建议 ≤20MB。超过 50MB 就别直接塞进 git，改用外部云盘 + 下载脚本。
