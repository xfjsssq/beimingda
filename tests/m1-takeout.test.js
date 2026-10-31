/**
 * M1 代取撮合 · 单测（node:test）
 *
 *   npm test          （与 T0 的 tests/skeleton.test.js 各自独立进程、各自独立临时库）
 *
 * 覆盖 contracts/m1-takeout.md §7 自测清单 8 条：
 *   1) reward_min > reward_max           → SCHEMA_REJECTED
 *   2) 已过期 deadline                    → SCHEMA_REJECTED
 *   3) 不可达 runner 不出现在结果里
 *   4) 同一 runner 5 分钟内不重复推送
 *   5) reason 里的分值相加 === score
 *   6) task_list_open 不返回已过期任务
 *   7) screenshot_path 为 null 时发布仍成功
 *   8) additionalProperties:false 生效：多传字段 → SCHEMA_REJECTED
 * 另含：权重/阈值未被篡改、UPSERT 登记、截图降级不落盘不抽 PII、HTTP 4 条路由、MCP 工具清单。
 *
 * ⛔ 用例只用自己的临时库（os.tmpdir），不碰 data/*.db。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 独立临时库 + 只在测试里用的假令牌
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-m1-test-${process.pid}.db`);
process.env.DEMO_TOKEN = "test-token-1234";
// 确保走规则化降级（不产生任何外部调用）
delete process.env.LLM_BASE_URL;
delete process.env.LLM_API_KEY;
delete process.env.LLM_MODEL;
try {
  fs.unlinkSync(process.env.DB_PATH);
} catch {
  /* 首次运行没有旧库是正常的 */
}

const { initDb, getDb } = await import("../src/db/index.js");
const { normalizeBuildingName, canonicalLabels } = await import("../src/services/buildings.js");
const {
  matchScore,
  parseReasonScores,
  WEIGHTS,
  PUSH_THRESHOLD,
  MAX_PUSH_PER_TASK,
  DEDUPE_WINDOW_SECONDS,
} = await import("../src/engine/match.js");
const {
  publishTask,
  getTask,
  listOpenTasks,
  matchForTask,
  isVisionConfigured,
} = await import("../src/services/task.js");
const { registerRunner, listActiveRunners } = await import("../src/services/runner.js");
const { callTool, listToolSchemas } = await import("../src/mcp/tools.js");
const { reloadHandlers } = await import("../src/mcp/handlers.js");

initDb();
reloadHandlers(); // 把 m1 的 5 个工具装进注册表

const NOW = Math.floor(Date.now() / 1000);
const isoIn = (min) => new Date((NOW + min * 60) * 1000).toISOString();

let handleSeq = 0;
const nextHandle = () => `测试跑腿${++handleSeq}`;

const baseTask = (over = {}) => ({
  from_building: "12号宿舍楼",
  to_building: "15号宿舍楼",
  station: "快递驿站",
  deadline_iso: isoIn(240),
  reward_min: 3,
  reward_max: 5,
  owner_handle: "测试同学",
  ...over,
});

const baseRunner = (over = {}) => ({
  user_handle: nextHandle(),
  reachable_buildings: ["12号宿舍楼", "15号宿舍楼"],
  reward_floor: 2,
  time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(300) }],
  ...over,
});

/** 引擎直接吃 DB 行（{start,end}，Unix 秒） */
const dbRunner = (over = {}) => ({
  id: "engine-runner",
  reachable_buildings: JSON.stringify(["12号宿舍楼", "15号宿舍楼"]),
  reward_floor: 2,
  time_windows: JSON.stringify([{ start: NOW - 30 * 60, end: NOW + 300 * 60 }]),
  active: 1,
  ...over,
});

/** 撮合类用例前先把既有能力登记全部停用，保证候选池就是本用例刚登记的那几个 */
const parkAllRunners = () => getDb().prepare("UPDATE runners SET active = 0").run();

// ---------------------------------------------------------------- 契约冻结项

test("契约冻结：权重 40/30/30、阈值 60、单任务最多推 3、去重 300 秒（配置也被一起校验）", () => {
  assert.deepEqual(WEIGHTS.accessibility, { to_building: 40, from_building: 20 });
  assert.deepEqual(WEIGHTS.time, { full: 30, overlap_ge_50pct: 20, overlap_lt_50pct: 10 });
  assert.equal(WEIGHTS.reward_max_score, 30);
  assert.equal(PUSH_THRESHOLD, 60);
  assert.equal(MAX_PUSH_PER_TASK, 3);
  assert.equal(DEDUPE_WINDOW_SECONDS, 300);

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/match-rules.json"), "utf8")).takeout;
  assert.equal(cfg.accessibility.to_building, 40);
  assert.equal(cfg.accessibility.from_building, 20);
  assert.equal(cfg.time.full, 30);
  assert.equal(cfg.time.overlap_ge_50pct, 20);
  assert.equal(cfg.time.overlap_lt_50pct, 10);
  assert.equal(cfg.reward_max_score, 30);
  assert.equal(cfg.push_threshold, 60);
  assert.equal(cfg.max_push_per_task, 3);
  assert.equal(cfg.dedupe_window_seconds, 300);
});

// ---------------------------------------------------------------- 引擎

test("引擎：三段得分与 reason 分值严格相加等于 score；不可达/不重叠/已过期/关停一律出局", () => {
  const task = {
    from_building: "12号宿舍楼",
    to_building: "15号宿舍楼",
    deadline_ts: NOW + 240 * 60,
    reward_min: 3,
    reward_max: 5,
  };

  // 命中送达楼 40 + 完全覆盖 30 + 报酬打满 30 = 100
  const full = matchScore(task, dbRunner({ reward_floor: 2 }), NOW);
  assert.equal(full.score, 100);
  assert.deepEqual(full.parts, { accessibility: 40, time: 30, reward: 30, total: 100 });

  // 仅命中取件楼 20 + 部分覆盖 50% 20 + 报酬打满 30 = 70
  const fromOnly = matchScore(
    task,
    dbRunner({
      reachable_buildings: JSON.stringify(["12号宿舍楼"]),
      reward_floor: 1,
      time_windows: JSON.stringify([{ start: NOW - 30 * 60, end: NOW + 120 * 60 }]),
    }),
    NOW,
  );
  assert.equal(fromOnly.score, 70);
  assert.match(fromOnly.reason, /仅可达 12号宿舍楼/);

  // 报酬 0 分：下限高于报酬上限 → 40 + 30 + 0 = 70
  const noReward = matchScore(task, dbRunner({ reward_floor: 8 }), NOW);
  assert.equal(noReward.score, 70);
  assert.equal(noReward.parts.reward, 0);

  // 每一个非空结果：reason 里出现的分值相加必须正好等于 score
  for (const got of [full, fromOnly, noReward]) {
    const sum = parseReasonScores(got.reason).reduce((a, b) => a + b, 0);
    assert.equal(sum, got.score, `reason 分值之和 ${sum} != score ${got.score}`);
    assert.deepEqual(
      [got.parts.accessibility, got.parts.time, got.parts.reward],
      parseReasonScores(got.reason),
    );
  }

  // 出局
  assert.equal(matchScore(task, dbRunner({ reachable_buildings: JSON.stringify(["第二食堂"]) }), NOW), null, "不可达必须出局");
  assert.equal(
    matchScore(
      task,
      dbRunner({ time_windows: JSON.stringify([{ start: NOW - 600 * 60, end: NOW - 100 * 60 }]) }),
      NOW,
    ),
    null,
    "时间完全不重叠必须出局",
  );
  assert.equal(matchScore(task, dbRunner({ active: 0 }), NOW), null, "active=0 必须出局");
  assert.equal(matchScore({ ...task, deadline_ts: NOW - 1 }, dbRunner(), NOW), null, "已过期任务必须出局");
});

test("引擎：部分覆盖 < 50% 记 10 分，≥ 50% 记 20 分；reward 分严格 clamp 到 0..30", () => {
  const task = {
    from_building: "12号宿舍楼",
    to_building: "15号宿舍楼",
    deadline_ts: NOW + 240 * 60,
    reward_min: 3,
    reward_max: 5,
  };
  const low = matchScore(task, dbRunner({ time_windows: JSON.stringify([{ start: NOW, end: NOW + 60 * 60 }]) }), NOW);
  assert.equal(low.parts.time, 10);
  const half = matchScore(task, dbRunner({ time_windows: JSON.stringify([{ start: NOW, end: NOW + 120 * 60 }]) }), NOW);
  assert.equal(half.parts.time, 20);

  // reward_max - reward_floor <= 0 → 0 分；超出上限也被 clamp 到 30
  const zero = matchScore(task, dbRunner({ reward_floor: 99 }), NOW);
  assert.equal(zero.parts.reward, 0);
  const cap = matchScore(task, dbRunner({ reward_floor: 0 }), NOW);
  assert.equal(cap.parts.reward, 30);

  // 引擎也容忍 service 入参形态（{start_iso,end_iso}），不会静默变成「无可用时段」
  const isoShaped = matchScore(
    task,
    { reachable_buildings: ["15号宿舍楼"], reward_floor: 2, time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(300) }] },
    NOW,
  );
  assert.equal(isoShaped.score, 100);
});

// ---------------------------------------------------------------- §7 清单

test("§7-1 task_publish：reward_min > reward_max → SCHEMA_REJECTED（MCP 与 service 两层都拦）", async () => {
  const env = await callTool("task_publish", baseTask({ reward_min: 9, reward_max: 5 }));
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "SCHEMA_REJECTED");

  assert.throws(
    () => publishTask(baseTask({ reward_min: 9, reward_max: 5 })),
    (e) => e.code === "SCHEMA_REJECTED",
  );
});

test("§7-2 task_publish：deadline 已过期 → SCHEMA_REJECTED", async () => {
  const env = await callTool("task_publish", baseTask({ deadline_iso: isoIn(-45) }));
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "SCHEMA_REJECTED");
  assert.throws(
    () => publishTask(baseTask({ deadline_iso: isoIn(-1) })),
    (e) => e.code === "SCHEMA_REJECTED",
  );
});

test("§7-3 不可达 / 时间不重叠 / active=0 的 runner 不出现在撮合结果里", () => {
  const { task_id } = publishTask(baseTask());
  parkAllRunners();

  const good = registerRunner(baseRunner({ user_handle: "边界-可达", reward_floor: 2 }));
  registerRunner(baseRunner({ user_handle: "边界-不可达", reachable_buildings: ["第二食堂"] }));
  registerRunner(
    baseRunner({ user_handle: "边界-时间已过", time_windows: [{ start_iso: isoIn(-600), end_iso: isoIn(-100) }] }),
  );
  const off = registerRunner(baseRunner({ user_handle: "边界-已关停" }));
  getDb().prepare("UPDATE runners SET active = 0 WHERE id = ?").run(off.runner_id);

  const result = matchForTask(task_id, { now: NOW, topK: 10 });
  const handles = result.matches.map((m) => m.runner_handle);
  assert.deepEqual(handles, ["边界-可达"]);
  assert.equal(result.matches[0].runner_id, good.runner_id);
  assert.ok(!handles.includes("边界-不可达"));
  assert.ok(!handles.includes("边界-时间已过"));
  assert.ok(!handles.includes("边界-已关停"));
  assert.ok(!listActiveRunners().some((r) => r.handle === "边界-已关停"), "active=0 不该进候选池");

  // 落库只记推送成功的候选
  const rows = getDb().prepare("SELECT COUNT(*) n FROM matches WHERE task_id = ?").get(task_id).n;
  assert.equal(rows, 1);
});

test("§7-4 同一 runner 5 分钟内不重复推送同一任务（matches 不新增），超过窗口后才再推", () => {
  const { task_id } = publishTask(baseTask({ deadline_iso: isoIn(3600) }));
  parkAllRunners();
  registerRunner(baseRunner({ user_handle: "去重-候选", reward_floor: 1 }));
  const count = () => getDb().prepare("SELECT COUNT(*) n FROM matches WHERE task_id = ?").get(task_id).n;

  const first = matchForTask(task_id, { now: NOW });
  assert.equal(first.pushed_count, 1);
  assert.equal(first.skipped_count, 0);
  assert.equal(count(), 1);

  // 10 秒后再点一次：同一 task+runner 不重复推送
  const second = matchForTask(task_id, { now: NOW + 10 });
  assert.equal(second.pushed_count, 0);
  assert.equal(second.skipped_count, 1);
  assert.equal(count(), 1, "5 分钟内不得新增 matches 行");
  assert.equal(second.matches[0].pushed, false);
  assert.match(second.matches[0].skip_reason, /5 分钟内已推送过/);
  assert.ok(second.matches[0].score >= PUSH_THRESHOLD, "跳过去重仍然要能看到 score/reason");

  // 超过 300 秒窗口：允许再次推送
  const third = matchForTask(task_id, { now: NOW + DEDUPE_WINDOW_SECONDS + 1 });
  assert.equal(third.pushed_count, 1);
  assert.equal(count(), 2);
});

test("§7-5 撮合返回的每条 reason，分值相加 === score（真实落库路径）", () => {
  const { task_id } = publishTask(baseTask());
  parkAllRunners();
  for (const floor of [0, 1, 2, 3, 5, 8]) {
    registerRunner(baseRunner({ reward_floor: floor }));
  }
  const result = matchForTask(task_id, { now: NOW, topK: 10 });
  assert.ok(result.matches.length >= 3, `应有多名候选，实际 ${result.matches.length}`);
  for (const m of result.matches) {
    assert.ok(m.score >= PUSH_THRESHOLD, `低于阈值的候选不该返回：${m.runner_handle} ${m.score}`);
    assert.equal(parseReasonScores(m.reason).reduce((a, b) => a + b, 0), m.score, m.reason);
  }
  // 单任务最多同时推 3 名
  assert.equal(result.pushed_count, MAX_PUSH_PER_TASK);
  assert.ok(result.matches.some((m) => m.skip_reason && /上限/.test(m.skip_reason)));
});

test("§7-6 task_list_open 不返回已过期任务（含 raw_status=open 但 deadline 已过）", () => {
  const expired = `测试过期-${process.pid}`;
  const done = `测试完成-${process.pid}`;
  const alive = publishTask(baseTask()).task_id;
  const userId = getDb().prepare("SELECT id FROM users LIMIT 1").get().id;
  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO tasks(id, owner_id, from_building, to_building, station, deadline_ts,
       reward_min, reward_max, note, screenshot_path, raw_status, created_at, demo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  );
  insert.run(expired, userId, "12号宿舍楼", "15号宿舍楼", "快递驿站", NOW - 60, 3, 5, null, null, "open", NOW);
  insert.run(done, userId, "12号宿舍楼", "15号宿舍楼", "快递驿站", NOW + 3600, 3, 5, null, null, "done", NOW);

  const listed = listOpenTasks({ limit: 50 }).map((t) => t.task_id);
  assert.ok(listed.includes(alive));
  assert.ok(!listed.includes(expired), "已过期任务不得出现在开放列表");
  assert.ok(!listed.includes(done), "done 任务不得出现在开放列表");
  assert.ok(
    listOpenTasks({ limit: 50 }).every((t) => t.raw_status === "open" && new Date(t.deadline_iso).getTime() / 1000 > NOW),
  );
});

test("§7-6b task_list_open：building 参数同时匹配 from_building 与 to_building", () => {
  const asFrom = listOpenTasks({ building: "12号宿舍楼", limit: 50 });
  const asTo = listOpenTasks({ building: "15号宿舍楼", limit: 50 });
  assert.ok(asFrom.length > 0 && asTo.length > 0);
  assert.ok(asFrom.every((t) => t.from_building === "12号宿舍楼" || t.to_building === "12号宿舍楼"));
  assert.equal(listOpenTasks({ building: "不存在的楼", limit: 50 }).length, 0);
});

test("§7-7 screenshot_path 为 null 时发布仍然成功；非法路径被拦", () => {
  const okNull = publishTask(baseTask({ screenshot_path: null }));
  assert.ok(okNull.task_id);
  assert.equal(okNull.status, "open");
  assert.equal(getTask(okNull.task_id).screenshot_path, null);

  const none = publishTask(baseTask());
  assert.equal(getTask(none.task_id).screenshot_path, null);

  const okPath = publishTask(baseTask({ screenshot_path: "uploads/masked-demo.png" }));
  assert.equal(getTask(okPath.task_id).screenshot_path, "uploads/masked-demo.png");

  for (const bad of ["../secret.png", "C:/tmp/x.png", "/etc/passwd", "a b.png"]) {
    assert.throws(
      () => publishTask(baseTask({ screenshot_path: bad })),
      (e) => e.code === "SCHEMA_REJECTED",
      `非法路径应被拒绝：${bad}`,
    );
  }
});

test("§7-8 additionalProperties:false 生效：多传一个字段 → SCHEMA_REJECTED", async () => {
  const extra1 = await callTool("task_publish", { ...baseTask(), extra_field: "x" });
  assert.equal(extra1.ok, false);
  assert.equal(extra1.error.code, "SCHEMA_REJECTED");

  const extra2 = await callTool("task_list_open", { limit: 5, nope: 1 });
  assert.equal(extra2.ok, false);
  assert.equal(extra2.error.code, "SCHEMA_REJECTED");

  const extra3 = await callTool("match_find_for_task", { task_id: "x", top_k: 3, extra: true });
  assert.equal(extra3.ok, false);
  assert.equal(extra3.error.code, "SCHEMA_REJECTED");

  const extra4 = await callTool("task_parse_screenshot", { image_base64: "AAAA", oops: 1 });
  assert.equal(extra4.ok, false);
  assert.equal(extra4.error.code, "SCHEMA_REJECTED");

  // 缺必填同样被拦
  const missing = await callTool("task_publish", { from_building: "12号宿舍楼" });
  assert.equal(missing.error.code, "SCHEMA_REJECTED");

  // service 层的白名单二道防线
  assert.throws(
    () => publishTask({ ...baseTask(), extra_field: "x" }),
    (e) => e.code === "SCHEMA_REJECTED",
  );
});

// ---------------------------------------------------------------- 其他交付项

test("runner_register：同一 user_handle 重复登记走 UPSERT（同一 runner_id / 1 行 / 字段被覆盖）", () => {
  const handle = "UPSERT候选";
  const first = registerRunner({
    user_handle: handle,
    reachable_buildings: ["12号宿舍楼"],
    reward_floor: 1,
    time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(60) }],
  });
  const second = registerRunner({
    user_handle: handle,
    reachable_buildings: ["12号宿舍楼", "15号宿舍楼"],
    reward_floor: 4,
    time_windows: [
      { start_iso: isoIn(-30), end_iso: isoIn(120) },
      { start_iso: isoIn(180), end_iso: isoIn(300) },
    ],
  });
  assert.equal(second.runner_id, first.runner_id, "重复登记必须复用同一 runner_id");
  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const rows = getDb()
    .prepare("SELECT * FROM runners WHERE id = ?")
    .all(second.runner_id);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].reachable_buildings), ["12号宿舍楼", "15号宿舍楼"]);
  assert.equal(rows[0].reward_floor, 4);
  assert.equal(JSON.parse(rows[0].time_windows).length, 2);

  // 非法入参
  assert.throws(
    () => registerRunner({ user_handle: handle, reachable_buildings: "12号宿舍楼", reward_floor: 1, time_windows: [] }),
    (e) => e.code === "SCHEMA_REJECTED",
  );
  assert.throws(
    () =>
      registerRunner({
        user_handle: handle,
        reachable_buildings: ["12号宿舍楼"],
        reward_floor: 1,
        time_windows: [{ start_iso: isoIn(60), end_iso: isoIn(30) }],
      }),
    (e) => e.code === "SCHEMA_REJECTED",
  );
  // ⛔ 昵称不能是手机号/邮箱（本站不收集身份信息）
  assert.throws(
    () =>
      registerRunner({
        user_handle: "13800138000",
        reachable_buildings: ["12号宿舍楼"],
        reward_floor: 1,
        time_windows: [],
      }),
    (e) => e.code === "SCHEMA_REJECTED",
  );
});

test("task_parse_screenshot：未配置 LLM → 如实降级（字段 null / confidence 0），不落盘、不抽 PII", async () => {
  assert.equal(isVisionConfigured(), false, "测试环境不应配置 LLM 三件套");

  const uploads = path.join(ROOT, "static", "uploads");
  const before = fs.existsSync(uploads) ? fs.readdirSync(uploads).sort() : [];

  const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9QmzAAAAAElFTkSuQmCC";

  // 无 hint → 全部 null
  const empty = await callTool("task_parse_screenshot", { image_base64: payload });
  assert.equal(empty.ok, true);
  assert.equal(empty.data.confidence, 0);
  for (const f of ["from_building", "to_building", "station", "deadline_iso", "reward_min", "reward_max", "note"]) {
    assert.equal(empty.data[f], null, `${f} 应为 null（不猜）`);
  }
  assert.equal(empty.data.degraded, true);
  assert.equal(empty.data.image_stored, false);

  // 有 hint → 规则化兜底只填「能确定性识别」的字段（楼栋规范名 / 报酬区间）
  const hinted = await callTool("task_parse_screenshot", {
    image_base64: `data:image/png;base64,${payload}`,
    hint: "12号宿舍楼取快递送到15号宿舍楼，快递驿站，报酬3-5元",
  });
  assert.equal(hinted.ok, true);
  assert.equal(hinted.data.from_building, "12号宿舍楼");
  assert.equal(hinted.data.to_building, "15号宿舍楼");
  assert.equal(hinted.data.station, "快递驿站");
  assert.equal(hinted.data.reward_min, 3);
  assert.equal(hinted.data.reward_max, 5);
  assert.ok(hinted.data.confidence >= 0.4 && hinted.data.confidence <= 0.6);

  // ⛔ 不抽取姓名 / 手机号 / 运单号；base64 不回显
  const text = JSON.stringify(empty.data) + JSON.stringify(hinted.data);
  for (const banned of ["name", "phone", "mobile", "tracking", "receiver", "recipient", "id_card"]) {
    assert.ok(!text.includes(banned), `返回里不该出现身份字段 ${banned}`);
  }
  assert.ok(!text.includes(payload.slice(0, 40)), "base64 原图不许回显");

  // ⛔ 不落盘
  const after = fs.existsSync(uploads) ? fs.readdirSync(uploads).sort() : [];
  assert.deepEqual(after, before, "截图不得落服务器磁盘");

  // 非法输入
  const bad = await callTool("task_parse_screenshot", { image_base64: "不是 base64 !!!" });
  assert.equal(bad.error.code, "SCHEMA_REJECTED");
});

test("HTTP /api/tasks：4 条路由（读开放、写需令牌、详情、触发撮合）", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = process.env.DEMO_TOKEN;
  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });

  try {
    // 1) GET /api/tasks —— 只回 open 且未过期
    const list = await fetch(`${base}/api/tasks?limit=50`).then((r) => r.json());
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.data));
    assert.ok(list.data.every((t) => t.raw_status === "open"));
    assert.ok(list.data.every((t) => new Date(t.deadline_iso).getTime() / 1000 > Math.floor(Date.now() / 1000)));

    // 2) POST /api/tasks —— 写接口必须带令牌
    const denied = await post("/api/tasks", baseTask());
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).ok, false);

    const created = await post("/api/tasks", baseTask(), { "x-demo-token": token }).then((r) => r.json());
    assert.equal(created.ok, true);
    assert.ok(created.data.task_id);
    assert.equal(created.data.status, "open");

    // 业务校验失败 → 信封 + SCHEMA_REJECTED
    const rejected = await post("/api/tasks", baseTask({ reward_min: 9, reward_max: 1 }), {
      "x-demo-token": token,
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "SCHEMA_REJECTED");

    // 3) GET /api/tasks/:id
    const one = await fetch(`${base}/api/tasks/${created.data.task_id}`).then((r) => r.json());
    assert.equal(one.ok, true);
    assert.equal(one.data.task_id, created.data.task_id);
    assert.match(one.data.deadline_iso, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(one.data.screenshot_path, null);
    assert.ok(!("owner_id" in one.data));

    const missing = await fetch(`${base}/api/tasks/不存在的任务`).then((r) => r.json());
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "NOT_FOUND");

    // 4) POST /api/tasks/:id/match
    parkAllRunners();
    registerRunner(baseRunner({ user_handle: "接口候选", reward_floor: 1 }));
    const noToken = await post(`/api/tasks/${created.data.task_id}/match`, {});
    assert.equal(noToken.status, 401);

    const matched = await post(`/api/tasks/${created.data.task_id}/match`, {}, { "x-demo-token": token }).then((r) => r.json());
    assert.equal(matched.ok, true);
    assert.ok(Array.isArray(matched.data), "契约 §4：data 是 Match[]");
    assert.ok(matched.data.length >= 1);
    for (const m of matched.data) {
      assert.ok(typeof m.score === "number" && m.score >= 60);
      assert.ok(typeof m.reason === "string" && m.reason.length > 0);
      assert.ok(typeof m.runner_handle === "string");
    }
    assert.ok(matched.data.some((m) => m.runner_handle === "接口候选" && m.pushed === true));

    // 页面本体：集成后复用全站共享层（api / nav / demo / ui），外链脚本仍只允许 /config.js
    const page = await fetch(`${base}/takeout`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes("匹配结果") && html.includes("score"), "页面必须展示 score");
    assert.ok(html.includes("reason:"), "页面必须展示 reason");
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/config.js"], "页面外链脚本只允许 /config.js（共享层以 module 形式内联导入）");
    // demo 模式接入：F0 的 /js/demo.js
    assert.ok(/\/js\/demo\.js/.test(html), "必须接入 /js/demo.js");
    // 集成后必须复用共享层（令牌与信封解包全站唯一来源，⛔ 各页不得再自己写一套）
    assert.ok(/\/js\/api\.js/.test(html), "必须复用 /js/api.js");
    assert.ok(/\/js\/nav\.js/.test(html), "必须接入 /js/nav.js（6 页共用导航）");
    // ⛔ 静态文案里不许出现「演示模式」（否则不带 ?demo=1 也会被判定为已启用）
    assert.ok(!html.includes("演示模式"), "静态文案里不许出现「演示模式」字样");
    // 375px 不破版的关键 CSS：datetime-local 所在网格必须允许收缩
    assert.ok(/minmax\(0,1fr\)/.test(html), ".wins .win 必须用 minmax(0,1fr)");
    assert.ok(/@media \(max-width:640px\)[\s\S]*\.wins \.win/.test(html), "必须给 .wins .win 窄屏兜底");
  } finally {
    server.close();
  }
});

test("只读辅助口：GET /api/runners（脱敏、只回活跃）与 GET /api/matches（最近撮合 + score）", async () => {
  const { createApp } = await import("../src/server.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    parkAllRunners();
    registerRunner(baseRunner({ user_handle: "门户统计跑腿", reward_floor: 1 }));
    const { task_id } = publishTask(baseTask({ deadline_iso: isoIn(180) }));
    const matched = matchForTask(task_id, { now: NOW, topK: 3 });
    assert.ok(matched.pushed_count >= 1);

    // 读接口不加令牌
    const runners = await fetch(`${base}/api/runners`).then((r) => r.json());
    assert.equal(runners.ok, true);
    assert.ok(Array.isArray(runners.data), "门户 listOf() 需要 data 直接是数组");
    assert.equal(runners.data.length, 1);
    assert.equal(runners.data[0].user_handle, "门户统计跑腿");
    assert.equal(Number(runners.data[0].active), 1, "门户按 Number(r.active) === 1 计数");
    assert.ok(!("user_id" in runners.data[0]), "⛔ 不得返回内部 user_id");
    assert.ok(!("contact_code" in runners.data[0]), "⛔ 不得返回联系方式");
    assert.ok(Array.isArray(runners.data[0].reachable_buildings));

    const matches = await fetch(`${base}/api/matches?limit=5`).then((r) => r.json());
    assert.equal(matches.ok, true);
    assert.ok(Array.isArray(matches.data));
    assert.ok(matches.data.length >= 1 && matches.data.length <= 5, "limit 必须生效");
    for (const m of matches.data) {
      assert.ok(Number.isFinite(Number(m.score)), "score 必须是数字（门户要算平均分）");
      assert.ok(m.score >= 60);
      assert.ok(typeof m.task_id === "string");
      assert.match(m.created_at_iso, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(!("user_id" in m) && !("runner_id" in m), "⛔ 只出昵称，不出内部 id");
    }
    const avg = matches.data.reduce((a, b) => a + Number(b.score), 0) / matches.data.length;
    assert.ok(avg > 0 && avg <= 100, `平均撮合得分=${avg}`);

    // limit 越界收敛到 1..50，不报错
    const clamped = await fetch(`${base}/api/matches?limit=999`).then((r) => r.json());
    assert.equal(clamped.ok, true);
  } finally {
    server.close();
  }
});

test("楼栋规范名归一：口语写法自动收敛，归不出来才拒并列出可选规范名", async () => {
  // 1) 纯归一表（由 config/map-nodes.json 的 label 派生，不写死楼栋）
  const table = {
    "12号楼": "12号宿舍楼",
    "12栋": "12号宿舍楼",
    "十二号宿舍楼": "12号宿舍楼",
    "12号": "12号宿舍楼",
    "15号楼": "15号宿舍楼",
    "12号宿舍楼东": "12号宿舍楼",
    "南大门": "南门",
    "菜鸟驿站": "快递驿站",
    "快递站": "快递驿站",
    "二食堂": "第二食堂",
    "2食堂": "第二食堂",
    "火星楼": null,
    "12号教学楼": null,
  };
  for (const [raw, want] of Object.entries(table)) {
    assert.equal(normalizeBuildingName(raw), want, `${raw} 应归一为 ${want}`);
  }

  // 2) task_publish 传口语楼栋 → 成功，库里/出参都是规范名
  const created = publishTask(baseTask({ from_building: "12号楼", to_building: "15栋" }));
  const stored = getDb().prepare("SELECT from_building, to_building FROM tasks WHERE id = ?").get(created.task_id);
  assert.equal(stored.from_building, "12号宿舍楼");
  assert.equal(stored.to_building, "15号宿舍楼");
  assert.equal(getTask(created.task_id).from_building, "12号宿舍楼");

  // 3) 归一失败 → SCHEMA_REJECTED，且 message 里带可选规范名（Agent 可以自我纠正）
  assert.throws(
    () => publishTask(baseTask({ to_building: "火星楼" })),
    (e) => {
      assert.equal(e.code, "SCHEMA_REJECTED");
      assert.match(e.message, /火星楼/);
      assert.match(e.message, /可选/);
      for (const label of canonicalLabels()) assert.ok(e.message.includes(label), `message 应列出 ${label}`);
      return true;
    },
  );
  assert.throws(
    () => publishTask(baseTask({ from_building: "12号教学楼" })),
    (e) => e.code === "SCHEMA_REJECTED",
  );

  // 4) 快递站名宽松：归一命中用规范名，归不出来保留原文（station 不参与打分）
  const st1 = publishTask(baseTask({ station: "菜鸟驿站" }));
  assert.equal(getTask(st1.task_id).station, "快递驿站");
  const st2 = publishTask(baseTask({ station: "南门快递柜" }));
  assert.equal(getTask(st2.task_id).station, "南门快递柜");

  // 5) MCP 与 HTTP 共用同一套归一（MCP 路径也生效）
  const viaMcp = await callTool("task_publish", {
    from_building: "十二号楼",
    to_building: "15号楼",
    station: "菜鸟驿站",
    deadline_iso: isoIn(240),
    reward_min: 3,
    reward_max: 5,
    owner_handle: "归一同学",
  });
  assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
  assert.equal(getTask(viaMcp.data.task_id).from_building, "12号宿舍楼");
  const badMcp = await callTool("task_publish", {
    from_building: "火星楼",
    to_building: "15号楼",
    station: "快递驿站",
    deadline_iso: isoIn(240),
    reward_min: 3,
    reward_max: 5,
    owner_handle: "归一同学",
  });
  assert.equal(badMcp.error.code, "SCHEMA_REJECTED");
  assert.match(badMcp.error.message, /可选/);

  // 6) 过滤参数也归一：用「12号楼」筛得到 12号宿舍楼 的任务
  const filtered = listOpenTasks({ building: "12号楼", limit: 50 });
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((t) => t.from_building === "12号宿舍楼" || t.to_building === "12号宿舍楼"));
});

test("runner_register 也归一：登记「12号楼」的跑腿者能被「12号宿舍楼」的任务端到端命中", async () => {
  parkAllRunners();
  // 跑腿方用口语写法登记
  const reg = registerRunner({
    user_handle: "归一跑腿",
    reachable_buildings: ["12号楼", "12号宿舍楼", "15栋"],
    reward_floor: 1,
    time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(300) }],
  });
  // 存库去重后是规范名
  const row = getDb().prepare("SELECT reachable_buildings FROM runners WHERE id = ?").get(reg.runner_id);
  assert.deepEqual(JSON.parse(row.reachable_buildings), ["12号宿舍楼", "15号宿舍楼"]);
  assert.deepEqual(reg.reachable_buildings, ["12号宿舍楼", "15号宿舍楼"]);

  // 任务端用规范名发布 → 端到端命中（可达性 40 + 时间 30 + 报酬 30 = 100）
  const { task_id } = publishTask(baseTask({ from_building: "12号宿舍楼", to_building: "15号宿舍楼" }));
  const result = matchForTask(task_id, { now: NOW, topK: 3 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].runner_handle, "归一跑腿");
  assert.equal(result.matches[0].score, 100);
  // reason 里楼栋名是规范名（⛔ 不许动分值：仍等于 score）
  assert.match(result.matches[0].reason, /可达 15号宿舍楼/);
  assert.equal(parseReasonScores(result.matches[0].reason).reduce((a, b) => a + b, 0), result.matches[0].score);

  // 未知楼栋 → 拒 + 可选清单
  assert.throws(
    () =>
      registerRunner({
        user_handle: "归一跑腿",
        reachable_buildings: ["火星楼"],
        reward_floor: 1,
        time_windows: [],
      }),
    (e) => e.code === "SCHEMA_REJECTED" && /可选/.test(e.message) && e.message.includes("12号宿舍楼"),
  );
  // MCP 路径同样归一
  const viaMcp = await callTool("runner_register", {
    user_handle: "归一跑腿MCP",
    reachable_buildings: ["12号楼"],
    reward_floor: 2,
    time_windows: [{ start_iso: isoIn(-30), end_iso: isoIn(60) }],
  });
  assert.equal(viaMcp.ok, true);
  assert.deepEqual(viaMcp.data.reachable_buildings, ["12号宿舍楼"]);
});

test("MCP 工具清单：m1 的 5 个工具都在，且 schema 全部 additionalProperties:false", () => {
  const tools = listToolSchemas();
  const m1 = ["task_parse_screenshot", "task_publish", "runner_register", "match_find_for_task", "task_list_open"];
  for (const name of m1) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `缺工具 ${name}`);
    assert.equal(t.inputSchema.additionalProperties, false, `${name} 必须 additionalProperties:false`);
  }
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "工具名不许重复");

  // 契约 §3.4：只返回 >= 60，按 score 降序
  const { task_id } = publishTask(baseTask());
  registerRunner(baseRunner({ user_handle: "MCP候选A", reward_floor: 0 }));
  registerRunner(baseRunner({ user_handle: "MCP候选B", reachable_buildings: ["第二食堂"], reward_floor: 0 }));
  return callTool("match_find_for_task", { task_id, top_k: 10 }).then((env) => {
    assert.equal(env.ok, true);
    const list = env.data.matches;
    assert.ok(list.length >= 1);
    assert.ok(list.every((m) => m.score >= 60));
    assert.ok(!list.some((m) => m.runner_handle === "MCP候选B"), "不可达候选不得出现");
    const scores = list.map((m) => m.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "必须按 score 降序");
    for (const m of list) {
      assert.equal(parseReasonScores(m.reason).reduce((a, b) => a + b, 0), m.score);
    }
  });
});
