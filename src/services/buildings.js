/**
 * 楼栋 / 站点**规范名归一**（M1 共享件）
 *
 * 为什么需要：`config/map-nodes.json` 的 `label` 是撮合算法的唯一口径（可达性 40 分靠字面比对）。
 * 调用方（尤其经 LLM / WorkBuddy 传参）天然会写「12号楼」「12栋」「菜鸟驿站」这类口语写法，
 * 直接入库会导致「发布成功但永远匹配不到」——看起来像引擎坏了。
 *
 * 契约：contracts/m1-takeout.md §1（from_building / to_building / reachable_buildings 用平台规范名）
 *       fixtures/README.md「楼栋规范名必须与 config/map-nodes.json 的 label 字面一致」
 *
 * 处理顺序（⛔ 不许反）：
 *   1) 先归一：口语写法 → 规范名（`12号楼`/`12栋`/`十二号宿舍楼` → `12号宿舍楼`；`菜鸟驿站` → `快递驿站`）
 *   2) 归一失败再拒：`SCHEMA_REJECTED`，message 里**列出可选规范名**，让 Agent 能自我纠正
 *
 * 归一规则是怎么来的（全部由 config 里的规范名**自动派生**，不写死楼栋）：
 *   - 编号 + 宿舍类核心词：`N号宿舍楼 / N号楼 / N栋 / N舍 / N宿舍 / N公寓 / N号`（N 支持阿拉伯数字与中文数字）
 *   - 编号 + 食堂类核心词：`第N食堂 / N食堂 / 第N餐厅 / N餐厅`（所以 `一食堂` 会折到 `第一食堂`）
 *   - 驿站类：`快递驿站 / 菜鸟驿站 / 快递站 / 快递点 / 驿站`
 *   - 门类：`X门 / X大门`
 *   ⚠️ 本校园 config 里只有 `第二食堂`，所以 `一食堂` 归一成 `第一食堂` 后会**因不存在而被拒**，
 *      并在 message 里列出 `第二食堂` 等可选值 —— 这是期望行为（宁可让 Agent 改正，也不匹配到错的楼）。
 *
 * 共用：MCP（task_publish / runner_register / task_list_open）与 HTTP（POST /api/tasks 等）走的是同一套。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, reject } from "../util/envelope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/map-nodes.json");

let nodeCache = null;
let aliasCache = null;

/** 读 config/map-nodes.json（缓存；读失败 → 空数组，归一退化为「只认原文」） */
export function loadMapNodes() {
  if (nodeCache) return nodeCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    nodeCache = Array.isArray(raw?.nodes) ? raw.nodes : [];
  } catch {
    nodeCache = [];
  }
  return nodeCache;
}

/** 全部规范名（可选值清单用） */
export function canonicalLabels() {
  return loadMapNodes().map((n) => String(n.label ?? "")).filter(Boolean);
}

/** 仅 dorm 类规范名（页面下拉、跑腿可达楼栋用） */
export function dormLabels() {
  return loadMapNodes()
    .filter((n) => String(n.category ?? "") === "dorm")
    .map((n) => String(n.label ?? ""))
    .filter(Boolean);
}

// ---------------------------------------------------------------- 中文数字 ↔ 阿拉伯数字

const CN_DIGIT = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_CHARS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

function cnToArabic(token) {
  const s = String(token ?? "");
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  let m = /^([一二两三四五六七八九])十([一二三四五六七八九])?$/.exec(s); // 十二 / 二十三
  if (m) return CN_DIGIT[m[1]] * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (/^[一二两三四五六七八九]$/.test(s)) return CN_DIGIT[s]; // 三
  if (/^[零一二两三四五六七八九]+$/.test(s)) {
    // 逐位读法：「一二」→ 12
    return Number([...s].map((c) => CN_DIGIT[c]).join(""));
  }
  return null;
}

function toCn(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n === 0) return "零";
  if (n < 10) return CN_CHARS[n - 1];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_CHARS[n - 11];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return CN_CHARS[tens - 1] + "十" + (ones ? CN_CHARS[ones - 1] : "");
}

// ---------------------------------------------------------------- 归一与别名

/** 归一：全角→半角、去空白与常见标点、英文小写 */
export function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·.,，。:：、/\\|()（）[\]【】「」《》<>"'"'!！?？~～\-—_]/g, "")
    .toLowerCase();
}

/** 把规范名拆成「编号 + 核心词」（南门/快递驿站 这类没有编号） */
function parseLabel(label) {
  const m = /^第?(\d+|[零一二两三四五六七八九十]+)(.*)$/.exec(label);
  if (!m) return { num: null, rest: label };
  const num = cnToArabic(m[1]);
  if (num == null) return { num: null, rest: label };
  return { num, rest: m[2] };
}

/** 由规范名派生口语别名（不写死任何楼栋，纯规则） */
function aliasesOf(label) {
  const { num, rest } = parseLabel(label);
  const out = new Set([label]);

  if (num != null) {
    const nums = [String(num), toCn(num)];
    if (/食堂|餐厅/.test(rest) || /食堂|餐厅/.test(label)) {
      for (const n of nums) {
        out.add(`第${n}食堂`);
        out.add(`${n}食堂`);
        out.add(`第${n}餐厅`);
        out.add(`${n}餐厅`);
      }
    } else if (/宿舍|公寓|舍|楼|栋|幢|座/.test(rest) || /宿舍|公寓/.test(label)) {
      for (const n of nums) {
        for (const core of ["号宿舍楼", "号宿舍", "号楼", "栋", "幢", "座", "舍", "宿舍", "号公寓", "公寓", "号"]) {
          out.add(`${n}${core}`);
        }
      }
    }
  }

  if (/驿站|快递/.test(label)) {
    for (const a of ["快递驿站", "菜鸟驿站", "驿站", "快递站", "快递点", "快递驿站站"]) out.add(a);
  }
  if (/门$/.test(label)) {
    out.add(label.replace(/门$/, "大门")); // 南门 → 南大门
  }
  return [...out];
}

/** 规范名 → 别名的查找表（norm(alias) -> label） */
function aliasTable() {
  if (aliasCache) return aliasCache;
  const table = new Map();
  for (const label of canonicalLabels()) {
    for (const alias of aliasesOf(label)) {
      const key = normalizeKey(alias);
      if (key && !table.has(key)) table.set(key, label);
    }
  }
  aliasCache = table;
  return table;
}

/** 仅在测试里用：清缓存（config 改了以后） */
export function resetBuildingCache() {
  nodeCache = null;
  aliasCache = null;
}

/**
 * 归一单个楼栋/站点名
 * @returns {string|null} 命中的规范名；归一不出来返回 null
 */
export function normalizeBuildingName(raw) {
  const key = normalizeKey(raw);
  if (!key) return null;
  const table = aliasTable();
  if (table.has(key)) return table.get(key);
  // 二次机会：去掉末尾方位词（「12号宿舍楼东」「南门侧」这类写法）
  const trimmed = key.replace(/[东西南北中]$/, "");
  if (trimmed && table.has(trimmed)) return table.get(trimmed);
  return null;
}

/** 🚫 归一失败 → SCHEMA_REJECTED，message 带可选规范名清单（让 Agent 自我纠正） */
export function rejectBuilding(raw, field = "楼栋") {
  const options = canonicalLabels();
  const shown = String(raw ?? "").trim() || "（空）";
  reject(
    CODES.SCHEMA_REJECTED,
    `未知${field}「${shown}」。可选规范名：${options.length ? options.join("、") : "（config/map-nodes.json 为空）"}`,
  );
}

/** 严格归一：归不出来就拒（from_building / to_building / reachable_buildings 用这个） */
export function canonicalBuildingOrThrow(raw, field = "楼栋") {
  const hit = normalizeBuildingName(raw);
  if (!hit) rejectBuilding(raw, field);
  return hit;
}

/**
 * 宽松归一（快递站名用）：命中规范名就用规范名，否则**保留调用方原文**。
 * 理由：station 不参与可达性打分，过度拒绝只会让 Agent 反复试错；
 *      而楼栋名参与打分，必须严格（见 canonicalBuildingOrThrow）。
 */
export function canonicalStation(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return text;
  return normalizeBuildingName(text) ?? text;
}

/**
 * 批量归一（runner_register.reachable_buildings）：逐项归一 + 去重，任一失败即拒
 * @param {unknown} value
 * @returns {string[]} 规范名数组（保持入参顺序）
 */
export function canonicalBuildingsOrThrow(value) {
  if (!Array.isArray(value)) {
    reject(CODES.SCHEMA_REJECTED, "reachable_buildings 必须是字符串数组（平台规范名）");
  }
  const out = [];
  for (const item of value) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) reject(CODES.SCHEMA_REJECTED, "reachable_buildings 含空楼栋名");
    const canonical = canonicalBuildingOrThrow(name, "楼栋");
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export default {
  loadMapNodes,
  canonicalLabels,
  dormLabels,
  normalizeKey,
  normalizeBuildingName,
  canonicalBuildingOrThrow,
  canonicalBuildingsOrThrow,
  canonicalStation,
  rejectBuilding,
  resetBuildingCache,
};
