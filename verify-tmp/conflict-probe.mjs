/**
 * 冲突规则影响面探针（verifier 自写）：同一组用例，在新旧两棵树上各跑一次再比对
 * 跑法：node verify-tmp/conflict-probe.mjs
 */
const { findConflicts } = await import("../src/engine/buddy.js");

const CASES = [
  // [must_have, deal_breaker, 语义上是否真冲突, 备注]
  [["抽烟"], ["抽烟"], true, "完全同词"],
  [["不抽烟"], ["抽烟"], true, "极性相反但同一要求"],
  [["吸烟"], ["抽烟"], true, "同义词"],
  [["必须抽烟"], ["受不了烟味"], true, "吸烟 vs 受不了烟味"],
  [["希望对方戴耳机"], ["受不了外放打游戏"], true, "安静 vs 外放"],
  [["希望对方爱干净"], ["受不了脏乱"], true, "干净 vs 脏乱"],
  [["早睡早起"], ["不喜欢熬夜"], false, "两者其实一致 → 不该判冲突"],
  [["不要凌晨打电话"], ["凌晨打游戏外放"], false, "两者其实一致（都怕吵）→ 不该判冲突"],
  [["希望安静"], ["安静"], false, "都爱安静 → 不该判冲突"],
  [["希望一起自习"], ["讨厌自习"], true, "自习主题未覆盖 → 看是否漏判"],
  [["爱干净"], ["爱干净"], true, "完全同词（卫生）"],
  [["希望周末有空"], ["周末很忙"], true, "作息相反"],
];

const rows = [];
let falsePositive = 0;
let falseNegative = 0;
for (const [must, deal, shouldConflict, note] of CASES) {
  const got = findConflicts(must, deal).length > 0;
  if (got && !shouldConflict) falsePositive += 1;
  if (!got && shouldConflict) falseNegative += 1;
  rows.push({ must: must[0], deal: deal[0], shouldConflict, got, note });
}
console.log(JSON.stringify({ falsePositive, falseNegative, rows }, null, 1));
process.exit(0);
