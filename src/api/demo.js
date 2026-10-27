/**
 * 核心层 · 演示数据入口
 *
 *   GET /api/demo/seed                 幂等灌入演示数据（contracts/core.md §3）
 *   GET /api/demo/seed?reset=1         先清空 demo=1 数据再灌（写操作 → 需 X-Demo-Token）
 *   GET /api/demo/seed?warm=0          跳过热身撮合（默认会热身）
 *
 * ⭐ 为什么这个接口要「热身」：
 *   fixtures 灌进去的只有任务/跑腿者，`matches` 表仍是空的，首页「平均撮合得分」只能显示「—」。
 *   演示/路演现场没人愿意先点一遍「查看匹配」，所以这里顺手给前几个 open 任务各跑一次撮合，
 *   让门户统计开箱即有真实数字（分数来自真正的撮合引擎，不是编的）。
 *   ⚠️ 撮合模块（`src/services/task.js`）属于 M1，模块化分支下可能还没合并进来 ——
 *      这里用动态引入，缺了就当跳过，**核心层不硬依赖任何模块**。
 */
import express from "express";
import { ok } from "../util/envelope.js";
import { requireWriteToken } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { seedAll, counts } from "../services/seed.js";

/** 热身时最多撮合多少个任务（够点亮统计即可，不追求跑满整库） */
const WARM_TASKS = 8;

async function warmMatches() {
  try {
    const svc = await import("../services/task.js");
    const tasks = svc.listOpenTasks({ limit: WARM_TASKS });
    let pushed = 0;
    let tasksMatched = 0;
    for (const t of tasks) {
      const res = svc.matchForTask(t.task_id ?? t.id, { topK: 3 });
      tasksMatched += 1;
      pushed += (res?.matches ?? []).filter((m) => m.pushed).length;
    }
    return { available: true, tasks_matched: tasksMatched, pushed };
  } catch {
    // M1 未合并 / 未实现 —— 静默跳过，接口照常返回
    return { available: false, tasks_matched: 0, pushed: 0, skipped_reason: "撮合模块不可用（M1 未合并）" };
  }
}

export function createDemoRouter() {
  const router = express.Router();

  const run = async (req, res) => {
    const db = getDb();
    const reset = String(req.query.reset ?? "") === "1";
    const warm = String(req.query.warm ?? "1") !== "0";
    const summary = seedAll(db, { reset });
    const warmup = warm ? await warmMatches() : { available: true, tasks_matched: 0, pushed: 0, skipped_reason: "warm=0" };
    res.json(ok({ ...summary, warmup, counts: counts(db) }));
  };

  // 幂等灌入；只有 reset=1 才动数据删除，所以只有这一种情况要求令牌
  router.get("/seed", (req, res, next) => {
    if (String(req.query.reset ?? "") === "1") {
      return requireWriteToken(req, res, () => {
        run(req, res).catch(next);
      });
    }
    return run(req, res).catch(next);
  });

  return router;
}

export default { createDemoRouter };
