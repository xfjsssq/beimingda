/**
 * 搭子匹配引擎（M2）
 *
 *   ⭐ 契约：contracts/m2-buddy.md §1（画像 schema）/ §2（评分 35/30/20/15，阈值 60）
 *
 *   本文件是**纯引擎**：不碰数据库、不碰 HTTP、不写业务落库。
 *   落库与身份解析在 src/services/buddy.js。
 *
 *   ── LLM 与降级（重要）────────────────────────────────────────────
 *   .env 里配了 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 时：
 *     · 画像抽取  -> 调模型（严格输出 §1 结构）
 *     · 语义 15 分 -> 调模型给契合度 0..1
 *     · 一票否决  -> 调模型做语义冲突判断（不是字符串相等）
 *   未配置 key 时：以上三处走**规则化兜底**（关键词/同义词表/二元组 Jaccard/编辑距离），
 *     是**降级实现，不是删掉这一项** —— 语义 15 分照常参与评分。
 *
 *   ── 红线 ────────────────────────────────────────────────────────
 *   · 照片不进评分（本文件根本没有照片入参）
 *   · 未提及的可选字段取中性值，绝不编造兴趣/性格（LLM 路径也用文本 grounding 过滤）
 *   · 不承接恋爱匹配需求（assertCompanionScope）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, reject } from "../util/envelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ──────────────────────────── 冻版常量 ────────────────────────────

export const KINDS = Object.freeze(["study", "roommate", "project", "sport", "other"]);
export const GRADES = Object.freeze(["大一", "大二", "大三", "大四", "研一", "研二", "不限"]);
export const MAJOR_GROUPS = Object.freeze(["工科", "理科", "文科", "经管", "艺术", "不限"]);

/** 契约 §2 的权重与阈值（config/match-rules.json 里的 buddy 段必须与之一致） */
export const FROZEN_WEIGHTS = Object.freeze({
  interest: 35,
  schedule: 30,
  traits: 20,
  semantic: 15,
  threshold: 60,
  max_interests: 5,
});

const NEUTRAL = 0.5;

function loadBuddyRules() {
  const fallback = { ...FROZEN_WEIGHTS };
  try {
    const file = path.join(ROOT, "config", "match-rules.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const b = parsed?.buddy ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      interest: num(b.interest, fallback.interest),
      schedule: num(b.schedule, fallback.schedule),
      traits: num(b.traits, fallback.traits),
      semantic: num(b.semantic, fallback.semantic),
      threshold: num(b.threshold, fallback.threshold),
      max_interests: num(b.max_interests, fallback.max_interests),
    };
  } catch {
    return fallback;
  }
}

export const RULES = Object.freeze(loadBuddyRules());
export const THRESHOLD = RULES.threshold;

export function weightsMatchFrozen() {
  const k = Object.keys(FROZEN_WEIGHTS);
  return k.every((key) => RULES[key] === FROZEN_WEIGHTS[key]);
}

/** 画像的 9 个顶层键（字段名照抄契约 §1，⛔ 不得增删改） */
export const PROFILE_FIELDS = Object.freeze([
  "kind",
  "grade",
  "major_group",
  "schedule",
  "interests",
  "traits",
  "wanted",
  "must_have",
  "deal_breaker",
]);

// ──────────────────────────── 小工具 ────────────────────────────

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function num01(v, dflt = NEUTRAL) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return clamp01(n);
}

function asStr(v, max = 200) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, max);
}

function strList(v, maxItems = 6) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = asStr(item, 60);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 去标点、全角转半角、压空白（用于关键词/相似度匹配） */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef.,!?;:'"()[\]{}<>~`@#$%^&*_+=|\\/—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 中文停用字（只用于切词噪音抑制；不参与语义判定） */
const STOP_CHARS = new Set(
  [..."的了是在我有想找要好个和与或就都也还很没不别太会能可对把被让给来去啊呀吧呢吗你他她它们这那什么一二三"].values(),
);

/** 切词：ASCII 词 + 中文二元组（去掉停用字后） */
export function tokenize(text) {
  const t = normalizeText(text);
  const out = new Set();
  for (const w of t.match(/[a-z0-9]+/g) || []) out.add(w);
  for (const run of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    const chars = [...run].filter((c) => !STOP_CHARS.has(c));
    if (chars.length === 1) out.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

export function jaccard(setA, setB) {
  if (!setA?.size || !setB?.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export function levenshtein(a, b) {
  const s = String(a ?? "").slice(0, 200);
  const t = String(b ?? "").slice(0, 200);
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[t.length];
}

// ──────────────────────────── 兴趣词典 / 同义词表（规则化兜底用） ────────────────────────────

/** 规范兴趣名 -> 同义/近义写法（出现任一项即视为命中该兴趣） */
const INTEREST_LEXICON = {
  算法: ["算法", "刷题", "刷算法", "力扣", "leetcode", "oj", "题解", "acm", "icpc", "竞赛题"],
  编程: ["编程", "写代码", "代码", "开发", "coding", "java", "python", "c++", "前端", "后端", "全栈"],
  数学建模: ["数学建模", "建模", "美赛", "国赛", "mcm"],
  考研: ["考研", "上岸", "备考", "二战"],
  保研: ["保研", "推免"],
  英语: ["英语", "四六级", "六级", "雅思", "托福", "背单词", "口语", "gre"],
  摄影: ["摄影", "拍照", "相机", "扫街", "写真", "修图"],
  篮球: ["篮球", "打球", "约球", "nba", "cba"],
  羽毛球: ["羽毛球", "羽球", "打球", "约球"],
  乒乓球: ["乒乓球", "乒乓"],
  网球: ["网球"],
  足球: ["足球", "踢球"],
  跑步: ["跑步", "夜跑", "晨跑", "慢跑", "马拉松", "跑量"],
  健身: ["健身", "撸铁", "健身房", "增肌", "减脂"],
  游泳: ["游泳"],
  骑行: ["骑行", "自行车", "公路车"],
  游戏: ["游戏", "开黑", "王者", "lol", "原神", "吃鸡", "联机", "csgo"],
  音乐: ["音乐", "唱歌", "吉他", "钢琴", "乐队", "livehouse"],
  电影: ["电影", "看片", "影迷", "院线"],
  读书: ["读书", "看书", "阅读", "书单"],
  桌游: ["桌游", "剧本杀", "狼人杀", "boardgame", "德州"],
  动漫: ["动漫", "二次元", "番剧", "acg", "cos"],
  旅行: ["旅行", "旅游", "出去玩", "citywalk", "徒步", "露营"],
  咖啡: ["咖啡", "手冲", "探店"],
  自习: ["自习", "图书馆", "泡馆", "晚自习", "刷馆"],
  早起: ["早起", "晨读", "早八"],
  志愿: ["志愿", "公益", "支教"],
  辩论: ["辩论", "演讲"],
  舞蹈: ["舞蹈", "跳舞", "街舞", "爵士"],
  滑板: ["滑板", "长板"],
  书法: ["书法", "练字", "写字"],
  实习: ["实习", "暑期实习", "秋招", "找工作", "简历"],
  剪辑: ["剪辑", "视频", "b站", "up主", "自媒体", "vlog"],
  棋类: ["象棋", "围棋", "国际象棋", "下棋"],
  手工: ["手工", "粘土", "模型", "拼装"],
};

const ALIAS_TO_CANON = (() => {
  const m = new Map();
  for (const [canon, aliases] of Object.entries(INTEREST_LEXICON)) {
    for (const a of aliases) m.set(a, canon);
  }
  return m;
})();

/** 文本里命中的规范兴趣（顺序稳定、去重、⛔ 只来自文本，不编造） */
export function interestHits(text) {
  const t = normalizeText(text);
  if (!t) return [];
  const out = [];
  for (const [canon, aliases] of Object.entries(INTEREST_LEXICON)) {
    if (aliases.some((a) => t.includes(a))) out.push(canon);
  }
  return out;
}

/** 一个兴趣标签的"规范名"（无法归一化时返回原标签） */
export function canonOf(label) {
  const s = asStr(label, 30);
  if (!s) return "";
  return ALIAS_TO_CANON.get(s) || ALIAS_TO_CANON.get(normalizeText(s)) || s;
}

// ──────────────────────────── 语义 15 分：规则化兜底 ────────────────────────────

/**
 * 规则化语义相似度（0..1）—— 无 LLM key 时的**降级实现**。
 *
 *   0.45 * 二元组/词 Jaccard（整体用词重合）
 * + 0.40 * 兴趣关键词包含度（同一话题的强信号）
 * + 0.15 * 归一化编辑距离相似度（语序/措辞差异容忍）
 */
export function semanticSimilarity(textA, textB) {
  const a = normalizeText(textA);
  const b = normalizeText(textB);
  if (!a || !b) return 0;

  const j = jaccard(tokenize(a), tokenize(b));

  const ka = new Set(interestHits(a));
  const kb = new Set(interestHits(b));
  let k = 0;
  if (ka.size && kb.size) {
    let inter = 0;
    for (const x of ka) if (kb.has(x)) inter += 1;
    k = inter / Math.min(ka.size, kb.size);
  }

  const e = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return clamp01(0.45 * j + 0.4 * k + 0.15 * clamp01(e));
}

// ──────────────────────────── 一票否决：语义冲突 ────────────────────────────

/**
 * 冲突主题表（规则化兜底）—— 契约 §2 要求"语义判断，不是字符串相等"，配了 key 走模型，
 * 没配 key 就用这张表：**同一主题** + 下面任一条件才算冲突，避免"作息一致 vs 凌晨外放"这类假冲突。
 *   a) 任一侧含禁止/厌恶语义（不/别/受不了/讨厌/反感/雷/最怕/拒绝/勿/禁…）
 *   b) 两侧分别落在该主题的反义立场上（安静 ↔ 外放；早睡 ↔ 熬夜…）
 */
const NEG_MARK = /不|别|勿|禁|没|无|避免|拒绝|受不了|讨厌|反感|雷|最怕|无法|免/;

const CONFLICT_THEMES = [
  { name: "抽烟", re: /抽烟|吸烟|烟味|香烟|电子烟|二手烟|吞云吐雾/ },
  {
    name: "噪音",
    re: /吵|闹|外放|音响|音量|大声|喧哗|蹦迪|唱歌|乐器|弹琴|连麦|语音通话|开黑|打游戏|戴耳机|静音|安静|静一点/,
    pos: /安静|静音|戴耳机|小声|别太吵|静一点/,
    opp: /外放|吵|闹|大声|音响|音量|喧哗|蹦迪|连麦|语音外放/,
  },
  {
    name: "作息灯光",
    re: /熬夜|通宵|凌晨|半夜|晚睡|早睡|早起|作息|关灯|开灯|晚归|夜不归宿|午睡|午休/,
    pos: /早睡|早起|作息规律|早睡早起|按时关灯|午休/,
    opp: /熬夜|通宵|凌晨|半夜|晚睡|开灯看书|晚归|夜不归宿/,
  },
  {
    name: "卫生整洁",
    re: /卫生|打扫|收拾|整洁|干净|乱|脏|垃圾|洗碗|洗衣|异味|清洁|值日/,
    pos: /干净|整洁|打扫|收拾|讲卫生|爱干净|值日/,
    opp: /乱|脏|垃圾|异味|不打扫|不收拾/,
  },
  { name: "宠物", re: /宠物|养猫|养狗|毛|过敏/ },
  { name: "访客留宿", re: /访客|过夜|留宿|带人|朋友来|外人/ },
  { name: "气味与饮食", re: /香水|气味|味道|螺蛳粉|泡面|外卖|做饭|油烟|吃辣|饮食/ },
  { name: "游戏习惯", re: /游戏|开黑|联机|组队|打排位/ },
  { name: "费用与空调", re: /水电费|分摊|aa制|费用|空调|温度/ },
];

/** 找出必须项与雷点之间的冲突对（规则化兜底） */
export function findConflicts(mustHave, dealBreaker) {
  const mh = strList(mustHave, 8);
  const db = strList(dealBreaker, 8);
  const out = [];
  for (const m of mh) {
    const mn = normalizeText(m);
    for (const d of db) {
      const dn = normalizeText(d);
      const theme = CONFLICT_THEMES.find((t) => t.re.test(mn) && t.re.test(dn));
      if (!theme) continue;
      const polarity =
        NEG_MARK.test(mn) || NEG_MARK.test(dn) ||
        (theme.pos && theme.opp &&
          ((theme.pos.test(mn) && theme.opp.test(dn)) || (theme.opp.test(mn) && theme.pos.test(dn))));
      if (polarity) out.push({ must: m, deal: d, theme: theme.name });
    }
  }
  return out;
}

// ──────────────────────────── 恋爱红线（契约 §7） ────────────────────────────

const ROMANCE_PATTERNS = [
  /找(一?[个位名])?(男|女)?朋友/,
  /(男|女)友/,
  /相亲/,
  /脱单/,
  /恋爱/,
  /处对象/,
  /征婚/,
  /约会/,
  /情侣/,
  /暧昧/,
  /找对象/,
  /cpdd/i,
];

/** 本模块只做同伴场景；命中恋爱/相亲意图直接 SCHEMA_REJECTED（契约 §7 明令） */
export function assertCompanionScope(text) {
  const t = normalizeText(text);
  const hit = ROMANCE_PATTERNS.find((re) => re.test(t));
  if (hit) {
    reject(
      CODES.SCHEMA_REJECTED,
      "本模块只做同伴场景（学习 / 室友 / 项目 / 运动 / 其他），不承接恋爱匹配需求",
    );
  }
}

// ──────────────────────────── 画像归一化（§1 的 11 字段结构） ────────────────────────────

function normSlots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const weekday = Math.round(Number(s.weekday));
    let a = Math.round(Number(s.period_start));
    let b = Math.round(Number(s.period_end));
    if (!Number.isFinite(weekday) || weekday < 1 || weekday > 7) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a > b) [a, b] = [b, a];
    a = clamp(a, 1, 12);
    b = clamp(b, 1, 12);
    const key = `${weekday}:${a}-${b}`;
    if (out.some((x) => `${x.weekday}:${x.period_start}-${x.period_end}` === key)) continue;
    out.push({ weekday, period_start: a, period_end: b });
    if (out.length >= 12) break;
  }
  return out;
}

/** 把任意来源的画像收敛成严格 §1 结构（缺啥取中性值，绝不编造） */
export function normalizeProfile(raw, fallbackKind) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sch = r.schedule && typeof r.schedule === "object" ? r.schedule : {};
  const tr = r.traits && typeof r.traits === "object" ? r.traits : {};
  const kind = KINDS.includes(r.kind) ? r.kind : KINDS.includes(fallbackKind) ? fallbackKind : "other";

  const interests = [];
  if (Array.isArray(r.interests)) {
    for (const it of r.interests) {
      const s = asStr(it, 20);
      if (!s) continue;
      if (interests.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
      interests.push(s);
      if (interests.length >= RULES.max_interests) break;
    }
  }

  return {
    kind,
    grade: GRADES.includes(r.grade) ? r.grade : "不限",
    major_group: MAJOR_GROUPS.includes(r.major_group) ? r.major_group : "不限",
    schedule: {
      early_bird: num01(sch.early_bird),
      weekend_free: num01(sch.weekend_free),
      busy_slots: normSlots(sch.busy_slots),
    },
    interests,
    traits: {
      chatty: num01(tr.chatty),
      planner: num01(tr.planner),
      tidy: num01(tr.tidy),
    },
    wanted: asStr(r.wanted, 200),
    must_have: strList(r.must_have, 6),
    deal_breaker: strList(r.deal_breaker, 6),
  };
}

// ──────────────────────────── 规则化画像抽取（无 key 的降级实现） ────────────────────────────

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const cnNum = (s) => (/^\d+$/.test(s) ? Number(s) : CN_NUM[s] ?? null);

function detectGrade(t) {
  if (/研一/.test(t)) return "研一";
  if (/研二|研三/.test(t)) return "研二";
  if (/大五|大四/.test(t)) return "大四";
  if (/大三/.test(t)) return "大三";
  if (/大二/.test(t)) return "大二";
  if (/大一/.test(t)) return "大一";
  return "不限";
}

function detectMajorGroup(t) {
  const groups = [
    ["工科", /工科|计算机|软件|机械|电子|自动化|土木|材料|电气|人工智能|计科|智科/],
    ["理科", /理科|数学|物理|化学|生物|统计|地理/],
    ["文科", /文科|中文|历史|哲学|外语|英语|法学|新闻|汉语言|传播/],
    ["经管", /经管|经济|金融|管理|会计|工商|市场|财会/],
    ["艺术", /艺术|设计|音乐|美术|传媒|表演|视传|工业设计/],
  ];
  for (const [name, re] of groups) if (re.test(t)) return name;
  return "不限";
}

function detectEarlyBird(t) {
  if (/早睡早起|作息规律|早睡|早起|晨跑|晨读|不熬夜|睡得很早/.test(t)) return 0.85;
  if (/夜猫|熬夜|通宵|晚睡|凌晨|半夜|两三点睡|2点睡|3点睡|death ?line|ddl/.test(t)) return 0.2;
  return NEUTRAL;
}

function detectWeekendFree(t) {
  if (/周末.{0,4}(有课|满课|忙|没空|要打工|要兼职|要值班)|周末不空/.test(t)) return 0.15;
  if (/周末.{0,4}(空|闲|自由|有空|没事)|周末两天都空|周末全空/.test(t)) return 0.85;
  return NEUTRAL;
}

function detectBusySlots(raw) {
  const out = [];
  const push = (weekday, a, b) => {
    if (!weekday || !a || !b) return;
    out.push({
      weekday,
      period_start: Math.min(a, b),
      period_end: Math.max(a, b),
    });
  };

  const reRange = /周\s*([一二三四五六日天1-7])\s*(?:第)?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[-~～到至]\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*节?/g;
  for (const m of String(raw ?? "").matchAll(reRange)) {
    const wd = WEEKDAY[m[1]] ?? Number(m[1]);
    push(wd, cnNum(m[2]), cnNum(m[3]));
  }
  const reSingle = /周\s*([一二三四五六日天1-7])\s*第?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*节/g;
  for (const m of String(raw ?? "").matchAll(reSingle)) {
    const wd = WEEKDAY[m[1]] ?? Number(m[1]);
    const p = cnNum(m[2]);
    push(wd, p, p);
  }
  return normSlots(out);
}

const TRAIT_LEX = {
  chatty: {
    low: /安静|话少|内向|社恐|i人|不爱说话|独来独往|别太吵/,
    high: /话多|话痨|能聊|爱聊|健谈|外向|e人|自来熟|聊天/,
  },
  planner: {
    low: /随性|随意|佛系|灵活|差不多就行|不计划|看心情/,
    high: /有计划|计划控|规划|打卡|条理|规律|日程表|待办|提前安排/,
  },
  tidy: {
    low: /邋遢|不拘小节|不太讲究|随便放|乱一点/,
    high: /洁癖|爱干净|整洁|收拾|讲卫生|整齐|打扫/,
  },
};

function detectTraits(t) {
  const one = (lex) => {
    if (lex.low.test(t)) return 0.25;
    if (lex.high.test(t)) return 0.8;
    return NEUTRAL;
  };
  return {
    chatty: one(TRAIT_LEX.chatty),
    planner: one(TRAIT_LEX.planner),
    tidy: one(TRAIT_LEX.tidy),
  };
}

const SENT_SPLIT = /[。！？!?；;\n]+/;

function sentences(raw) {
  return String(raw ?? "")
    .split(SENT_SPLIT)
    .map((s) => asStr(s, 120))
    .filter(Boolean);
}

function detectWanted(raw) {
  const all = sentences(raw);
  const chosen = all.filter((s) => /想找|希望|求|一起|搭子|约|找人|寻/.test(s)).slice(0, 2);
  const text = (chosen.length ? chosen.join("；") : all.join("；")) || asStr(raw, 200);
  return asStr(text, 200);
}

const MUST_MARK = /必须|要求|希望对方|最好|一定要|请|需要对方|不接受|不能接受/;
const BREAK_MARK = /受不了|讨厌|反感|最怕|雷|不要|不许|拒绝|不能|无法忍受/;

function detectHardRules(raw) {
  const must = [];
  const deal = [];
  for (const s of sentences(raw)) {
    if (BREAK_MARK.test(s)) {
      if (!deal.includes(s)) deal.push(s);
    } else if (MUST_MARK.test(s)) {
      if (!must.includes(s)) must.push(s);
    }
    if (must.length >= 6 && deal.length >= 6) break;
  }
  return { must_have: must.slice(0, 6), deal_breaker: deal.slice(0, 6) };
}

/** 规则化抽取（无 LLM key 时的降级实现） */
export function extractProfileRules(text, kind) {
  const raw = String(text ?? "");
  const t = normalizeText(raw);
  const hard = detectHardRules(raw);
  const profile = {
    kind: KINDS.includes(kind) ? kind : "other",
    grade: detectGrade(t),
    major_group: detectMajorGroup(t),
    schedule: {
      early_bird: detectEarlyBird(t),
      weekend_free: detectWeekendFree(t),
      busy_slots: detectBusySlots(raw),
    },
    interests: interestHits(t).slice(0, RULES.max_interests),
    traits: detectTraits(t),
    wanted: detectWanted(raw),
    must_have: hard.must_have,
    deal_breaker: hard.deal_breaker,
  };
  return normalizeProfile(profile, profile.kind);
}

// ──────────────────────────── LLM（配了 key 才走） ────────────────────────────

export function llmConfig() {
  const base = String(process.env.LLM_BASE_URL || "").trim();
  const key = String(process.env.LLM_API_KEY || "").trim();
  const model = String(process.env.LLM_MODEL || "").trim();
  if (!base || !key || !model) return null;
  return {
    base: base.replace(/\/+$/, ""),
    key,
    model,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 8000),
  };
}

export function llmEnabled() {
  return llmConfig() !== null;
}

/** OpenAI 兼容 /chat/completions，返回解析后的 JSON 对象；任何异常都返回 null（调用方回退规则化） */
async function llmJson(systemPrompt, userPrompt) {
  const cfg = llmConfig();
  if (!cfg) return null;
  try {
    const body = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (process.env.LLM_JSON_MODE !== "0") body.response_format = { type: "json_object" };

    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型未返回 JSON");
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.warn(`[buddy] LLM 调用失败，回退规则化兜底：${e?.message || e}`);
    return null;
  }
}

const EXTRACT_SYSTEM = [
  "你是校园「搭子」画像抽取器，只处理同伴场景（学习/室友/项目/运动/其他）。",
  "只输出一个 JSON 对象，字段固定：",
  '{"kind":"study|roommate|project|sport|other","grade":"大一|大二|大三|大四|研一|研二|不限",',
  '"major_group":"工科|理科|文科|经管|艺术|不限",',
  '"schedule":{"early_bird":0到1,"weekend_free":0到1,"busy_slots":[{"weekday":1到7,"period_start":1到12,"period_end":1到12}]},',
  '"interests":["最多5项"],"traits":{"chatty":0到1,"planner":0到1,"tidy":0到1},',
  '"wanted":"一句话期望","must_have":["硬性要求"],"deal_breaker":["雷点"]}',
  "规则：只填用户明确提到的；未提及的一律取中性值（数值 0.5、数组 []、枚举「不限」）；",
  "⛔ 绝不编造用户没说的兴趣或性格；⛔ 不要输出姓名/学号/院系全名/班级/宿舍号/电话号码。",
  '若用户是恋爱、相亲、脱单类需求，输出 {"unsupported":"romance"}。',
].join("\n");

/** 有 key 时的模型抽取；模型失败或返回非法结构 -> 回退规则化（返回 null 表示需要回退） */
export async function extractProfileLLM(text, kind) {
  const parsed = await llmJson(
    EXTRACT_SYSTEM,
    `类型倾向：${kind}\n用户原文：${String(text ?? "").slice(0, 1200)}`,
  );
  if (!parsed) return null;
  if (parsed.unsupported === "romance") {
    reject(
      CODES.SCHEMA_REJECTED,
      "本模块只做同伴场景（学习 / 室友 / 项目 / 运动 / 其他），不承接恋爱匹配需求",
    );
  }
  const profile = normalizeProfile({ ...parsed, kind: KINDS.includes(parsed.kind) ? parsed.kind : kind }, kind);
  return groundInterests(profile, text);
}

/** 文本 grounding：模型给的兴趣必须在原文里能找到依据，找不到就丢掉（⛔ 不编造兴趣） */
export function groundInterests(profile, text) {
  const t = normalizeText(text);
  const allowed = new Set(interestHits(t));
  const kept = profile.interests.filter((label) => {
    const canon = canonOf(label);
    return allowed.has(canon) || t.includes(normalizeText(label));
  });
  return { ...profile, interests: kept.slice(0, RULES.max_interests) };
}

/** 画像抽取统一入口：有 key 走模型，无 key（或失败）走规则化兜底 */
export async function extractProfile(text, kind) {
  assertCompanionScope(text);
  const body = asStr(text, 1200);
  if (!body) reject(CODES.SCHEMA_REJECTED, "text_profile 不能为空：请说清类型/年级/作息/兴趣/期望");
  if (!KINDS.includes(kind)) {
    reject(CODES.SCHEMA_REJECTED, `kind 必须是 ${KINDS.join(" / ")} 之一`);
  }

  if (llmEnabled()) {
    const viaLlm = await extractProfileLLM(body, kind);
    if (viaLlm) return viaLlm;
  }
  return extractProfileRules(body, kind);
}

/** 语义契合度：有 key 走模型，无 key 走规则化兜底 */
export async function semanticFit(textA, textB, opts = {}) {
  if (llmEnabled()) {
    const parsed = await llmJson(
      '你是文本契合度评估器。只输出 JSON：{"fit":0到1之间的小数}，表示两段「想找的搭子」描述的契合程度。',
      `A：${asStr(textA, 300)}\nB：${asStr(textB, 300)}`,
    );
    const fit = Number(parsed?.fit);
    if (Number.isFinite(fit)) return clamp01(fit);
    if (!opts.allowFallback) return semanticSimilarity(textA, textB);
  }
  return semanticSimilarity(textA, textB);
}

/** 语义冲突判定：有 key 走模型，无 key 走主题表兜底 */
export async function semanticConflicts(mustHave, dealBreaker) {
  const mh = strList(mustHave, 8);
  const db = strList(dealBreaker, 8);
  if (!mh.length || !db.length) return [];

  if (llmEnabled()) {
    const parsed = await llmJson(
      "判断两组短语之间是否存在语义冲突：同一件被禁止的行为/习惯，即使措辞完全不同也算冲突。" +
        '只输出 JSON：{"conflicts":[{"must":"...","deal":"...","theme":"简短主题"}]}，无冲突返回 {"conflicts":[]}。',
      `A（必须项）：${JSON.stringify(mh)}\nB（雷点）：${JSON.stringify(db)}`,
    );
    if (parsed && Array.isArray(parsed.conflicts)) {
      return parsed.conflicts
        .map((c) => ({ must: asStr(c?.must, 60), deal: asStr(c?.deal, 60), theme: asStr(c?.theme, 20) }))
        .filter((c) => c.must && c.deal);
    }
  }
  return findConflicts(mh, db);
}

// ──────────────────────────── ⭐ 评分（契约 §2，权重冻版） ────────────────────────────

function slotConflict(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x.weekday === y.weekday && x.period_start <= y.period_end && y.period_start <= x.period_end) {
        return { weekday: x.weekday, period_start: Math.max(x.period_start, y.period_start), period_end: Math.min(x.period_end, y.period_end) };
      }
    }
  }
  return null;
}

function vetoedResult(reason) {
  return {
    score: 0,
    vetoed: true,
    veto_reason: reason,
    parts: { interest: 0, schedule: 0, traits: 0, semantic: 0 },
    reason: `一票否决：${reason}（总分 0）`,
  };
}

/**
 * 匹配评分：buddyScore(post.profile, seeker.profile) -> 0..100
 *
 * 同步纯函数：LLM 相关的语义分 / 冲突判定由调用方通过 opts 传进来
 * （opts.semantic: 0..1；opts.conflicts: [{must,deal,theme}]；不传则用规则化兜底）。
 */
export function buddyScore(postProfile, seekerProfile, opts = {}) {
  const post = normalizeProfile(postProfile);
  const seeker = normalizeProfile(seekerProfile);

  // ---------- 一票否决 ----------
  if (post.kind !== seeker.kind) {
    return vetoedResult(`kind 不一致（帖:${post.kind} / 我:${seeker.kind}）`);
  }
  const conflicts = Array.isArray(opts.conflicts)
    ? opts.conflicts
    : findConflicts(seeker.must_have, post.deal_breaker);
  if (conflicts.length) {
    const pairs = conflicts.map((c) => `「${c.must}」×「${c.deal}」(主题:${c.theme || "语义"})`).join("；");
    return vetoedResult(`硬性要求与对方雷点冲突：${pairs}`);
  }

  // ---------- 兴趣 35：Jaccard ----------
  const shared = post.interests.filter((x) => seeker.interests.includes(x));
  const sInterest = jaccard(new Set(post.interests), new Set(seeker.interests)) * RULES.interest;

  // ---------- 作息 30 ----------
  const dEarly = Math.abs(post.schedule.early_bird - seeker.schedule.early_bird);
  const dWeekend = Math.abs(post.schedule.weekend_free - seeker.schedule.weekend_free);
  const slot = slotConflict(post.schedule.busy_slots, seeker.schedule.busy_slots);
  const penalty = (dEarly / 2) * 0.4 + (dWeekend / 2) * 0.4 + (slot ? 0.2 : 0);
  const sSchedule = (1 - penalty) * RULES.schedule;

  // ---------- 性格 20 ----------
  const dChatty = post.traits.chatty - seeker.traits.chatty;
  const dPlanner = post.traits.planner - seeker.traits.planner;
  const dTidy = post.traits.tidy - seeker.traits.tidy;
  const d = Math.sqrt(dChatty ** 2 + dPlanner ** 2 + dTidy ** 2) / Math.sqrt(3);
  const sTraits = (1 - d) * RULES.traits;

  // ---------- 语义 15 ----------
  const sem = typeof opts.semantic === "number" ? clamp01(opts.semantic) : semanticSimilarity(post.wanted, seeker.wanted);
  const sSemantic = sem * RULES.semantic;

  // 四段各取整后求和 —— 保证「reason 里分值相加 === score」
  const parts = {
    interest: clamp(Math.round(sInterest), 0, RULES.interest),
    schedule: clamp(Math.round(sSchedule), 0, RULES.schedule),
    traits: clamp(Math.round(sTraits), 0, RULES.traits),
    semantic: clamp(Math.round(sSemantic), 0, RULES.semantic),
  };
  const score = parts.interest + parts.schedule + parts.traits + parts.semantic;

  const interestTxt = shared.length ? `共同兴趣 ${shared.length} 项(${shared.join("/")})` : "无共同兴趣";
  const scheduleTxt = slot
    ? `作息有冲突(周${slot.weekday} 第${slot.period_start}-${slot.period_end}节)`
    : dEarly + dWeekend <= 0.4
      ? "作息接近"
      : "作息差异";
  const traitTxt = d <= 0.35 ? "性格接近" : "性格互补";
  const reason =
    `${interestTxt} +${parts.interest}；${scheduleTxt} +${parts.schedule}；` +
    `${traitTxt} +${parts.traits}；期望契合 +${parts.semantic}（总分 ${score}）`;

  return { score, vetoed: false, veto_reason: null, parts, reason, semantic: sem };
}

/** 异步评分：有 LLM key 时用模型做语义 15 分与冲突判定，否则等价于 buddyScore（规则化兜底） */
export async function scoreCandidate(postProfile, seekerProfile) {
  const post = normalizeProfile(postProfile);
  const seeker = normalizeProfile(seekerProfile);
  if (!llmEnabled() || post.kind !== seeker.kind) return buddyScore(post, seeker);

  const [semantic, conflicts] = await Promise.all([
    semanticFit(post.wanted, seeker.wanted),
    semanticConflicts(seeker.must_have, post.deal_breaker),
  ]);
  return buddyScore(post, seeker, { semantic, conflicts });
}

/** 是否达到阈值（=60） */
export function meetsThreshold(score) {
  return Number(score) >= THRESHOLD;
}

/** 反向校验：reason 里的 +N 相加是否等于 score（自检用） */
export function reasonSumsToScore(reason, score) {
  const nums = [...String(reason ?? "").matchAll(/\+(\d+)/g)].map((m) => Number(m[1]));
  return nums.length > 0 && nums.reduce((a, b) => a + b, 0) === Number(score);
}

export default {
  KINDS,
  GRADES,
  MAJOR_GROUPS,
  RULES,
  THRESHOLD,
  FROZEN_WEIGHTS,
  PROFILE_FIELDS,
  normalizeProfile,
  extractProfile,
  extractProfileRules,
  extractProfileLLM,
  scoreCandidate,
  buddyScore,
  semanticSimilarity,
  semanticFit,
  semanticConflicts,
  findConflicts,
  assertCompanionScope,
  interestHits,
  meetsThreshold,
  reasonSumsToScore,
  llmEnabled,
  llmConfig,
};
