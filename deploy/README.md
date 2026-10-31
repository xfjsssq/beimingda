# deploy/ · 部署与运维三件套

> **项目**：北民大小助手（beimingda）｜仓库 `https://github.com/xfjsssq/beimingda`
> **本目录只放服务器侧配置与脚本**；业务代码在 `src/`、`static/`，运维手册在仓库根 `部署与运维.md`。
> ⛔ **本目录不含任何密钥**：`DEMO_TOKEN`、高德 key 一律只写在服务器上的 `~/beimingda/.env`（已被 `.gitignore` 忽略）。

| 文件 | 作用 | 装到哪 |
|---|---|---|
| `beimingda.service` | systemd 单元：开机自启、崩溃自愈、日志进 journald、权限收窄 | `/etc/systemd/system/beimingda.service` |
| `nginx-demo.conf` | nginx 反向代理片段：`:80 → 127.0.0.1:3000`、`/mcp` 与 `/api/` 关缓冲、静态缓存 | `/etc/nginx/sites-available/beimingda.conf` |
| `backup-sqlite.sh` | SQLite **在线备份**（`sqlite3 .backup` / better-sqlite3 回退）+ tar.gz + 保留 7 天 | 留在仓库里，由 cron 调用 |

---

## 0. 服务器事实（2026-10-31 由服务器侧确认，按这个写）

| 项 | 值 |
|---|---|
| 容器 | **无 Docker**（本目录也不使用 Docker） |
| Node | **v22.22.2**（`engines` 要求 ≥20） |
| init | **systemd 255**，`/etc/systemd/system/` 可写；`beimingda.service` 已在跑（`Restart=always` / `RestartSec=5`） |
| 资源 | 2 vCPU / 7.4 GB 内存 / 27 GB 磁盘可用 |
| 对外链路 | **Cloudflare Tunnel → nginx :80 → 127.0.0.1:3000** → `https://demo.knowingly.dpdns.org` |
| TLS | Cloudflare 边缘签发（源站 nginx 不需要证书）；**CF 免费版 100 秒硬超时** |
| 应用目录 | `/home/agentuser/beimingda`（运行用户 `agentuser`） |
| 数据库 | `/home/agentuser/beimingda/data/beimingda.db`（SQLite + **WAL**） |
| 日志 | 应用 → journald；nginx → 自身 logrotate |
| 备份 | 每天 03:20 由 cron 调用 `deploy/backup-sqlite.sh`，保留 7 天 |
| 发布方式 | `git pull`（走 gh-proxy 镜像）→ `npm install` → （涉及 fixtures 时）`npm run seed` → `systemctl restart beimingda` |
| MCP | `POST https://demo.knowingly.dpdns.org/mcp`，`Authorization: Bearer <DEMO_TOKEN>` |

---

## 1. systemd 单元

```bash
sudo cp deploy/beimingda.service /etc/systemd/system/beimingda.service
# ⚠️ 先确认 ExecStart 里的 node 路径与本机一致（nvm/volta 装的 node 不在 /usr/bin/node）
command -v node                 # 例：/usr/bin/node
sudo systemctl daemon-reload
sudo systemctl enable --now beimingda
```

**验收（三条都要看）**

```bash
systemctl status beimingda --no-pager        # 期望 active (running)，且是 enabled
systemctl show beimingda -p WorkingDirectory -p Environment -p Restart -p RestartSec -p NoNewPrivileges
journalctl -u beimingda -n 30 --no-pager     # 期望看到 listening / db / MCP endpoint 那几行
curl -fsS --max-time 5 http://127.0.0.1:3000/api/health
```

`/api/health` 的正常响应（字段形状）：

```json
{"ok":true,"data":{"version":"0.1.0","time":"…ISO…","uptime_s":123,"mcp":"/mcp"},"error":null}
```

**注意点**

- 单元里 `ReadWritePaths=/home/agentuser/beimingda/data` 必须与 `.env` 的 `DB_PATH` **指向同一目录**，
  否则日志会报 `SQLITE_CANTOPEN`（Playbook 见 `部署与运维.md` §9）。
- **改完 `src/**` 或 `static/**` 必须 `systemctl restart beimingda`**：生产模式没有热重载
  （`npm run dev` 才有 `node --watch`）。仓库里已经踩过一次"改了代码没重启 → 接口报 X is not defined"的坑。
- `NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome=read-only` 都开着；
  **不要**加 `MemoryDenyWriteExecute=true`（V8 JIT 需要可写可执行内存，会让进程启动即崩）。

---

## 2. nginx 反向代理

```bash
sudo cp deploy/nginx-demo.conf /etc/nginx/sites-available/beimingda.conf
sudo ln -sf /etc/nginx/sites-available/beimingda.conf /etc/nginx/sites-enabled/beimingda.conf
sudo nginx -t
sudo systemctl reload nginx
```

**验收**

```bash
# 1) 源站直连（绕过 CF）：应回同一个信封
curl -fsS --max-time 5 -H 'Host: demo.knowingly.dpdns.org' http://127.0.0.1/api/health

# 2) MCP 鉴权仍然生效（没令牌必须 401）
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 -X POST \
  -H 'Host: demo.knowingly.dpdns.org' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1/mcp     # 期望 401

# 3) 带令牌能列工具（15 个）
curl -fsS --max-time 10 -X POST -H 'Host: demo.knowingly.dpdns.org' \
  -H 'Authorization: Bearer <DEMO_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1/mcp | head -c 300
```

**为什么 `/mcp` 与 `/api/` 关缓冲**：这两处是"请求-响应 + 现算 JSON"，
开着缓冲只会推迟响应、且不利于 401/429 错误体及时返回；同时 `proxy_read_timeout 90s`
与 Cloudflare 的 100 秒硬超时留了 10 秒余量（本项目**不用 SSE**，所以没有长连接要保活）。

**真实访客 IP（重要）**：`rate limit` 是按 `X-Forwarded-For` 的**第一段**算的
（`src/middleware/ratelimit.js::clientIp`）。链路上 cloudflared 在本机连 nginx，
所以配置里用 `set_real_ip_from 127.0.0.1; real_ip_header CF-Connecting-IP;` 把 `$remote_addr`
换成真实访客 IP。**不配这段**也能跑，但限频会退化成"所有访客共用一个桶"（写接口全局 60 次/分钟）。

---

## 3. 备份与恢复

### 3.1 装 cron

```bash
mkdir -p /home/agentuser/backups/beimingda
chmod 700 /home/agentuser/backups/beimingda
crontab -e        # 以 agentuser 身份，加这一行：
```

```cron
20 3 * * * /usr/bin/flock -n /tmp/beimingda-backup.lock /bin/bash /home/agentuser/beimingda/deploy/backup-sqlite.sh >> /home/agentuser/backups/beimingda/cron.log 2>&1
```

说明：`flock -n` 保证同一时刻只有一个备份在跑；输出重定向到 `cron.log`，
避免 cron 每次发系统邮件；`chmod 700` 是因为备份里含用户内容。

### 3.2 手工跑一次并验收

```bash
bash /home/agentuser/beimingda/deploy/backup-sqlite.sh --check   # 只看工具链与路径，不备份
bash /home/agentuser/beimingda/deploy/backup-sqlite.sh           # 真备份
ls -lh /home/agentuser/backups/beimingda/                        # 期望出现 beimingda-<时间戳>.db.tar.gz
tar -tzf /home/agentuser/backups/beimingda/beimingda-*.db.tar.gz # 期望里面就一个 beimingda-<时间戳>.db
```

脚本每步都会打印：解析出的库路径 → 工具链（sqlite3 / node / tar）→ 备份方式 →
`integrity_check` 结果（**必须是 `ok`**）→ 归档路径与大小 → 轮转删了几个 → 现有归档列表。

### 3.3 恢复步骤（**先停服务再覆盖**）

```bash
# ① 选一份要恢复的归档
ls -lt /home/agentuser/backups/beimingda/ | head
ARCHIVE=/home/agentuser/backups/beimingda/beimingda-YYYYmmdd-HHMMSS.db.tar.gz

# ② 停服务：不停会边恢复边被写，且旧 WAL 会和新库对不上
sudo systemctl stop beimingda

# ③ 先把"现在这份"留证（别急着删，恢复失败还能回去）
sudo -u agentuser tar -czf /tmp/broken-$(date +%s).tar.gz \
  -C /home/agentuser/beimingda/data . 2>/dev/null || true

# ④ 解包 + 校验
mkdir -p /tmp/restore && rm -f /tmp/restore/*
tar -xzf "$ARCHIVE" -C /tmp/restore
SNAP=$(ls /tmp/restore/beimingda-*.db | head -1)
sqlite3 "$SNAP" 'PRAGMA integrity_check;'        # 期望 ok；不是 ok 就换一份归档

# ⑤ 覆盖库文件，并清掉旧的 -wal / -shm（只覆盖 .db 而留着旧 WAL 会让 SQLite 报错/读到脏页）
sudo install -o agentuser -g agentuser -m 600 "$SNAP" /home/agentuser/beimingda/data/beimingda.db
sudo rm -f /home/agentuser/beimingda/data/beimingda.db-wal \
           /home/agentuser/beimingda/data/beimingda.db-shm

# ⑥ 起服务并验收
sudo systemctl start beimingda
curl -fsS --max-time 5 https://demo.knowingly.dpdns.org/api/health
curl -fsS --max-time 5 https://demo.knowingly.dpdns.org/api/map/summary   # 期望 total=12
```

**为什么不用 `cp` 备库**：库是 WAL 模式，热 `cp` 到的副本可能缺最近事务、甚至撕裂；
脚本用的是 SQLite 官方**在线备份 API**，不用停服务也能拿到一致性快照。

---

## 4. 常见故障速查

| 现象 | 先看什么 |
|---|---|
| `systemctl status` 显示 `203/EXEC` | 单元里的 `/usr/bin/node` 路径不对 → 改成 `command -v node` |
| 日志 `SQLITE_CANTOPEN` | `DB_PATH` 与 `ReadWritePaths` 不在同一目录；或目录属主不是 `agentuser` |
| 外网 502，本机 `curl 127.0.0.1:3000` 正常 | nginx 没 reload / `proxy_pass` 端口与 `PORT` 不一致 / tunnel 侧没指向 nginx |
| 页面能开但发帖、发布任务失败 | 服务器 `.env` 缺 `DEMO_TOKEN`（写接口一律 401），页面会提示"服务端未配置写入权限" |
| 大面积 429 | 有人刷接口；读限频默认 240/分钟、写 60/分钟、MCP 工具 30/分钟。确认 `real_ip` 生效（否则所有人共用一个桶） |
| 接口报 `X is not defined`（改了代码之后） | **改了 `src/**` 没重启**：`systemctl restart beimingda` |
| MCP 请求 100 秒被掐 | 走到 CF 硬上限了：本项目设计为单次 <90 秒、无 SSE；查是否有长耗时工具调用 |

---

## 5. 回滚

- **应用回滚**：`git checkout <上一个 commit>` → `systemctl restart beimingda`（数据文件不动）。
- **配置回滚**：单元与 nginx 片段都是"整文件替换"，改之前 `cp xxx xxx.bak-$(date +%s)` 即可回退。
- **数据回滚**：见 §3.3（**必须停服务**）。
