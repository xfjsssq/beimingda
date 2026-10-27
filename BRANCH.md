# 分支：docs/materials

## 本分支做什么
**参赛材料与最终交付包**：作品说明书、技术方案、演示脚本、合规与隐私说明四份材料 + 源码 ZIP 导出与自检。

## 依赖什么
- `开发文档/README.md`（文档索引）、`contracts/core.md`、`contracts/frontend.md`
- `tasks/G0-GitHub仓库初始化.md`（导出与核对流程）
- M1~M4 分支的最终工具清单（14 个 MCP 工具）与页面截图

## 完成标准
- 四份材料齐全，每份含合规声明
- 无敏感值（`grep -rniE "学号|身份证|1[3-9][0-9]{9}" materials/` 无输出）
- 源码 ZIP 不含 `.env` / `*.db` / `node_modules` / `.git/`
- 工具清单数量与代码一致（14 个；M1 5 / M2 3 / M3 2 / M4 4）

## 不能碰什么
- ⛔ 材料里出现真实姓名 / 学号 / 手机号 / 身份证
- ⛔ 材料里提及校园网认证客户端 / 校外接入通道（ATrust / VPN 一律不出现）
- ⛔ 令牌写真值（一律 `<DEMO_TOKEN>`）
- ⛔ 把大体积视频直接提交进仓库（走外部云盘）

## 当前进度
- [ ] `materials/01-作品说明书.md`
- [ ] `materials/02-技术方案.md`
- [ ] `materials/03-演示脚本.md`
- [ ] `materials/04-合规与隐私说明.md`
- [ ] 功能截图（`?demo=1`，375px + 1440px 各一套）
- [ ] `git archive` 导出源码 ZIP 并核对
