# 分支：feat/frontend

## 本分支做什么
**F0 前端与门户**：共用样式 `static/css/app.css`、共用导航 `static/js/nav.js`、统一 API 封装 `static/js/api.js`、演示模式 `static/js/demo.js`、**门户首页 `static/index.html`**（4 区块，统计走真实 API）、**⭐ 评委核心页 `static/agent.html`**（6 区块，含一键复制 MCP 配置）。

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
- [ ] `static/css/app.css` 按视觉规范（主色 #1F4E8C 等）
- [ ] `static/js/nav.js` 6 页导航 + 移动端底部 tab
- [ ] `static/js/api.js` 统一 fetch 封装解信封
- [ ] `static/js/demo.js` `?demo=1` 徽章与假名替换
- [ ] `static/index.html` 门户 4 区块
- [ ] `static/agent.html` ⭐ 6 区块 + 复制按钮
- [ ] `static/vendor/vue/`（若使用 Vue 3）
