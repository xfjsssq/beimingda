/** 定位 M1 §7-5 的 reason 求和差异（verifier 诊断脚本） */
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.DB_PATH = path.join(__dirname, "m1-diag.db");
const { matchScore } = await import("../src/engine/match.js");

const now = Math.floor(Date.now() / 1000);
const sumReason = (r) =>
  [...String(r ?? "").matchAll(/\+(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);

let n = 0;
for (let i = 0; i < 400 && n < 6; i += 1) {
  const rf = Math.random() * 10;
  const rm = rf + Math.random() * 10;
  const task = {
    from_building: `B${i % 5}`,
    to_building: `B${(i + 1) % 5}`,
    deadline_ts: now + 60 + (i % 17) * 600,
    reward_min: Math.round(rf * 100) / 100,
    reward_max: Math.round(rm * 100) / 100,
  };
  const runner = {
    reachable_buildings: JSON.stringify([`B${(i + 1) % 5}`, `B${i % 5}`, "BZ"]),
    reward_floor: Math.random() * 12,
    time_windows: JSON.stringify([{ start: now - 300 + (i % 7) * 100, end: now + 120 + (i % 11) * 300 }]),
    active: 1,
  };
  const r = matchScore(task, runner, now);
  if (!r) continue;
  const s = sumReason(r.reason);
  if (s !== r.score) {
    n += 1;
    console.log("---- MISMATCH ----");
    console.log("task   =", JSON.stringify(task));
    console.log("runner =", JSON.stringify({ ...runner, time_windows: JSON.parse(runner.time_windows) }));
    console.log("parts  =", JSON.stringify(r.parts));
    console.log("score  =", r.score, " sum(reason) =", s, " diff =", s - r.score);
    console.log("reason =", r.reason);
  }
}
console.log(`共打印 ${n} 例`);
