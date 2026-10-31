#!/usr/bin/env bash
# ============================================================================
#  北民大小助手 · 一键启动（macOS / Linux，交给评委或服务器用）
#    用法：  bash start.sh            # 默认 3080
#            PORT=8080 bash start.sh # 换端口
#    停止：  Ctrl+C
# ============================================================================
set -e
cd "$(dirname "$0")"
PORT="$(printf '%s' "${PORT:-3080}" | tr -d '[:space:]')"
URL="http://127.0.0.1:${PORT}/"

echo
echo "  ============================================"
echo "   北民大小助手 · 校园服务 Agent（赛道一）"
echo "  ============================================"
echo

# ---- 1) 检查 Node ----
if ! command -v node >/dev/null 2>&1; then
  echo "  [x] 没有找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  exit 1
fi
echo "  [1/4] Node 版本：$(node -v)"

# ---- 2) 依赖 ----
if [ -d node_modules ] && [ -d node_modules/express ]; then
  echo "  [2/4] 依赖已就绪"
else
  echo "  [2/4] 首次运行，安装依赖（npm install）…"
  npm install --no-audit --no-fund
fi

# ---- 3) 演示数据 ----
if [ -f data/beimingda.db ]; then
  echo "  [3/4] 数据库已存在：data/beimingda.db（重置：npm run seed -- --reset）"
else
  echo "  [3/4] 建库并灌入演示数据（npm run seed）…"
  npm run seed
fi

# ---- 4) 起服务 ----
echo "  [4/4] 启动服务：${URL}"
cat <<EOF

  ── 打开这几个地址 ─────────────────────────────────────────
    首页        ${URL}
    接入说明    ${URL}agent
    代取看板    ${URL}takeout
    搭子墙      ${URL}buddy
    导览与街景  ${URL}welcome
    课表        ${URL}schedule
  ──────────────────────────────────────────────────────────
   加 ?demo=1 会显示"演示模式"徽章（数据虚构）
   接口自检：${URL}api/health
   停止服务：Ctrl+C

EOF

exec node src/server.js
