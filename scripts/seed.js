#!/usr/bin/env node
/**
 * 演示数据灌入（幂等）—— 命令行壳
 *
 *   npm run seed              幂等灌入（重复执行不报错、不重复插数据、不覆盖已存在记录）
 *   npm run seed -- --reset   先清空全部 demo=1 的数据再灌
 *   npm run seed -- --check   只统计当前库内数据量，不写入
 *
 * ⭐ 实现全部在 `src/services/seed.js`（与 `GET /api/demo/seed` 共用同一份，⛔ 不许各写一份）
 */
import { initDb, getDb, closeDb, dbPath } from "../src/db/index.js";
import { seedAll, counts } from "../src/services/seed.js";

const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const CHECK = args.has("--check");

function main() {
  initDb();
  const db = getDb();

  if (CHECK) {
    console.log("[seed] --check：", JSON.stringify(counts(db), null, 2));
    closeDb();
    return;
  }

  const summary = seedAll(db, { reset: RESET });
  if (RESET) console.log("[seed] --reset：已清空 demo=1 数据");

  console.log(`[seed] db = ${dbPath()}`);
  for (const [k, v] of Object.entries(summary)) {
    if (k === "reset") continue;
    console.log(`[seed] ${k}: fixture 行数 ${v.total ?? v}，新增 ${v.inserted ?? v}`);
  }
  console.log("[seed] 当前库内统计：", JSON.stringify(counts(db), null, 2));
  console.log("[seed] 提示：重复执行不产生重复数据（幂等）");
  closeDb();
}

main();
