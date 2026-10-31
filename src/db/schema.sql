-- 北民大小助手 · 数据库表结构（冻版）
-- 来源：contracts/core.md §2 —— ⛔ 字段名不得改，改这里必须先提 PR 到 main 并在群里说一声。
-- ⛔ 全站不允许出现可存储真实身份信息的字段（无姓名 / 学号 / 手机号 / 身份证 / 校园网账号）。

PRAGMA foreign_keys = ON;

-- 用户：仅昵称，无任何身份字段
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  contact_code  TEXT,                            -- 历史遗留字段（"中转码"已废弃，不再对外输出）
  pass_hash     TEXT,                            -- scrypt 哈希（⛔ 绝不存明文；匿名用户为空）
  pass_salt     TEXT,
  created_at    INTEGER NOT NULL,
  demo          INTEGER NOT NULL DEFAULT 0
);

-- 代取任务
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  from_building   TEXT NOT NULL,
  to_building     TEXT NOT NULL,
  station         TEXT NOT NULL,
  deadline_ts     INTEGER NOT NULL,
  reward_min      REAL NOT NULL,
  reward_max      REAL NOT NULL,
  note            TEXT,
  screenshot_path TEXT,
  raw_status      TEXT NOT NULL DEFAULT 'open',
  created_at      INTEGER NOT NULL,
  demo            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deadline ON tasks(raw_status, deadline_ts);

-- 跑腿方能力
CREATE TABLE IF NOT EXISTS runners (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id),
  reachable_buildings TEXT NOT NULL,
  reward_floor        REAL NOT NULL,
  time_windows        TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  demo                INTEGER NOT NULL DEFAULT 0
);

-- 撮合记录
CREATE TABLE IF NOT EXISTS matches (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  runner_id  TEXT NOT NULL REFERENCES runners(id),
  score      REAL NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pushed',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_task ON matches(task_id, score DESC);

-- 搭子帖（匿名）
CREATE TABLE IF NOT EXISTS buddy_posts (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  anon_token   TEXT NOT NULL UNIQUE,
  raw_status   TEXT NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL,
  demo         INTEGER NOT NULL DEFAULT 0
);

-- 双选
CREATE TABLE IF NOT EXISTS buddy_consents (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES buddy_posts(id),
  seeker_id  TEXT NOT NULL REFERENCES users(id),
  score      REAL NOT NULL,
  author_ok  INTEGER NOT NULL DEFAULT 0,
  seeker_ok  INTEGER NOT NULL DEFAULT 0,
  revealed   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, seeker_id)
);

-- 日程（只收 6 类匿名字段）
CREATE TABLE IF NOT EXISTS schedule_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  weekday       INTEGER NOT NULL,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  title         TEXT NOT NULL,
  room          TEXT,
  weeks         TEXT,
  remind_before INTEGER,
  created_at    INTEGER NOT NULL,
  demo          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sched_user_weekday ON schedule_items(user_id, weekday, period_start);

-- 地图节点
CREATE TABLE IF NOT EXISTS map_nodes (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  category  TEXT NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  pano_url  TEXT,
  pano_yaw  REAL DEFAULT 0,
  desc      TEXT,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- ★ 脱敏审计：只记字段名，绝不记值
CREATE TABLE IF NOT EXISTS scrub_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type      TEXT NOT NULL,
  dropped_fields TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- ★ 搭子留言 / 回复（站内直接沟通；也可由 MCP 写入）
CREATE TABLE IF NOT EXISTS buddy_messages (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES buddy_posts(id),
  consent_id TEXT REFERENCES buddy_consents(id),
  from_id    TEXT NOT NULL REFERENCES users(id),
  to_id      TEXT REFERENCES users(id),
  kind       TEXT NOT NULL DEFAULT 'message',   -- message=留言 / reply=回复
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buddy_msg_post ON buddy_messages(post_id, created_at);

-- 匿名会话（2026-10-31）：让站点"活起来"——每个浏览器一份身份，发的内容彼此可见
--   ⛔ 只存 token 的 sha256；不存姓名/学号/手机号/IP，表里没有任何身份信息字段
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 私聊（2026-10-31）：**双方都同意之后**才有会话；有服务器直连，不再用"中转码"那套
--   kind='task'  → ref_id 是 tasks.id（发布者 ↔ 接单者，matches.state='accepted' 才建）
--   kind='buddy' → ref_id 是 buddy_posts.id（发布者 ↔ 搭子，buddy_consents.revealed=1 才建）
--   ⛔ 表里没有任何联系方式字段：聊天就在站内，不需要交换手机号/微信号
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  a_uid      TEXT NOT NULL REFERENCES users(id),
  b_uid      TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(kind, ref_id, a_uid, b_uid)
);
CREATE INDEX IF NOT EXISTS idx_threads_a ON threads(a_uid);
CREATE INDEX IF NOT EXISTS idx_threads_b ON threads(b_uid);

CREATE TABLE IF NOT EXISTS thread_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  from_uid   TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'text',      -- text / emoji
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_msg ON thread_messages(thread_id, created_at);
