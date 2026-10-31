#!/usr/bin/env bash
# ============================================================================
#  北民大小助手 · SQLite 在线备份 + 轮转（每天 cron 跑一次，保留 7 天）
# ----------------------------------------------------------------------------
#  为什么用在线备份（而不是 cp）：
#    库是 WAL 模式（src/db/index.js 里 journal_mode = WAL），
#    直接 cp 一个正在写的 .db，大概率拿到"缺最近事务"甚至撕裂的副本，
#    而且还会漏掉 -wal 里尚未 checkpoint 的改动。
#    `sqlite3 .backup` / better-sqlite3 的 backup() 走的是 SQLite 官方在线备份 API：
#    **不用停服务**、拿到的是一致性快照、自动合并 WAL。
#
#  用法：
#    bash deploy/backup-sqlite.sh                    # 按默认路径备份
#    APP_DIR=/srv/beimingda DB_PATH=/srv/beimingda/data/beimingda.db \
#      BACKUP_DIR=/srv/backups/beimingda KEEP_DAYS=14 bash deploy/backup-sqlite.sh
#    bash deploy/backup-sqlite.sh --check            # 只检查工具链与路径，不备份
#
#  crontab（服务器 agentuser 用户，每天 03:20；输出进日志文件，别让 cron 发邮件）：
#    20 3 * * * /usr/bin/flock -n /tmp/beimingda-backup.lock \
#      /bin/bash /home/agentuser/beimingda/deploy/backup-sqlite.sh \
#      >> /home/agentuser/backups/beimingda/cron.log 2>&1
#
#  退出码：0 成功 / 2 库文件不存在 / 3 备份失败 / 4 备份校验失败 / 5 归档失败
# ============================================================================
set -euo pipefail
umask 077   # 备份里有用户内容，目录与文件默认只给属主

APP_DIR="${APP_DIR:-/home/agentuser/beimingda}"
BACKUP_DIR="${BACKUP_DIR:-/home/agentuser/backups/beimingda}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DB_PATH_ENV="${DB_PATH:-}"          # 允许外部直接指定
CHECK_ONLY=0
# 用 if 而不是 `[ x = y ] && CHECK_ONLY=1`：AND-OR 列表在条件不成立时返回非 0，
# 这种"返回值泄漏"在函数末尾/被 set -e 包裹的调用点容易误伤，写成 if 最稳。
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
fi

log() { printf '%s  %s\n' "$(date '+%F %T')" "$*"; }

# ---- 1) 解析数据库路径：DB_PATH 环境变量 > .env 里的 DB_PATH > 默认 ----
resolve_db() {
  local p="$DB_PATH_ENV"
  if [ -z "$p" ] && [ -f "$APP_DIR/.env" ]; then
    # 和应用里的 loadDotEnv 一样：只取 `KEY=value`，去掉引号与行尾 ` # 注释`
    p="$(sed -n 's/^[[:space:]]*DB_PATH[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" | tail -n 1)"
    p="${p%\"}"; p="${p#\"}"; p="${p%\'}"; p="${p#\'}"
    p="$(printf '%s' "$p" | sed 's/[[:space:]]\+#.*$//' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  fi
  [ -z "$p" ] && p="./data/beimingda.db"
  case "$p" in
    /*) printf '%s' "$p" ;;                       # 绝对路径
    *)  printf '%s/%s' "$APP_DIR" "${p#./}" ;;    # 相对 WorkingDirectory
  esac
}

DB_FILE="$(resolve_db)"
STAMP="$(date '+%Y%m%d-%H%M%S')"
# 快照文件名会**原样进 tar 包**（恢复时好认），所以就叫 beimingda-<时间戳>.db；
# 失败时靠 trap 删掉，SIGKILL 留下的残件由第 7 步的轮转顺手清掉。
TMP_DB="$BACKUP_DIR/beimingda-$STAMP.db"
ARCHIVE="$BACKUP_DIR/beimingda-$STAMP.db.tar.gz"

log "== beimingda 备份开始 =="
log "APP_DIR   = $APP_DIR"
log "DB_FILE   = $DB_FILE"
log "BACKUP_DIR= $BACKUP_DIR (保留 $KEEP_DAYS 天)"

# ---- 2) 工具链检查 ----
# 同样用 if 而非 `command -v x && X=1`：后者在 x 不存在时返回非 0，容易把状态泄漏给 set -e 的调用点
HAVE_SQLITE3=0
if command -v sqlite3 >/dev/null 2>&1; then HAVE_SQLITE3=1; fi
HAVE_NODE=0
if command -v node >/dev/null 2>&1; then HAVE_NODE=1; fi
HAVE_TAR=0
if command -v tar >/dev/null 2>&1; then HAVE_TAR=1; fi

log "工具链：sqlite3=$([ $HAVE_SQLITE3 = 1 ] && echo 有 || echo 无) node=$([ $HAVE_NODE = 1 ] && echo 有 || echo 无) tar=$([ $HAVE_TAR = 1 ] && echo 有 || echo 无)"
if [ $HAVE_SQLITE3 = 0 ] && [ $HAVE_NODE = 0 ]; then
  log "!! 既没有 sqlite3 也没有 node，无法做在线备份。装一个：apt-get install -y sqlite3"
  exit 3
fi
if [ $HAVE_TAR = 0 ]; then
  log "!! 没有 tar，无法归档。装一个：apt-get install -y tar"
  exit 5
fi

if [ $CHECK_ONLY = 1 ]; then
  [ -f "$DB_FILE" ] && log "--check：库文件存在 ✅" || log "--check：库文件不存在 ⚠️"
  log "--check 完成（未做备份）"
  exit 0
fi

# ---- 3) 前置检查 ----
if [ ! -f "$DB_FILE" ]; then
  log "!! 找不到数据库文件：$DB_FILE"
  log "   检查顺序：.env 的 DB_PATH → systemd 的 WorkingDirectory → 文件权限（要能读）"
  exit 2
fi
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

# ---- 4) 在线备份（优先 sqlite3；没有就用仓库自带的 better-sqlite3）----
cleanup() { rm -f "$TMP_DB" 2>/dev/null || true; }
trap cleanup EXIT

if [ $HAVE_SQLITE3 = 1 ]; then
  log "方式：sqlite3 .backup（SQLite 官方在线备份 API）"
  # 注意：.backup 的参数是 SQL 字符串里的文件名，路径里的单引号要转义
  if ! sqlite3 "$DB_FILE" ".backup '${TMP_DB//\'/\'\'}'"; then
    log "!! sqlite3 .backup 失败（库被删？权限？磁盘满？）"
    exit 3
  fi
else
  # 没有 sqlite3 CLI 时用后端自己依赖的 better-sqlite3：不额外装包，且同样是在线备份 API
  log "方式：node + better-sqlite3 backup()（未安装 sqlite3 CLI）"
  if [ $HAVE_NODE = 0 ]; then log "!! 没有 node，无法回退"; exit 3; fi
  if [ ! -d "$APP_DIR/node_modules/better-sqlite3" ]; then
    log "!! $APP_DIR/node_modules/better-sqlite3 不存在（先 npm install，或用 APP_DIR 指定仓库路径）"
    exit 3
  fi
  # node -e 的参数从 argv[1] 开始：argv[1]=APP_DIR argv[2]=源库 argv[3]=目标
  if ! node -e '
    const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[2], { readonly: true });
    db.backup(process.argv[3])
      .then(() => { db.close(); })
      .catch((e) => { console.error("backup failed: " + e.message); process.exit(1); });
  ' "$APP_DIR" "$DB_FILE" "$TMP_DB"; then
    log "!! better-sqlite3 backup() 失败"
    exit 3
  fi
fi

if [ ! -s "$TMP_DB" ]; then
  log "!! 备份文件为空：$TMP_DB"
  exit 3
fi

# ---- 5) 校验：拿备份副本自己的 integrity_check，别只看"文件存在" ----
if [ $HAVE_SQLITE3 = 1 ]; then
  RESULT="$(sqlite3 "$TMP_DB" 'PRAGMA integrity_check;' || true)"
else
  RESULT="$(node -e '
    const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[2], { readonly: true });
    process.stdout.write(String(db.pragma("integrity_check", { simple: true })));
    db.close();
  ' "$APP_DIR" "$TMP_DB" || true)"
fi
log "integrity_check = ${RESULT:-<空>}"
if [ "$RESULT" != "ok" ]; then
  log "!! 备份副本校验未通过，已丢弃（源库没被改动）"
  exit 4
fi

# ---- 6) 归档 ----
if ! tar -czf "$ARCHIVE" -C "$BACKUP_DIR" "$(basename "$TMP_DB")"; then
  log "!! tar 归档失败"
  exit 5
fi
rm -f "$TMP_DB"
trap - EXIT

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
log "已生成：$ARCHIVE（$SIZE）"

# ---- 7) 轮转：只保留最近 KEEP_DAYS 天 ----
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'beimingda-*.db.tar.gz' -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')"
# 顺手清掉异常中断（SIGKILL / 断电）留下的半成品快照：超过 1 天的裸 .db 一定不是正经备份
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'beimingda-*.db' -mtime +1 -delete 2>/dev/null || true
log "轮转：删除 $DELETED 个超过 $KEEP_DAYS 天的归档"
log "现有归档："
ls -1t "$BACKUP_DIR"/beimingda-*.db.tar.gz 2>/dev/null | head -n 10 | sed 's/^/    /' || true
log "== 备份完成 =="
