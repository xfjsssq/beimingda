/**
 * M2 搭子匹配单测（node:test）
 *
 *   覆盖 contracts/m2-buddy.md §8 自测清单 9 条 + 本模块硬约束：
 *     · §8-1  buddy_publish 能从自然语言抽出 §1 全部字段
 *     · §8-2  未提及字段取中性值，没有编造兴趣
 *     · §8-3  must_have 与 deal_breaker 语义冲突的候选被排除（真实冲突用例）
 *     · §8-4  kind 不同的候选被排除
 *     · §8-5  只有一方同意时 → 返回对象**不含 contact_code 这个键**（用 Object.hasOwn / in 判）
 *     · §8-6  双方同意 → revealed=1 且 contact_code 出现
 *     · §8-7  同一 (post_id, seeker_id) 重复表决被 DB UNIQUE 拦住
 *     · §8-8  anon_token 与 user_id 无任何可推导关系
 *     · §8-9  候选 reason 里的分值相加 === score
 *
 *   ⛔ 不改 tests/skeleton.test.js（T0 骨架用例）；本文件用独立临时库，不污染开发库。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 独立临时库（写法同 scripts/smoke.js）
process.env.DB_PATH = path.join(os.tmpdir(), `beimingda-m2-test-${process.pid}-${Date.now()}.db`);
process.env.DEMO_TOKEN = process.env.DEMO_TOKEN || "m2-test-token";
// 强制走"无 LLM key"的降级路径：语义 15 分与冲突判定用规则化兜底
delete process.env.LLM_BASE_URL;
delete process.env.LLM_API_KEY;
delete process.env.LLM_MODEL;

const TOKEN = process.env.DEMO_TOKEN;

const { getDb } = await import("../src/db/index.js");
const engine = await import("../src/engine/buddy.js");
const opt = await import("../src/engine/doubleOpt.js");
const svc = await import("../src/services/buddy.js");
const { callTool, listToolSchemas, validateArgs } = await import("../src/mcp/tools.js");
const { threadIdForBuddy } = await import("../src/services/chat.js");
const { loadHandlers } = await import("../src/mcp/handlers.js");
const { createApp } = await import("../src/server.js");

loadHandlers(); // 注册 M2 的 3 个工具（幂等；createApp() 之后不会再重复注册）

const FIXTURES = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "buddy-posts.json"), "utf8"));
const byId = (id) => FIXTURES.posts.find((p) => p.id === id);
const rows = () => getDb().prepare("SELECT COUNT(*) n FROM buddy_posts").get().n;

// ─── 把 fixtures 灌进临时库（走 service 的建帖接口，画像显式给出） ───
const seeded = new Map();
for (const row of FIXTURES.posts) {
  seeded.set(
    row.id,
    svc.createPost({
      author_handle: row.author_handle,
      kind: row.kind,
      profile: row.profile,
      anon_token: row.anon_token,
      raw_status: row.raw_status,
    }),
  );
}
const tokenOf = (id) => seeded.get(id).anon_token;
const postIdOf = (id) => seeded.get(id).post_id;

/** 与 demo-buddy-3 高度匹配的寻找方描述（不带冲突句） */
const ROOMMATE_OK =
  "研一 理科 想找作息接近的室友，晚上能一起开黑聊两句，白天各忙各的；喜欢游戏和动漫；晚上睡得晚；周二1-3节有课";
/** 同一段描述 + 一条与 demo-buddy-3 的 deal_breaker 语义冲突的硬性要求（字符串完全不等） */
const ROOMMATE_CONFLICT = `${ROOMMATE_OK}；室友必须安静，半夜别吵`;
const STUDY_TEXT =
  "大二 工科 想找一起刷算法题和摄影的同学；作息偏夜猫；周末有空；周三1-2节有课";

// ──────────────────────────── §8 逐条 ────────────────────────────

test("§8-1 buddy_publish 能从一段自然语言抽取出 §1 的全部字段", async () => {
  const env = await callTool("buddy_publish", {
    author_handle: "同学甲",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(env.ok, true, JSON.stringify(env.error));
  const { post_id, anon_token, profile } = env.data;

  // 顶层 9 键（= 契约 §1 的完整结构，字段名一字不改）
  assert.deepEqual(Object.keys(profile).sort(), [...engine.PROFILE_FIELDS].sort());
  assert.deepEqual(Object.keys(profile.schedule).sort(), ["busy_slots", "early_bird", "weekend_free"]);
  assert.deepEqual(Object.keys(profile.traits).sort(), ["chatty", "planner", "tidy"]);

  assert.equal(profile.kind, "study");
  assert.equal(profile.grade, "大二");
  assert.equal(profile.major_group, "工科");
  assert.ok(profile.interests.includes("算法"));
  assert.ok(profile.interests.includes("摄影"));
  assert.ok(profile.interests.length <= engine.RULES.max_interests);
  assert.ok(profile.wanted.includes("刷算法题"));
  assert.ok(profile.schedule.early_bird < 0.5, "「作息偏夜猫」应抽出偏夜猫的 early_bird");
  assert.ok(profile.schedule.weekend_free > 0.5, "「周末有空」应抽出偏空的 weekend_free");
  assert.deepEqual(profile.schedule.busy_slots, [{ weekday: 3, period_start: 1, period_end: 2 }]);

  // 存库是 Unix 秒、出接口是 ISO
  const dbRow = getDb().prepare("SELECT created_at FROM buddy_posts WHERE id = ?").get(post_id);
  assert.equal(Number.isInteger(dbRow.created_at), true, "created_at 必须是 Unix 秒整数");
  const listed = svc.listPosts({ kind: "study" }).find((p) => p.post_id === post_id);
  assert.match(listed.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.match(anon_token, /^anon_[0-9a-f]{12}$/);
});

test("§8-2 未提及的字段取中性值，没有编造兴趣", async () => {
  const env = await callTool("buddy_publish", {
    author_handle: "同学乙",
    kind: "other",
    // 刻意不含任何兴趣词、不含年级/专业/作息/性格
    text_profile: "想找个一起上课的搭子，最好离得近点",
  });
  assert.equal(env.ok, true, JSON.stringify(env.error));
  const p = env.data.profile;
  assert.deepEqual(p.interests, [], "未提及兴趣就必须是空数组，⛔ 不得编造");
  assert.equal(p.grade, "不限");
  assert.equal(p.major_group, "不限");
  assert.deepEqual(p.schedule.busy_slots, []);
  assert.equal(p.schedule.early_bird, 0.5);
  assert.equal(p.schedule.weekend_free, 0.5);
  assert.deepEqual(p.traits, { chatty: 0.5, planner: 0.5, tidy: 0.5 });
  assert.deepEqual(p.must_have, []);
  assert.deepEqual(p.deal_breaker, []);
  assert.ok(p.wanted.length > 0);
});

test("§8-3 must_have 与 deal_breaker 语义冲突的候选被排除（字符串完全不等）", async () => {
  const target = byId("demo-buddy-3");
  const conflictText = "室友必须安静，半夜别吵";
  assert.notEqual(conflictText, target.profile.deal_breaker[0], "用例前提：两边字符串完全不相等");

  // 1) 语义冲突判定（不是字符串相等）
  const conflicts = engine.findConflicts([conflictText], target.profile.deal_breaker);
  assert.ok(conflicts.length >= 1, "必须识别出「安静/别吵」↔「凌晨打游戏外放」的语义冲突");
  assert.equal(conflicts[0].theme, "噪音");

  // 2) 评分层面：一票否决 -> 0 分
  const seekerProfile = engine.extractProfileRules(ROOMMATE_CONFLICT, "roommate");
  assert.ok(seekerProfile.must_have.includes(conflictText), "冲突句应被抽进 must_have");
  const vetoed = engine.buddyScore(target.profile, seekerProfile);
  assert.equal(vetoed.vetoed, true);
  assert.equal(vetoed.score, 0);
  assert.match(vetoed.veto_reason, /冲突/);

  // 3) 反证：把冲突句去掉，同一份画像能拿到 >= 60 —— 说明是"被否决"，不是"分不够"
  const noConflict = engine.buddyScore(target.profile, {
    ...seekerProfile,
    must_have: [],
    deal_breaker: [],
  });
  assert.ok(noConflict.score >= engine.THRESHOLD, `去掉冲突句后应能过阈值，实得 ${noConflict.score}`);

  // 4) 端到端：同一段描述，带冲突句 -> 该帖消失；不带 -> 该帖出现
  const bad = await callTool("buddy_search", {
    seeker_handle: "同学丙",
    kind: "roommate",
    text_profile: ROOMMATE_CONFLICT,
  });
  assert.equal(bad.ok, true, JSON.stringify(bad.error));
  assert.ok(
    !bad.data.candidates.some((c) => c.post_id === postIdOf("demo-buddy-3")),
    "冲突候选必须被排除",
  );

  const good = await callTool("buddy_search", {
    seeker_handle: "同学丁",
    kind: "roommate",
    text_profile: ROOMMATE_OK,
  });
  assert.equal(good.ok, true, JSON.stringify(good.error));
  assert.ok(
    good.data.candidates.some((c) => c.post_id === postIdOf("demo-buddy-3")),
    "不带冲突句时应能命中该帖",
  );
});

test("§2 加强：完全同词（含去空白/大小写/同义归一）必须判冲突并一票否决", async () => {
  // 验证员复现的原句：以前返回 []
  assert.ok(engine.findConflicts(["抽烟"], ["抽烟"]).length >= 1, "完全同词必须判冲突");
  assert.ok(engine.findConflicts(["  抽 烟 "], ["抽烟"]).length >= 1, "去空白后同词必须判冲突");
  assert.ok(engine.findConflicts(["吸烟"], ["抽烟"]).length >= 1, "同义归一后同词必须判冲突");
  assert.ok(engine.findConflicts(["不抽烟"], ["抽烟"]).length >= 1, "剥极性词后同词必须判冲突");

  // 方向二：同主题但表述完全不同 —— 仍必须判冲突
  assert.ok(engine.findConflicts(["室友必须安静，半夜别吵"], ["凌晨打游戏外放"]).length >= 1, "噪音主题");
  assert.ok(engine.findConflicts(["不接受抽烟"], ["室友抽烟（阳台抽也不行）"]).length >= 1, "抽烟主题");
  assert.ok(engine.findConflicts(["要求每周一起打扫卫生"], ["房间乱一点就焦虑，会一直念叨别人不收拾"]).length >= 1, "卫生主题");
  assert.ok(engine.findConflicts(["希望一起自习"], ["讨厌自习"]).length >= 1, "学习习惯主题 + 否定语义");
  assert.ok(engine.findConflicts(["希望周末有空"], ["周末很忙"]).length >= 1, "周末时间主题 + 反义立场");

  // 反向：不该被误判成冲突的组合（否则会过度否决，把好候选排掉）
  assert.deepEqual(engine.findConflicts(["希望作息一致"], ["凌晨打游戏外放"]), []);
  assert.deepEqual(engine.findConflicts(["希望对方爱干净"], ["凌晨打游戏外放"]), []);
  assert.deepEqual(engine.findConflicts(["不养宠物"], ["室友抽烟"]), []);
  // ⛔ 纯"包含"关系不判冲突（verifier 终审 B1：`希望安静` ⊃ `安静` 语义其实一致，都爱安静）
  //    包含只能作为"同主题 + 否定/反义"的补充证据，不能独立触发否决
  assert.deepEqual(engine.findConflicts(["希望安静"], ["安静"]), [], "纯包含不得判冲突（会误杀好候选）");
  assert.deepEqual(engine.findConflicts(["希望安静"], ["喜欢安静的环境"]), [], "同向立场不得判冲突");
  assert.deepEqual(engine.findConflicts(["室友抽烟"], ["抽烟"]), [], "纯包含（无极性/否定）按裁决不判冲突");
  // 但同主题一旦带否定或反义立场，仍必须冲突
  assert.ok(engine.findConflicts(["希望安静"], ["讨厌安静"]).length >= 1, "同主题 + 否定词必须冲突");

  // 评分层：同词场景必须 0 分出局；去掉同词句后同一画像本来能过阈值
  const postProfile = { ...byId("demo-buddy-4").profile, deal_breaker: ["抽烟"] };
  const seekerProfile = { ...byId("demo-buddy-4").profile, must_have: ["抽烟"] };
  const scored = engine.buddyScore(postProfile, seekerProfile);
  assert.equal(scored.vetoed, true, "同词必须一票否决");
  assert.equal(scored.score, 0);
  const cleared = engine.buddyScore(postProfile, { ...seekerProfile, must_have: [] });
  assert.ok(cleared.score >= engine.THRESHOLD, `去掉同词句后应能过阈值，实得 ${cleared.score}`);

  // 端到端 1：**完全同词** —— 帖子的雷点与寻找方的硬性要求归一后是同一句 -> 必须排除
  const MATCH_TEXT =
    "大四 经管 想找爱干净、作息规律的室友，实习期早出晚归，希望互相尊重安静时间；喜欢实习和读书；早睡早起；周五1-4节和周六1-4节有课";
  const sameWordPost = svc.createPost({
    author_handle: "同词作者",
    kind: "roommate",
    profile: { ...postProfile, deal_breaker: ["室友必须能一起抽烟"] },
  });
  const clean = await callTool("buddy_search", {
    seeker_handle: "同词寻找者A",
    kind: "roommate",
    text_profile: MATCH_TEXT,
  });
  assert.equal(clean.ok, true, JSON.stringify(clean.error));
  assert.ok(
    clean.data.candidates.some((c) => c.post_id === sameWordPost.post_id),
    "不带同词句时应能命中该帖",
  );
  const dirty = await callTool("buddy_search", {
    seeker_handle: "同词寻找者B",
    kind: "roommate",
    text_profile: `${MATCH_TEXT}；室友必须能一起抽烟`,
  });
  assert.equal(dirty.ok, true, JSON.stringify(dirty.error));
  assert.ok(
    !dirty.data.candidates.some((c) => c.post_id === sameWordPost.post_id),
    "完全同词的冲突候选必须被排除（以前会照常以 94 分通过）",
  );

  // 端到端 2：**同主题 + 否定词**（更贴近真实措辞）-> 也必须排除
  //    ⚠️ 注意：单纯"包含"（`室友必须能一起抽烟` ⊃ `抽烟`）按语委口径**不算**冲突，
  //    所以这里用「必须不抽烟」（带否定词）来触发，而不是靠包含
  const themePost = svc.createPost({
    author_handle: "同主题作者",
    kind: "roommate",
    profile: postProfile,
  });
  const negHit = await callTool("buddy_search", {
    seeker_handle: "同词寻找者C",
    kind: "roommate",
    text_profile: `${MATCH_TEXT}；室友必须不抽烟`,
  });
  assert.equal(negHit.ok, true, JSON.stringify(negHit.error));
  assert.ok(
    !negHit.data.candidates.some((c) => c.post_id === themePost.post_id),
    "同主题 + 否定词必须排除",
  );
  const keep = await callTool("buddy_search", {
    seeker_handle: "同词寻找者D",
    kind: "roommate",
    text_profile: MATCH_TEXT,
  });
  assert.equal(keep.ok, true, JSON.stringify(keep.error));
  assert.ok(
    keep.data.candidates.some((c) => c.post_id === themePost.post_id),
    "不带否定句时应命中该帖（否则就是误否决）",
  );
});

test("§8-4 kind 不同的候选被排除", async () => {
  const study = byId("demo-buddy-1");
  const asSport = engine.buddyScore(study.profile, { ...study.profile, kind: "sport" });
  assert.equal(asSport.vetoed, true);
  assert.equal(asSport.score, 0);
  assert.match(asSport.veto_reason, /kind 不一致/);

  const res = await callTool("buddy_search", {
    seeker_handle: "同学戊",
    kind: "sport",
    text_profile: "大一 想找固定球搭子，每周两三次，下午没课就约球，一起撸铁也行",
  });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(res.data.candidates.length >= 1, "sport 类至少应命中 1 条");
  assert.ok(res.data.candidates.every((c) => c.kind === "sport"));
  assert.ok(!res.data.candidates.some((c) => c.post_id === postIdOf("demo-buddy-1")));

  // 非法 kind / top_k 越界都要被拒
  const badKind = await callTool("buddy_search", {
    seeker_handle: "同学戊",
    kind: "romance",
    text_profile: "随便写点什么",
  });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error.code, "SCHEMA_REJECTED");
  const badTopK = await callTool("buddy_search", {
    seeker_handle: "同学戊",
    kind: "sport",
    text_profile: "大一 想找球搭子",
    top_k: 99,
  });
  assert.equal(badTopK.ok, false);
  assert.equal(badTopK.error.code, "SCHEMA_REJECTED");
});

test("§8-5 / §8-6 只有一方同意时返回对象不含 contact_code 键；双方同意后 revealed=1 且出现该键", async () => {
  const pub = await callTool("buddy_publish", {
    author_handle: "同学己",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(pub.ok, true, JSON.stringify(pub.error));
  const postId = pub.data.post_id;

  // ① 寻找方单独同意：author_ok 保持 0、revealed 保持 0
  const one = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "同学庚",
    agree: true,
  });
  assert.equal(one.ok, true, JSON.stringify(one.error));
  assert.deepEqual(one.data, { author_ok: 0, seeker_ok: 1, revealed: 0 });
  // ⭐ 关键断言：不是判空，是"这个键根本不存在"
  assert.equal(Object.hasOwn(one.data, "contact_code"), false);
  assert.equal("chat_ready" in one.data, false);
  assert.equal(Object.keys(one.data).includes("contact_code"), false);
  assert.equal("chat_ready" in one.data, false);

  // 检索侧同样：未互相可见的候选也不含该键
  const before = await callTool("buddy_search", {
    seeker_handle: "同学庚",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  const own = before.data.candidates.find((c) => c.post_id === postId);
  assert.ok(own, "自己发的帖也应出现在候选里");
  assert.equal(own.reveal_status, "pending");
  assert.equal(Object.hasOwn(own, "contact_code"), false);

  // ② 发布方同意 -> 双方都为 1 -> revealed=1 且 contact_code 出现
  const both = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "同学己",
    agree: true,
  });
  assert.equal(both.ok, true, JSON.stringify(both.error));
  // ⭐ 2026-10-31 起：双方同意后**不再给"中转码"**（服务器直连，直接站内聊天）
  assert.deepEqual(Object.keys(both.data).sort(), ["author_ok", "chat_ready", "revealed", "seeker_ok", "thread_id"]);
  assert.equal(both.data.author_ok, 1);
  assert.equal(both.data.seeker_ok, 1);
  assert.equal(both.data.revealed, 1);
  assert.equal(both.data.chat_ready, true, "双方同意后应给出聊天入口（替代旧的中转码）");

  // 服务端应当能给出这条关系的**站内私聊会话**（替代中转码）
  const seekerId = getDb().prepare("SELECT id FROM users WHERE handle = ?").get("同学庚").id;
  const threadId = threadIdForBuddy(postId, seekerId);
  assert.ok(threadId, "双方同意后应能拿到私聊会话 id");

  // 候选里是否带 chat_ready 依赖打分阈值（语义打分不稳定），契约本身已由上一条 threadIdForBuddy 覆盖；
  // 页面侧的 chat_ready/thread_id 呈现由 tests/ui-buddy-ui.test.js 的静态断言看守。
});

test("拒绝路径：任一方拒绝即终止，且绝不返回 contact_code", async () => {
  const pub = await callTool("buddy_publish", {
    author_handle: "同学拒A",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  const postId = pub.data.post_id;

  // 寻找方拒绝 -> 落一行 seeker_ok=0（终止）
  const refused = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "同学拒B",
    agree: false,
  });
  assert.equal(refused.ok, true, JSON.stringify(refused.error));
  assert.deepEqual(refused.data, { author_ok: 0, seeker_ok: 0, revealed: 0 });
  assert.equal(Object.hasOwn(refused.data, "contact_code"), false);

  // 发布方随后再同意 -> 已终止，不允许
  const revive = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "同学拒A",
    agree: true,
  });
  assert.equal(revive.ok, false);
  assert.equal(revive.error.code, "SCHEMA_REJECTED");

  // 发布方直接拒绝（寻找方已同意）
  const pub2 = await callTool("buddy_publish", {
    author_handle: "同学拒C",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  const id2 = pub2.data.post_id;
  await callTool("buddy_consent", { post_id: id2, seeker_handle: "同学拒D", agree: true });
  const denied = await callTool("buddy_consent", { post_id: id2, seeker_handle: "同学拒C", agree: false });
  assert.equal(denied.ok, true, JSON.stringify(denied.error));
  assert.deepEqual(denied.data, { author_ok: 0, seeker_ok: 1, revealed: 0 }, "任一方拒绝 -> revealed 必须归 0");
  assert.equal(Object.hasOwn(denied.data, "contact_code"), false);

  // 作者不可改票
  const again = await callTool("buddy_consent", { post_id: id2, seeker_handle: "同学拒C", agree: true });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "SCHEMA_REJECTED");
});

test("§8-7 同一 (post_id, seeker_id) 重复表决被数据库 UNIQUE 拦住", async () => {
  const pub = await callTool("buddy_publish", {
    author_handle: "同学辛2",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  const postId = pub.data.post_id;

  const first = await callTool("buddy_consent", { post_id: postId, seeker_handle: "同学壬2", agree: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));

  const second = await callTool("buddy_consent", { post_id: postId, seeker_handle: "同学壬2", agree: true });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "SCHEMA_REJECTED");
  assert.match(second.error.message, /表决一次|UNIQUE/);

  // 证据：走 service 报错之外，直接绕过 service 用裸 SQL 再插一行，DB 层也拦住
  const seeker = svc.findUser("同学壬2");
  const row = getDb()
    .prepare("SELECT * FROM buddy_consents WHERE post_id = ? AND seeker_id = ?")
    .get(postId, seeker.id);
  assert.ok(row, "应已落一行表决记录");
  assert.throws(
    () =>
      getDb()
        .prepare(
          `INSERT INTO buddy_consents(id,post_id,seeker_id,score,author_ok,seeker_ok,revealed,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run("dup-consent-1", postId, seeker.id, 60, 0, 1, 0, 1),
    /UNIQUE|constraint/i,
    "裸 SQL 插入也必须被 UNIQUE(post_id, seeker_id) 拦住",
  );
  // 表结构确实有这条约束
  const sql = fs.readFileSync(path.join(ROOT, "src/db", "schema.sql"), "utf8");
  assert.match(sql, /UNIQUE\(post_id, seeker_id\)/);
});

test("§8-8 anon_token 随机、与 user_id 无任何可推导关系", async () => {
  const a = await callTool("buddy_publish", {
    author_handle: "同学癸2",
    kind: "other",
    text_profile: "想找个一起上课的搭子",
  });
  const b = await callTool("buddy_publish", {
    author_handle: "同学癸2",
    kind: "other",
    text_profile: "想找个一起上课的搭子",
  });
  assert.equal(a.ok, true, JSON.stringify(a.error));

  const t1 = a.data.anon_token;
  const t2 = b.data.anon_token;
  assert.match(t1, /^anon_[0-9a-f]{12}$/);
  assert.match(t2, /^anon_[0-9a-f]{12}$/);
  assert.notEqual(t1, t2, "同一人两次发布也必须得到不同随机 token");

  const user = svc.findUser("同学癸2");
  const dbRow = getDb().prepare("SELECT author_id FROM buddy_posts WHERE id = ?").get(a.data.post_id);
  assert.equal(dbRow.author_id, user.id);

  const digest = crypto.createHash("sha256").update(user.id).digest("hex");
  for (const t of [t1, t2]) {
    const body = t.slice("anon_".length);
    assert.ok(!t.includes(user.id), "token 不得包含 user_id");
    assert.ok(!t.includes("同学癸2"), "token 不得包含昵称");
    assert.ok(!digest.startsWith(body.slice(0, 8)), "token 不得是 user_id 的 hash 前缀");
    assert.ok(!/^[0-9a-f]{12}$/.test(user.id.replace(/[^0-9a-f]/g, "")), "反证用：user_id 与 12 位 hex 不同源");
  }

  // 批量生成也不重复（随机而非派生）
  const many = new Set(Array.from({ length: 64 }, () => svc.anonToken()));
  assert.equal(many.size, 64);
});

test("§8-9 候选 reason 里的分值相加 === score（且都 >= 阈值 60）", async () => {
  const res = await callTool("buddy_search", {
    seeker_handle: "同学子2",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(res.data.candidates.length >= 1, "study 类至少应命中 1 条");
  for (const c of res.data.candidates) {
    assert.ok(c.score >= engine.THRESHOLD, `候选分必须 >= ${engine.THRESHOLD}，实得 ${c.score}`);
    assert.ok(engine.reasonSumsToScore(c.reason, c.score), `reason 分值相加 != score: ${c.reason}`);
    assert.equal(
      c.parts.interest + c.parts.schedule + c.parts.traits + c.parts.semantic,
      c.score,
      "分段之和必须等于总分",
    );
    assert.match(c.reason, /共同兴趣|无共同兴趣/);
    assert.match(c.reason, /作息/);
    assert.match(c.reason, /性格/);
    // reason 是给用户看的，必须带四项分段
    assert.equal([...c.reason.matchAll(/\+(\d+)/g)].length, 4);
  }
});

// ──────────────────────────── 引擎与权重 ────────────────────────────

test("权重 35/30/20/15 与阈值 60 与契约 / config 完全一致", () => {
  assert.deepEqual({ ...engine.RULES }, {
    interest: 35,
    schedule: 30,
    traits: 20,
    semantic: 15,
    threshold: 60,
    max_interests: 5,
  });
  assert.equal(engine.weightsMatchFrozen(), true);
  assert.equal(engine.THRESHOLD, 60);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "match-rules.json"), "utf8"));
  assert.deepEqual(cfg.buddy, {
    interest: 35,
    schedule: 30,
    traits: 20,
    semantic: 15,
    threshold: 60,
    max_interests: 5,
  });
});

test("无 LLM key 时语义 15 分走规则化兜底（降级实现，不是删掉这一项）", () => {
  assert.equal(engine.llmEnabled(), false, "本用例要求无 LLM key，走降级路径");

  const same = engine.semanticSimilarity(
    "想找一起刷算法题的同学，晚上七点后有空",
    "找搭子一起刷算法题，周三下午有空",
  );
  const diff = engine.semanticSimilarity(
    "想找一起刷算法题的同学，晚上七点后有空",
    "想找人一起夜跑",
  );
  assert.ok(same > diff, `同主题(${same}) 应高于异主题(${diff})`);
  assert.ok(same > 0.3, `同主题兜底分应明显大于 0，实得 ${same}`);

  const scored = engine.buddyScore(byId("demo-buddy-1").profile, byId("demo-buddy-1").profile);
  assert.ok(scored.parts.semantic > 0, "语义分不能恒为 0（降级实现也必须参与评分）");
  // 同一段文字自比：语义项必须拿满 15
  assert.equal(scored.parts.semantic, engine.RULES.semantic);
  assert.equal(engine.semanticSimilarity("想找一起刷算法题的同学", "想找一起刷算法题的同学"), 1);
});

test("双选状态机：三条路径 + revealed=0 时不带聊天入口（chat_ready），双方同意才标 chat_ready", () => {
  const s1 = opt.applyConsent(opt.initialConsent(), "seeker", true);
  assert.deepEqual(s1, { author_ok: 0, seeker_ok: 1, revealed: 0 });
  assert.equal(opt.revealStatus(s1), "pending");
  assert.equal("chat_ready" in opt.toResponse(s1, "ct_demo"), false, "只有一方同意不该给聊天入口");

  const both = opt.applyConsent(s1, "author", true);
  assert.deepEqual(both, { author_ok: 1, seeker_ok: 1, revealed: 1 });
  assert.equal(opt.revealStatus(both), "mutual");
  assert.equal(opt.toResponse(both, "ct_demo").chat_ready, true, "双方同意才标 chat_ready（替代旧的中转码）");

  const refused = opt.applyConsent(s1, "author", false);
  assert.deepEqual(refused, { author_ok: 0, seeker_ok: 1, revealed: 0 });
  assert.equal("chat_ready" in opt.toResponse(refused, "ct_demo"), false);

  const seekerRefused = opt.applyConsent(opt.initialConsent(), "seeker", false);
  assert.deepEqual(seekerRefused, { author_ok: 0, seeker_ok: 0, revealed: 0 });
  assert.equal("chat_ready" in opt.toResponse(seekerRefused, "ct_demo"), false);

  assert.throws(() => opt.applyConsent(s1, "nobody", true), /SCHEMA_REJECTED|author/);
  assert.throws(() => opt.applyConsent(s1, "seeker", "yes"), /SCHEMA_REJECTED|布尔/);
});

test("§3 脏数据防线：库里 revealed=1 也不能给出聊天入口（出口以状态机推导为准）", async () => {
  // ── 方向一：脏行不该揭示（存储列说 1，但两个 bit 没同时为真）──
  for (const dirty of [
    { author_ok: 0, seeker_ok: 0, revealed: 1 },
    { author_ok: 0, seeker_ok: 1, revealed: 1 },
    { author_ok: 1, seeker_ok: 0, revealed: 1 },
  ]) {
    const resp = opt.toResponse(dirty, "ct_dirty");
    assert.equal(
      Object.hasOwn(resp, "contact_code"),
      false,
      `脏行不得吐出 contact_code: ${JSON.stringify(dirty)}`,
    );
    assert.equal("chat_ready" in resp, false);
    assert.equal(resp.revealed, 0, "revealed 必须由 author_ok && seeker_ok 推导，不读存储列");
    assert.equal(opt.normalizeConsent(dirty).revealed, 0);
    assert.equal(opt.isMutual(dirty), false);
    assert.equal(opt.revealStatus(dirty), "pending");
  }

  // ── 方向二（反证）：存储列是 0，但两个 bit 都为真 -> 按推导必须揭示 ──
  const derived = opt.toResponse({ author_ok: 1, seeker_ok: 1, revealed: 0 }, "ct_ok");
  assert.equal(derived.revealed, 1, "两个 bit 都为真时按推导应揭示");
  assert.equal(derived.chat_ready, true, "揭示即代表可以直接开聊（不再有中转码）");
  assert.equal(Object.hasOwn(derived, "contact_code"), false, "⛔ 中转码字段已彻底移除");
  assert.equal(opt.normalizeConsent({ author_ok: 1, seeker_ok: 1, revealed: 0 }).revealed, 1);

  // ── 方向三（服务层）：手工 UPDATE revealed=1（author_ok 保持 0）后走对外接口 ──
  const pub = await callTool("buddy_publish", {
    author_handle: "脏数据作者",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(pub.ok, true, JSON.stringify(pub.error));
  const postId = pub.data.post_id;

  const voted = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "脏数据寻找者",
    agree: true,
  });
  assert.equal(voted.ok, true, JSON.stringify(voted.error));
  assert.equal(voted.data.revealed, 0);
  assert.equal(Object.hasOwn(voted.data, "contact_code"), false);

  // 把库里这一行手工改脏：revealed=1 而 author_ok 仍为 0
  const seeker = svc.findUser("脏数据寻找者");
  assert.ok(seeker);
  getDb()
    .prepare("UPDATE buddy_consents SET revealed = 1 WHERE post_id = ? AND seeker_id = ?")
    .run(postId, seeker.id);
  const dirtyRow = getDb()
    .prepare("SELECT author_ok, seeker_ok, revealed FROM buddy_consents WHERE post_id = ? AND seeker_id = ?")
    .get(postId, seeker.id);
  assert.deepEqual(
    { ...dirtyRow },
    { author_ok: 0, seeker_ok: 1, revealed: 1 },
    "前置条件：库里这行已经是脏数据",
  );

  // 对外接口一：MCP buddy_search 的候选
  const search = await callTool("buddy_search", {
    seeker_handle: "脏数据寻找者",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(search.ok, true, JSON.stringify(search.error));
  const cand = search.data.candidates.find((c) => c.post_id === postId);
  assert.ok(cand, "该帖应仍在候选列表里（脏数据只影响揭示，不该让帖子消失）");
  assert.equal(cand.reveal_status, "pending", "脏数据不得让候选变成 mutual");
  assert.equal(Object.hasOwn(cand, "contact_code"), false, "脏数据不得让候选吐出 contact_code");

  // 对外接口二：我的申请（GET /api/buddies/mine 用的同一个 service）
  const mine = svc.myApplications({ seeker_handle: "脏数据寻找者" }).find((m) => m.post_id === postId);
  assert.ok(mine);
  assert.equal(mine.revealed, 0, "我的申请也必须以推导为准");
  assert.equal(mine.reveal_status, "pending");

  // 收尾反证：作者真实同意后（两个 bit 都为真）才该揭示
  const both = await callTool("buddy_consent", {
    post_id: postId,
    seeker_handle: "脏数据作者",
    agree: true,
  });
  assert.equal(both.ok, true, JSON.stringify(both.error));
  assert.equal(both.data.revealed, 1);
  assert.equal(both.data.chat_ready, true, "双方都同意后给出聊天入口（⛔ 不再有中转码）");
  assert.equal(Object.hasOwn(both.data, "contact_code"), false, "⛔ 中转码字段已彻底移除");
});

// ──────────────────────────── 结果白名单（反推身份） ────────────────────────────

test("候选 / 列表结果里不出现任何可反推身份的字段", async () => {
  const res = await callTool("buddy_search", {
    seeker_handle: "同学白名单",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  const raw = JSON.stringify(res.data);
  for (const bad of ["author_id", "user_id", '"handle"', "student_no", "student_id", "dorm", "real_name", "phone", "院系", "班级", "学号", "宿舍号"]) {
    assert.ok(!raw.includes(bad), `候选结果里不得出现 ${bad}`);
  }
  for (const c of res.data.candidates) {
    for (const k of Object.keys(c)) {
      assert.ok(svc.SAFE_CANDIDATE_KEYS.includes(k), `候选出现非白名单字段 ${k}`);
    }
  }

  const list = svc.listPosts({ kind: "study" });
  assert.ok(list.length >= 1);
  for (const p of list) {
    for (const k of Object.keys(p)) {
      assert.ok(svc.SAFE_POST_KEYS.includes(k), `列表出现非白名单字段 ${k}`);
    }
    assert.ok(!JSON.stringify(p).includes("author_id"));
  }
  // closed 帖不进列表
  assert.ok(!svc.listPosts().some((p) => p.post_id === postIdOf("demo-buddy-12")), "closed 帖不该出现在列表");
});

test("§7 · 恋爱匹配需求被拒；照片不进评分也不落库", async () => {
  const romance = await callTool("buddy_publish", {
    author_handle: "同学红线",
    kind: "other",
    text_profile: "想找个女朋友一起去图书馆自习",
  });
  assert.equal(romance.ok, false);
  assert.equal(romance.error.code, "SCHEMA_REJECTED");
  assert.match(romance.error.message, /同伴场景|恋爱/);

  // 照片：传与不传，抽出的画像完全一致
  const withPhoto = await callTool("buddy_publish", {
    author_handle: "同学照片",
    kind: "study",
    text_profile: STUDY_TEXT,
    photo_path: "/tmp/selfie.jpg",
  });
  const noPhoto = await callTool("buddy_publish", {
    author_handle: "同学无照片",
    kind: "study",
    text_profile: STUDY_TEXT,
  });
  assert.equal(withPhoto.ok, true, JSON.stringify(withPhoto.error));
  assert.deepEqual(withPhoto.data.profile, noPhoto.data.profile);
  // 表里根本没有照片列 -> 想存也存不了
  const cols = getDb().prepare("PRAGMA table_info(buddy_posts)").all().map((c) => c.name);
  assert.ok(!cols.some((c) => /photo|image|avatar|pic/i.test(c)));
});

// ──────────────────────────── MCP schema / 参数校验 ────────────────────────────

test("MCP 3 个工具 schema 照抄契约 §4，全部 additionalProperties:false", async () => {
  const schemas = listToolSchemas().filter((t) => t.name.startsWith("buddy_"));
  assert.deepEqual(schemas.map((t) => t.name).sort(), ["buddy_consent", "buddy_publish", "buddy_search"]);
  for (const s of schemas) assert.equal(s.inputSchema.additionalProperties, false);

  const pub = schemas.find((t) => t.name === "buddy_publish").inputSchema;
  assert.deepEqual(Object.keys(pub.properties).sort(), ["author_handle", "kind", "photo_path", "text_profile"]);
  assert.deepEqual([...pub.required].sort(), ["author_handle", "kind", "text_profile"]);
  assert.deepEqual(pub.properties.kind.enum, ["study", "roommate", "project", "sport", "other"]);

  const search = schemas.find((t) => t.name === "buddy_search").inputSchema;
  assert.deepEqual(Object.keys(search.properties).sort(), ["kind", "seeker_handle", "text_profile", "top_k"]);
  assert.deepEqual([...search.required].sort(), ["kind", "seeker_handle", "text_profile"]);
  assert.equal(search.properties.top_k.type, "integer");
  assert.equal(search.properties.top_k.minimum, 1);
  assert.equal(search.properties.top_k.maximum, 20);
  assert.equal(search.properties.top_k.default, 5);

  const consent = schemas.find((t) => t.name === "buddy_consent").inputSchema;
  assert.deepEqual(Object.keys(consent.properties).sort(), ["agree", "post_id", "seeker_handle"]);
  assert.deepEqual([...consent.required].sort(), ["agree", "post_id", "seeker_handle"]);
  assert.equal(consent.properties.agree.type, "boolean");

  // 多余字段 -> SCHEMA_REJECTED（校验器 + handler 两侧都拦）
  assert.equal(validateArgs({ inputSchema: consent }, { post_id: "x", seeker_handle: "y", agree: true, extra: 1 }).valid, false);
  const env = await callTool("buddy_consent", { post_id: "x", seeker_handle: "y", agree: true, extra: 1 });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "SCHEMA_REJECTED");
  // 缺必填
  const missing = await callTool("buddy_publish", { kind: "study", text_profile: STUDY_TEXT });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "SCHEMA_REJECTED");
});

// ──────────────────────────── HTTP API ────────────────────────────

test("HTTP：GET /api/buddies?kind= 与 POST /api/buddies（写接口需 X-Demo-Token）", async () => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = rows();

  try {
    // 读接口开放
    const list = await fetch(`${base}/api/buddies?kind=study`).then((r) => r.json());
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.data) && list.data.length >= 1);
    assert.ok(list.data.every((p) => p.kind === "study"));
    assert.ok(list.data.every((p) => Object.keys(p).every((k) => svc.SAFE_POST_KEYS.includes(k))));
    assert.ok(!JSON.stringify(list.data).includes("user_id"));

    // 写接口：无令牌 401
    const deny = await fetch(`${base}/api/buddies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author_handle: "同学HTTP", kind: "study", text_profile: STUDY_TEXT }),
    });
    assert.equal(deny.status, 401);
    assert.equal(rows(), before, "401 不应写入任何数据");

    // 写接口：带令牌成功
    const created = await fetch(`${base}/api/buddies`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-token": TOKEN },
      body: JSON.stringify({ author_handle: "同学HTTP", kind: "study", text_profile: STUDY_TEXT }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.ok(created.data.post_id);
    assert.match(created.data.anon_token, /^anon_[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(created.data.profile).sort(), [...engine.PROFILE_FIELDS].sort());
    assert.equal(rows(), before + 1);

    // 多余字段 -> SCHEMA_REJECTED
    const extra = await fetch(`${base}/api/buddies`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-token": TOKEN },
      body: JSON.stringify({ author_handle: "同学HTTP", kind: "study", text_profile: STUDY_TEXT, user_id: "x" }),
    }).then((r) => r.json());
    assert.equal(extra.ok, false);
    assert.equal(extra.error.code, "SCHEMA_REJECTED");

    // 只读辅助路由
    const search = await fetch(
      `${base}/api/buddies/search?kind=study&handle=${encodeURIComponent("同学HTTP2")}&text=${encodeURIComponent(STUDY_TEXT)}`,
    ).then((r) => r.json());
    assert.equal(search.ok, true);
    assert.ok(Array.isArray(search.data) && search.data.length >= 1);
    const mine = await fetch(`${base}/api/buddies/mine?handle=${encodeURIComponent("同学HTTP2")}`).then((r) => r.json());
    assert.equal(mine.ok, true);
    assert.deepEqual(mine.data, []);
    assert.equal(rows(), before + 1, "只读路由不应写库");
  } finally {
    server.close();
  }
});

// ──────────────────────────── fixtures 自检 ────────────────────────────

test("fixtures/buddy-posts.json：>=10 条、覆盖 5 种 kind、声明冲突组合真的能识别", () => {
  assert.ok(FIXTURES.posts.length >= 10, `至少 10 条，实得 ${FIXTURES.posts.length}`);
  assert.deepEqual(
    [...new Set(FIXTURES.posts.map((p) => p.kind))].sort(),
    ["other", "project", "roommate", "sport", "study"],
  );
  for (const p of FIXTURES.posts) {
    assert.deepEqual(Object.keys(p.profile).sort(), [...engine.PROFILE_FIELDS].sort(), `${p.id} 画像结构不符`);
    assert.ok(p.profile.wanted, `${p.id} 缺 wanted`);
    assert.ok(p.profile.interests.length <= engine.RULES.max_interests);
    assert.match(p.anon_token, /^anon_[0-9a-f]{12}$/, `${p.id} 的 anon_token 必须是随机 12 位`);
    assert.ok(!p.anon_token.includes(p.author_handle), `${p.id} 的 anon_token 不得含昵称`);
  }
  assert.ok(FIXTURES._conflict_pairs.length >= 2, "至少要构造 2 组语义冲突组合");
  for (const pair of FIXTURES._conflict_pairs) {
    const post = byId(pair.post);
    assert.ok(post, `冲突组合指向的帖不存在: ${pair.post}`);
    const found = engine.findConflicts([pair.seeker_must_have], post.profile.deal_breaker);
    assert.ok(found.length >= 1, `${pair.post} 声明的冲突没被识别：${pair.seeker_must_have}`);
    assert.equal(found[0].theme, pair.theme);
    assert.notEqual(pair.seeker_must_have, post.profile.deal_breaker[0], "冲突必须是语义级的，不是字符串相等");
  }
});
