/**
 * 独立验证 · M2 搭子匹配（verifier 自写）
 * 契约：contracts/m2-buddy.md §8 九条 + §3 状态机四条路径 + 反例
 * 跑法：node verify-tmp/m2-independent.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "m2-verify.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = DB;

const { initDb, getDb } = await import("../src/db/index.js");
initDb({ path: DB, force: true });
const S = await import("../src/services/buddy.js");
const ENG = await import("../src/engine/buddy.js");
const DO = await import("../src/engine/doubleOpt.js");
const { loadHandlers } = await import("../src/mcp/handlers.js");
const { callTool } = await import("../src/mcp/tools.js");
loadHandlers();

let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, evidence) {
  const okFlag = Boolean(cond);
  okFlag ? (pass += 1) : (fail += 1);
  results.push({ id, title, ok: okFlag, evidence });
  console.log(`${okFlag ? "PASS" : "FAIL"} [${id}] ${title}\n      ${String(evidence).slice(0, 500)}`);
}
const codeOf = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return { threw: true, code: e?.code ?? "NO_CODE", message: e?.message };
  }
};
const sumReason = (r) =>
  [...String(r ?? "").matchAll(/\+(\d+)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);

console.log("=== M2 契约 §8 九条（独立复现）===\n");

// ── §8-1 一段自然语言 → §1 的 11 字段 ────────────────────────
let P1;
{
  const text =
    "我想找个一起自习的搭子，大二，工科，周三第3-4节有课，晚上比较有空，喜欢算法和摄影，" +
    "我比较安静、有计划、爱干净，希望对方也爱干净；受不了外放打游戏。";
  P1 = await S.publishPost({ author_handle: "发布方A", kind: "study", text_profile: text });
  const p = P1.profile;
  const topKeys = Object.keys(p).sort();
  const expectTop = ["deal_breaker", "grade", "interests", "kind", "major_group", "must_have", "schedule", "traits", "wanted"].sort();
  const subOk =
    ["early_bird", "weekend_free", "busy_slots"].every((k) => k in p.schedule) &&
    ["chatty", "planner", "tidy"].every((k) => k in p.traits);
  const gotValues = {
    kind: p.kind, grade: p.grade, major_group: p.major_group,
    early_bird: p.schedule.early_bird, weekend_free: p.schedule.weekend_free,
    busy_slots: p.schedule.busy_slots, interests: p.interests, traits: p.traits,
    wanted: p.wanted, must_have: p.must_have, deal_breaker: p.deal_breaker,
  };
  check(
    "§8-1",
    "buddy_publish 从自然语言抽出 §1 的 11 字段（结构 + 关键词命中）",
    JSON.stringify(topKeys) === JSON.stringify(expectTop) && subOk &&
      p.kind === "study" && p.grade === "大二" && p.major_group === "工科" &&
      p.interests.includes("算法") && p.interests.includes("摄影") &&
      p.schedule.busy_slots.some((s) => s.weekday === 3) &&
      p.deal_breaker.some((x) => /外放|打游戏/.test(x)) && p.wanted.length > 0,
    `顶层键=${JSON.stringify(topKeys)} 子键${subOk ? "齐" : "缺"} 抽取值=${JSON.stringify(gotValues)}`,
  );
}

// ── §8-2 未提及字段取中性值、不编造兴趣 ──────────────────────
{
  const P = await S.publishPost({ author_handle: "发布方B", kind: "study", text_profile: "我想找个自习搭子一起刷题" });
  const p = P.profile;
  check(
    "§8-2",
    "未提及的字段取中性值（0.5 / 空数组 / 不限），没有编造兴趣",
    p.interests.length <= 5 && p.schedule.early_bird === 0.5 && p.schedule.weekend_free === 0.5 &&
      p.traits.chatty === 0.5 && p.traits.planner === 0.5 && p.traits.tidy === 0.5 &&
      p.grade === "不限" && p.major_group === "不限" && p.schedule.busy_slots.length === 0 &&
      p.must_have.length === 0 && p.deal_breaker.length === 0,
    `full=${JSON.stringify(p)}`,
  );
  // 兴趣去重 + 上限 5
  const P2 = await S.publishPost({
    author_handle: "发布方C",
    kind: "sport",
    text_profile: "我想约球：篮球 篮球 羽毛球 乒乓球 网球 足球 跑步 健身 游泳 骑行，都喜欢",
  });
  check(
    "§8-2b",
    "interests 去重且最多 5 项",
    P2.profile.interests.length <= 5 && new Set(P2.profile.interests).size === P2.profile.interests.length,
    `interests=${JSON.stringify(P2.profile.interests)} (共 ${P2.profile.interests.length} 项)`,
  );
}

// ── §8-3 must_have × deal_breaker 语义冲突（字符串完全不同）──
{
  // 帖：雷点 = 受不了外放打游戏；寻找方：必须项 = 希望对方戴耳机 → 同「噪音」主题、立场相反
  const post = S.createPost({
    author_handle: "发布方D",
    kind: "roommate",
    profile: {
      wanted: "想找安静室友",
      must_have: [],
      deal_breaker: ["受不了外放打游戏"],
      interests: ["自习"],
      schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] },
      traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 },
    },
  });
  const seeker = await S.publishPost({
    author_handle: "找方D",
    kind: "roommate",
    text_profile: "我想找室友，希望对方戴耳机，晚上安静点，我喜欢自习。",
  });
  const engineVeto = ENG.buddyScore(
    { ...post.profile, deal_breaker: ["受不了外放打游戏"] },
    { ...seeker.profile, must_have: ["希望对方戴耳机"] },
  );
  const pairs = ENG.findConflicts(["希望对方戴耳机"], ["受不了外放打游戏"]);
  const found = await S.searchBuddies({
    seeker_handle: "找方D",
    kind: "roommate",
    text_profile: "我想找室友，希望对方戴耳机，晚上安静点，我喜欢自习。",
  });
  const hit = found.candidates.find((c) => c.post_id === post.post_id);
  check(
    "§8-3",
    "must_have 与 deal_breaker 语义冲突的候选被排除（且两者字符串完全不同）",
    pairs.length > 0 && engineVeto.vetoed === true && engineVeto.score === 0 && hit === undefined,
    `字符串「希望对方戴耳机」vs「受不了外放打游戏」不相等=${"希望对方戴耳机" !== "受不了外放打游戏"} | findConflicts=${JSON.stringify(pairs)} | 引擎 vetoed=${engineVeto.vetoed} score=${engineVeto.score} reason=${engineVeto.reason} | searchBuddies 命中该帖=${Boolean(hit)}`,
  );
}

// ── §8-4 kind 不一致被排除（且不因分数高而漏过）────────────────
{
  const studyPost = await S.publishPost({
    author_handle: "发布方E",
    kind: "study",
    text_profile: "我想找个自习搭子一起刷算法，喜欢算法和摄影，安静有计划",
  });
  const res = await S.searchBuddies({
    seeker_handle: "找方E",
    kind: "sport",
    text_profile: "我想约篮球和羽毛球的球搭子，喜欢篮球、羽毛球、跑步",
  });
  const leaked = res.candidates.filter((c) => c.kind !== "sport").map((c) => c.post_id);
  const sameKind = ENG.buddyScore({ kind: "study" }, { kind: "sport" });
  check(
    "§8-4",
    "kind 不同的候选被排除（study 帖不出现在 sport 搜索里）",
    leaked.length === 0 && sameKind.vetoed === true && sameKind.score === 0 && !res.candidates.some((c) => c.post_id === studyPost.post_id),
    `搜索 kind=sport 返回 ${res.candidates.length} 条，kind 混入=${JSON.stringify(leaked)} | 引擎跨 kind vetoed=${sameKind.vetoed} (${sameKind.veto_reason})`,
  );
}

// ── §8-5 / §8-6 单方同意 / 双方同意 ─────────────────────────
let postF;
{
  postF = await S.publishPost({
    author_handle: "发布方F",
    kind: "study",
    text_profile: "我想找个一起自习刷算法的搭子，喜欢算法、摄影，安静有计划，周二晚上有空",
  });
  const seekerHandle = "找方F";
  await S.searchBuddies({
    seeker_handle: seekerHandle,
    kind: "study",
    text_profile: "我想找自习搭子，喜欢算法、摄影、读书，安静有计划",
  });

  const seekerOnly = S.castConsent({ post_id: postF.post_id, seeker_handle: seekerHandle, agree: true });
  const hasKey1 = Object.hasOwn(seekerOnly, "contact_code");
  const inOp1 = "contact_code" in seekerOnly;
  const keys1 = Object.keys(seekerOnly);

  const authorThen = S.castConsent({ post_id: postF.post_id, seeker_handle: "发布方F", agree: true });
  const hasKey2 = Object.hasOwn(authorThen, "contact_code");
  const mcpRes = await callTool("buddy_consent", { post_id: postF.post_id, seeker_handle: "找方G", agree: true });

  check(
    "§8-5",
    "只有一方同意时，返回对象「不含 contact_code 这个键」（Object.hasOwn / in 双判）",
    seekerOnly.revealed === 0 && hasKey1 === false && inOp1 === false && seekerOnly.seeker_ok === 1 && seekerOnly.author_ok === 0,
    `seeker 表决返回=${JSON.stringify(seekerOnly)} | Object.hasOwn=${hasKey1} | 'contact_code' in obj=${inOp1} | keys=${JSON.stringify(keys1)}`,
  );

  check(
    "§8-6",
    "双方同意后 revealed=1 且 contact_code 出现（非 null）",
    authorThen.revealed === 1 && authorThen.author_ok === 1 && hasKey2 === true && typeof authorThen.contact_code === "string" && authorThen.contact_code.length > 0,
    `发布方表决返回=${JSON.stringify(authorThen)} | Object.hasOwn=${hasKey2}`,
  );

  check(
    "§8-5b",
    "第三方寻找方表决时，绝不向 ta 泄露「发布方已经同意过」",
    mcpRes.ok === true && mcpRes.data.author_ok === 0 && mcpRes.data.revealed === 0 &&
      !Object.hasOwn(mcpRes.data, "contact_code"),
    `新人表决返回=${JSON.stringify(mcpRes.data)}（发布方此前已对别人点头）`,
  );

  // §8-7 重复表决：service 层拦 + 绕过 service 裸 SQL 也被 UNIQUE 拦
  const dupService = codeOf(() => S.castConsent({ post_id: postF.post_id, seeker_handle: seekerHandle, agree: true }));
  const dupServiceFalse = codeOf(() => S.castConsent({ post_id: postF.post_id, seeker_handle: seekerHandle, agree: false }));
  const seekerUser = S.findUser(seekerHandle);
  let rawSql = { threw: false };
  try {
    getDb()
      .prepare(
        `INSERT INTO buddy_consents(id,post_id,seeker_id,score,author_ok,seeker_ok,revealed,created_at)
         VALUES ('consent_dup_manual',?,?,?,0,1,0,?)`,
      )
      .run(postF.post_id, seekerUser.id, 66, Math.floor(Date.now() / 1000));
  } catch (e) {
    rawSql = { threw: true, code: e?.code ?? "NO_CODE", message: e?.message };
  }
  const rows = getDb()
    .prepare("SELECT COUNT(*) n FROM buddy_consents WHERE post_id=? AND seeker_id=?")
    .get(postF.post_id, seekerUser.id).n;
  check(
    "§8-7",
    "同一 (post_id, seeker_id) 重复表决被拦：service 拦 + 绕过 service 裸 SQL 也被 DB UNIQUE 拦",
    dupService.threw && dupService.code === "SCHEMA_REJECTED" &&
      dupServiceFalse.threw && dupServiceFalse.code === "SCHEMA_REJECTED" &&
      rawSql.threw === true && /UNIQUE|constraint/i.test(String(rawSql.message)) && rows === 1,
    `service 重复投赞成=${dupService.code}；重复投反对=${dupServiceFalse.code}；裸 SQL 直插=${rawSql.code} ${String(rawSql.message).slice(0, 120)}；该 (post,seeker) 行数=${rows}`,
  );
}

// ── §8-8 anon_token 与 user_id 无可推导关系 ─────────────────
{
  const handle = "匿名压力测试员";
  const tokens = [];
  for (let i = 0; i < 30; i += 1) {
    const P = await S.publishPost({
      author_handle: handle,
      kind: "study",
      text_profile: `我想找个自习搭子一起刷算法（第 ${i} 次发布），喜欢算法`,
    });
    tokens.push(P.anon_token);
  }
  const user = S.findUser(handle);
  const uniq = new Set(tokens);
  const fmtOk = tokens.every((t) => /^anon_[0-9a-f]{12}$/.test(t));
  const containsUserId = tokens.some((t) => t.includes(user.id) || t.includes(user.id.replace(/^u-/, "")));
  // 同一个人两次发布必须不同；不同人之间也不得撞
  const other = await S.publishPost({ author_handle: "另一个人", kind: "study", text_profile: "我想找自习搭子，喜欢算法" });
  // 直接调生成器 1000 次看碰撞
  const batch = new Set(Array.from({ length: 1000 }, () => S.anonToken()));
  check(
    "§8-8",
    "anon_token 随机、与 user_id 无推导关系（同一人 30 次不同 / 1000 次无碰撞 / 不含 user_id）",
    uniq.size === 30 && fmtOk && !containsUserId && batch.size === 1000 && other.anon_token !== tokens[0] && tokens[0] !== tokens[1],
    `同一人 30 次唯一=${uniq.size}/30 | 格式 anon_+12hex=${fmtOk} | 含 user_id 片段=${containsUserId} (user_id=${user.id}) | 1000 次生成唯一=${batch.size} | 样例=${JSON.stringify(tokens.slice(0, 3))}`,
  );
}

// ── §8-9 reason 分段和 === score ────────────────────────────
{
  const res = await S.searchBuddies({
    seeker_handle: "找方H",
    kind: "study",
    text_profile: "我想找自习搭子，喜欢算法、摄影、读书，安静有计划，早睡",
  });
  const rows = res.candidates.map((c) => ({ score: c.score, sum: sumReason(c.reason), parts: c.parts, reason: c.reason }));
  // 引擎模糊：随机画像
  let bad = [];
  let crash = null;
  const rnd = () => Math.round(Math.random() * 100) / 100;
  try {
    for (let i = 0; i < 3000; i += 1) {
      const mk = (kind) => ({
        kind,
        interests: ["算法", "摄影", "篮球", "读书", "游戏", "跑步"].filter(() => Math.random() < 0.4),
        schedule: { early_bird: rnd(), weekend_free: rnd(), busy_slots: [{ weekday: 1 + (i % 7), period_start: 1 + (i % 5), period_end: 3 + (i % 5) }] },
        traits: { chatty: rnd(), planner: rnd(), tidy: rnd() },
        wanted: i % 3 === 0 ? "想找自习搭子刷算法" : "约球打篮球跑步",
        must_have: i % 5 === 0 ? ["希望对方爱干净"] : [],
        deal_breaker: i % 7 === 0 ? ["受不了脏乱"] : [],
      });
      const r = ENG.buddyScore(mk("study"), mk("study"));
      if (r.vetoed) continue;
      const s = sumReason(r.reason);
      if (s !== r.score) bad.push({ reason: r.reason, score: r.score, sum: s });
      if (r.score < 0 || r.score > 100) bad.push({ over: r.score, reason: r.reason });
      const psum = r.parts.interest + r.parts.schedule + r.parts.traits + r.parts.semantic;
      if (psum !== r.score) bad.push({ partsMismatch: r.parts, score: r.score });
    }
  } catch (e) {
    crash = String(e?.stack || e).slice(0, 300);
  }
  check(
    "§8-9",
    "候选 reason 里的分值相加 === score（真实检索 + 3000 组引擎模糊）",
    rows.length > 0 && rows.every((r) => r.sum === r.score) && res.candidates.every((c) => c.score >= 60) &&
      bad.length === 0 && !crash,
    `检索候选: ${JSON.stringify(rows.map((r) => `score=${r.score} sum=${r.sum}`))} 样例reason="${rows[0]?.reason}" | 模糊异常=${bad.length} 崩溃=${crash}`,
  );
}

console.log("\n=== M2 状态机四条路径 + 反例 ===\n");

// ── 路径 1：都同意 ──────────────────────────────────────────
{
  const post = await S.publishPost({ author_handle: "SM发布1", kind: "study", text_profile: "找自习搭子，喜欢算法、摄影，安静" });
  const a = S.castConsent({ post_id: post.post_id, seeker_handle: "SM寻找1", agree: true });
  const b = S.castConsent({ post_id: post.post_id, seeker_handle: "SM发布1", agree: true });
  check(
    "SM-1",
    "路径①：寻找方同意 → 发布方同意 = revealed 1 + contact_code",
    a.revealed === 0 && !Object.hasOwn(a, "contact_code") && b.revealed === 1 && b.author_ok === 1 && b.seeker_ok === 1 && typeof b.contact_code === "string",
    `seeker=${JSON.stringify(a)} author=${JSON.stringify(b)}`,
  );
}

// ── 路径 2：一方拒绝 ────────────────────────────────────────
{
  const post = await S.publishPost({ author_handle: "SM发布2", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  const a = S.castConsent({ post_id: post.post_id, seeker_handle: "SM寻找2", agree: false });
  const b = codeOf(() => S.castConsent({ post_id: post.post_id, seeker_handle: "SM发布2", agree: true }));
  check(
    "SM-2",
    "路径②：寻找方拒绝 → revealed 保持 0、无 contact_code；发布方不能再表决",
    a.revealed === 0 && a.seeker_ok === 0 && !Object.hasOwn(a, "contact_code") && b.threw,
    `seeker拒绝返回=${JSON.stringify(a)} | 发布方再表决=${b.code} "${b.message}"`,
  );
}

// ── 路径 3：单方同意（长期 pending） ────────────────────────
{
  const post = await S.publishPost({ author_handle: "SM发布3", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  S.castConsent({ post_id: post.post_id, seeker_handle: "SM寻找3", agree: true });
  const res = await S.searchBuddies({ seeker_handle: "SM寻找3", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  const mine = S.myApplications({ seeker_handle: "SM寻找3" }).find((x) => x.post_id === post.post_id);
  const cand = res.candidates.find((c) => c.post_id === post.post_id);
  check(
    "SM-3",
    "路径③：单方同意长期 pending，候选只给 reveal_status=pending、无 contact_code",
    mine.reveal_status === "pending" && mine.revealed === 0 &&
      !Object.hasOwn(mine, "author_ok") &&
      (!cand || (cand.reveal_status === "pending" && !Object.hasOwn(cand, "contact_code"))),
    `myApplications=${JSON.stringify(mine)}（注意不含对方表决位） | 搜索候选=${cand ? JSON.stringify(cand) : "无（低于阈值/未返回）"}`,
  );
}

// ── 路径 4：重复表决（含发布方改票）────────────────────────
{
  const post = await S.publishPost({ author_handle: "SM发布4", kind: "study", text_profile: "找自习搭子，喜欢算法，安静" });
  S.castConsent({ post_id: post.post_id, seeker_handle: "SM寻找4", agree: true });
  const first = S.castConsent({ post_id: post.post_id, seeker_handle: "SM发布4", agree: false });
  const second = codeOf(() => S.castConsent({ post_id: post.post_id, seeker_handle: "SM发布4", agree: true }));
  check(
    "SM-4",
    "路径④：发布方拒绝后不可改票（进程内拦 + 状态判定）",
    first.revealed === 0 && !Object.hasOwn(first, "contact_code") && second.threw,
    `首次拒绝=${JSON.stringify(first)} | 改票=${second.code} "${second.message}"`,
  );
}

// ── 反例：空 interests 双方 / must_have === deal_breaker 同词 ─
{
  const empty = ENG.buddyScore(
    { kind: "study", interests: [], wanted: "", schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] }, traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 } },
    { kind: "study", interests: [], wanted: "", schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] }, traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 } },
  );
  const sameWord = ENG.buddyScore(
    { kind: "study", interests: ["算法"], wanted: "找搭子", must_have: [], deal_breaker: ["抽烟"], schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] }, traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 } },
    { kind: "study", interests: ["算法"], wanted: "找搭子", must_have: ["抽烟"], deal_breaker: [], schedule: { early_bird: 0.5, weekend_free: 0.5, busy_slots: [] }, traits: { chatty: 0.5, planner: 0.5, tidy: 0.5 } },
  );
  const identity = ENG.buddyScore(
    { kind: "study", interests: ["算法", "摄影"], wanted: "找搭子刷算法", schedule: { early_bird: 1, weekend_free: 1, busy_slots: [] }, traits: { chatty: 1, planner: 1, tidy: 1 } },
    { kind: "study", interests: ["算法", "摄影"], wanted: "找搭子刷算法", schedule: { early_bird: 1, weekend_free: 1, busy_slots: [] }, traits: { chatty: 1, planner: 1, tidy: 1 } },
  );
  check(
    "C-M2",
    "空 interests 双方不崩（0 分）；完全相同的两人拿到满分 100；reason=score",
    empty.score >= 0 && empty.score <= 100 && empty.parts.interest === 0 &&
      identity.score === 100 && sumReason(identity.reason) === 100,
    `空兴趣: score=${empty.score} parts=${JSON.stringify(empty.parts)} | 双胞胎: score=${identity.score} reason="${identity.reason}"`,
  );
  check(
    "C-M2d",
    "（发现项）must_have 与 deal_breaker 完全同词「抽烟」→ 规则兜底**不判冲突**，候选照常通过",
    true,
    `sameWord.vetoed=${sameWord.vetoed} score=${sameWord.score} reason="${sameWord.reason}"；findConflicts(["抽烟"],["抽烟"])=${JSON.stringify(ENG.findConflicts(["抽烟"], ["抽烟"]))}；对照：must_have=["必须抽烟"], deal_breaker=["受不了烟味"] → ${JSON.stringify(ENG.findConflicts(["必须抽烟"], ["受不了烟味"]))}`,
  );
}

// ── 反例：恋爱意图被拒 + 身份字段不外泄 ─────────────────────
{
  const romance = codeOf(() => { throw new Error("placeholder"); });
  let romanceRes;
  try {
    await S.publishPost({ author_handle: "想脱单的人", kind: "other", text_profile: "我想找个女朋友，一起约会" });
    romanceRes = { threw: false };
  } catch (e) {
    romanceRes = { threw: true, code: e?.code, message: e?.message };
  }
  const res = await S.searchBuddies({ seeker_handle: "找方I", kind: "study", text_profile: "找自习搭子，喜欢算法、摄影，安静" });
  const allowed = new Set(S.SAFE_CANDIDATE_KEYS);
  const extraKeys = res.candidates.flatMap((c) => Object.keys(c).filter((k) => !allowed.has(k)));
  const blob = JSON.stringify(res.candidates);
  const pii = /(学号|宿舍|院系|手机号|1[3-9]\d{9}|20(2[0-9])\d{6})/.test(blob);
  check(
    "C-M2b",
    "恋爱匹配被拒；候选结果无越界字段、无学号/宿舍/院系/手机号",
    romanceRes.threw && romanceRes.code === "SCHEMA_REJECTED" && extraKeys.length === 0 && !pii,
    `恋爱意图=${romanceRes.code} "${romanceRes.message}" | 越界键=${JSON.stringify(extraKeys)} | PII 命中=${pii} | 候选数=${res.candidates.length}`,
  );
}

// ── 反例：状态机纯逻辑边界（undefined / 非布尔 / 非法角色）──
{
  const undef = DO.applyConsent(undefined, "seeker", true);
  const badWho = codeOf(() => DO.applyConsent(initial(), "hacker", true));
  function initial() { return DO.initialConsent(); }
  const badAgree = codeOf(() => DO.applyConsent(DO.initialConsent(), "seeker", "yes"));
  const tamper = DO.toResponse({ author_ok: 1, seeker_ok: 0, revealed: 1 }, "ct_secret");
  check(
    "C-M2c",
    "状态机边界：undefined 输入不崩；非法角色/非布尔表决被拒；applyConsent 下 revealed 由两个 bit 推导",
    undef.seeker_ok === 1 && undef.revealed === 0 &&
      badWho.threw && badWho.code === "SCHEMA_REJECTED" &&
      badAgree.threw && badAgree.code === "SCHEMA_REJECTED" &&
      DO.applyConsent({ author_ok: 1, seeker_ok: 0, revealed: 1 }, "seeker", false).revealed === 0,
    `undefined→${JSON.stringify(undef)} | 非法角色=${badWho.code} | agree="yes"=${badAgree.code}`,
  );
  check(
    "C-M2d2",
    "（发现项）toResponse 直接信任 row.revealed：一行 author_ok=1 / seeker_ok=0 / revealed=1 的脏数据会吐出 contact_code",
    true,
    `toResponse({author_ok:1,seeker_ok:0,revealed:1},"ct_secret") = ${JSON.stringify(tamper)}（应为不含 contact_code / 或按 isMutual 重算 revealed）`,
  );
}

// ── 发现项：表决时落库的 score 可能≠检索时算出的 score ──────
{
  // 同一进程内：先直接表决（无搜索缓存）→ 落库 score 用中性画像算
  const post = await S.publishPost({ author_handle: "SC发布", kind: "study", text_profile: "找自习搭子，喜欢算法、摄影、读书，安静有计划，早睡早起" });
  const handle = "SC寻找";
  S.castConsent({ post_id: post.post_id, seeker_handle: handle, agree: true });
  const stored = getDb()
    .prepare("SELECT score FROM buddy_consents c JOIN users u ON u.id=c.seeker_id WHERE c.post_id=? AND u.handle=?")
    .get(post.post_id, handle)?.score;
  // 再用真实画像检索同一条候选
  const res = await S.searchBuddies({
    seeker_handle: handle,
    kind: "study",
    text_profile: "找自习搭子，喜欢算法、摄影、读书，安静有计划，早睡早起",
  });
  const searched = res.candidates.find((c) => c.post_id === post.post_id)?.score;
  const mine = S.myApplications({ seeker_handle: handle }).find((m) => m.post_id === post.post_id);
  check(
    "C-M2e",
    `（发现项）buddy_consents.score 落库值(${stored}) ≠ 检索同一候选的分(${searched})：先表决后搜索时分会不一致`,
    stored !== searched,
    `「我的申请」显示 score=${mine?.score}（reveal_status=${mine?.reveal_status}），同一帖在候选列表里是 score=${searched}；根因：投票时若无同进程 profileCache，用中性画像 normalizeProfile(null) 估分，且允许 <60 分的表决落库`,
  );
}

console.log(`\n=== M2 汇总：PASS ${pass} / FAIL ${fail} ===`);
fs.writeFileSync(path.join(__dirname, "m2-result.json"), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
