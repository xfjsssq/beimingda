# 北名大小助手 · beimingda

> 把散落的校园服务，收进一个对话。

第一届"银移杯"校园 AI Agent 创新大赛 · **赛道 17 智慧校园 Agent 创意赛道**
队伍 **啊对对**（TM202610160004）｜ 站点 `https://demo.knowingly.dpdns.org` ｜ 提交截止 **2026-10-31 23:59:59**

四个模块：**代取撮合** · **搭子匹配** · **迎新导览** · **日程提醒**。
平台能力通过**远程 Streamable HTTP MCP**（`POST /mcp`，14 个工具）开放给 WorkBuddy，
评委零配置接入即可用一句话操控整个平台。

---

## 快速开始

```bash
git clone https://github.com/xfjsssq/beimingda.git
cd beimingda
npm install                     # 网络慢可加 --registry=https://registry.npmmirror.com
cp .env.example .env            # Windows: copy .env.example .env
# 编辑 .env：至少填 DEMO_TOKEN（写接口与 /mcp 鉴权用）
npm run seed                    # 幂等灌演示数据
npm start                       # http://127.0.0.1:3000
```

自检（一条命令跑完关键验收点）：

```bash
npm run smoke
npm test
```

常用地址：

| 地址 | 说明 |
|---|---|
| `GET /api/health` | 健康检查，返回统一信封 |
| `POST /mcp` | MCP 远程端点（`Authorization: Bearer <DEMO_TOKEN>`） |
| `GET /` `/takeout` `/buddy` `/welcome` `/schedule` `/agent` | 6 个页面 |
| `GET /config.js` | 前端配置注入（`TILE_PROVIDER_KEY` 等，⛔ 页面不许硬编码） |
| `GET /api/scrub/audit?limit=` | ⭐ 脱敏审计，评委核验用（M4） |

---

## 技术栈（冻版，不得更换）

| 层 | 选型 |
|---|---|
| 前端 | 静态 HTML + 原生 JS（Vue 3 可选，须本地化到 `static/vendor/`），**零构建** |
| 地图 | Leaflet + 天地图官方瓦片（不自建底图） |
| 全景 | Pannellum（MIT） |
| 后端 | Node.js 20+ / Express / better-sqlite3 |
| MCP | **远程 Streamable HTTP** `POST /mcp`（⛔ 禁止本地 stdio、禁止 SSE 长连接） |
| 部署 | Cloudflare 隧道 → `https://demo.knowingly.dpdns.org`（单次响应必须 < 90 秒） |

---

## 目录结构

```
beimingda/
├── src/
│   ├── server.js            HTTP 入口与路由注册
│   ├── db/{schema.sql,index.js}
│   ├── engine/              撮合与匹配评分引擎（M1/M2）
│   ├── services/            业务层（HTTP API 与 MCP 共用，⛔ 不许各写一份）
│   ├── mcp/{server.js,tools.js,handlers.js}
│   ├── api/routes.js        HTTP API 路由
│   ├── middleware/{auth.js,ratelimit.js}
│   └── util/{envelope.js,time.js}
├── static/                  6 个页面 + css/js + vendor（离线可跑）
├── config/                  periods.json / map-nodes.json / match-rules.json
├── fixtures/                全虚构演示数据（demo=1）
├── pano/                    全景图与 multi-scene tour 配置
├── scripts/{seed.js,smoke.js,reminder.js}
├── tests/                   node --test 单测
├── docs/                    ARCHITECTURE / DB-SCHEMA / MCP-TOOLS
└── contracts/ tasks/        需求契约与任务卡（与代码同仓冻结）
```

---

## 分支与协作（⭐ 先读再动手）

| 分支 | 负责 | 内容 |
|---|---|---|
| `main` | 共同 | **只接受 PR**，不直接推 |
| `feat/core` | 骨架 A | T0 骨架 + 建表 + HTTP 路由 + MCP 端点 + 鉴权（**已完成**） |
| `feat/m1-takeout` | A | 代取撮合（引擎 + MCP 5 工具 + 页面） |
| `feat/m2-buddy` | B | 搭子匹配（画像 + 双选 + MCP 3 工具 + 页面） |
| `feat/m3-welcome` | B | 迎新导览（地图 + 全景，纯前端为主） |
| `feat/m4-schedule` | A | 日程与提醒（含脱敏审计） |
| `feat/frontend` | B | 门户首页 + `/agent` 页 + 共用样式 |
| `docs/materials` | 共同 | 参赛材料与交付包 |

- 每个分支根部有 `BRANCH.md`：写清**做什么 / 依赖什么 / 完成标准 / 不能碰什么 / 当前进度**
- commit message 规范：`feat(模块): 描述`（例：`feat(m1): 实现撮合评分引擎`）
- **冲突高发区**（改前先在群里说一声）：`contracts/`、`src/db/schema.sql`、`src/mcp/tools.js`、`src/api/routes.js`
- 详细流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 合规红线（全局）

1. 全站**不收集**真实姓名 / 学号 / 手机号 / 身份证 / 学生证照片 / 校园网账号口令；数据库里**没有**能存这些的字段
2. **不接入、不登录、不抓取**学校任何内部系统；业务代码里绝不出现"输入学号 / 校园网密码"
3. 站点**没有「上传课表文件」按钮** —— 刻意设计，课表入口只走对话（MCP）
4. 演示数据一律 `demo=1`，姓名用"同学A/同学B"，学号用 `2025XXXX`，页面加 `?demo=1`
5. 密钥只从 `process.env` 读，`.env` 与 `*.db` 永不入库；参赛材料里令牌一律写 `<DEMO_TOKEN>`

---

## 文档索引

| 你要做的事 | 读这两份 |
|---|---|
| 看仓库全貌 | `docs/ARCHITECTURE.md`、`README.md`（本文件） |
| 动数据库 / HTTP 路由 | `contracts/core.md` |
| 代取撮合 | `contracts/m1-takeout.md` + `tasks/M1-代取撮合.md` |
| 搭子匹配 | `contracts/m2-buddy.md` + `tasks/M2-搭子匹配.md` |
| 迎新导览 | `contracts/m3-welcome.md` + `tasks/M3-迎新导览.md` |
| 日程与提醒 | `contracts/m4-schedule.md` + `tasks/M4-日程提醒.md` |
| 页面与 `/agent` | `contracts/frontend.md` + `tasks/F0-前端总览.md` |
| MCP 工具清单 | `docs/MCP-TOOLS.md` |
| 建仓与协作流程 | `tasks/G0-GitHub仓库初始化.md` + `CONTRIBUTING.md` |

> 提交给评委的源码包：`git archive --format=zip --prefix=beimingda/ HEAD -o 源码.zip`
> （`git archive` 天然不含 `.git`；导出后核对无 `.env` / `*.db` / `node_modules` / `.git/`）

## License

MIT（见 [LICENSE](LICENSE)）。
