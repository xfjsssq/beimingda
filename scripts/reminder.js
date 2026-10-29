#!/usr/bin/env node
/**
 * M4 · 定时提醒（由系统 cron / 计划任务每 5 分钟跑一次）
 *
 *   1. 读出今天（Asia/Shanghai）有课、且设了 remind_before 的日程
 *   2. 用 config/periods.json 把 period_start 换算成当天时刻，再减去 remind_before
 *   3. 落在 [now, now + 5min) 的 → 触发
 *   4. 触发结果追加到 data/reminders.jsonl（data/ 已被 .gitignore 覆盖），供上层投递
 *
 * ⛔ 不使用 SSE 长连接（CF 隧道 100 秒硬限制），提醒一律由定时任务触发。
 *
 * 用法：
 *   node scripts/reminder.js            # 正式跑（只输出落在窗口内的）
 *   node scripts/reminder.js --dry-run  # 自测：打印今天每条日程的触发时刻，不写文件
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../src/db/index.js";
import { listReminderCandidates } from "../src/services/schedule.js";
import { nowSec, toIso } from "../src/util/time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TZ = "Asia/Shanghai";
const WINDOW_SEC = 5 * 60;

const DRY_RUN = process.argv.includes("--dry-run");

/** 取指定时区的「日期 / 星期 / 时分」，避免依赖本机时区 */
function shanghaiParts(ts) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((p) => [p.type, p.value]));
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: map[parts.weekday] ?? null,
    hh: parts.hour === "24" ? "00" : parts.hour,
    mm: parts.minute,
  };
}

/** "08:00" → 当天该时刻的时间戳（按 +08:00 解析，不依赖本机时区） */
function tsOfDayTime(date, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const hh = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const ts = Date.parse(`${date}T${hh}:${mm}:00+08:00`);
  return Number.isNaN(ts) ? null : Math.floor(ts / 1000);
}

function loadPeriods() {
  const file = path.join(ROOT, "config", "periods.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const periods = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    periods[String(k)] = v;
  }
  return periods;
}

/**
 * 教学周过滤（可选）：没有学期起始日期时无法判断周次，默认不按 weeks 过滤。
 * 若设置了 WEEK_START_DATE（形如 2026-09-01，且为第 1 周的周一），则按 weeks 过滤。
 */
function weekOf(date, weekStart) {
  if (!weekStart) return null;
  const start = Date.parse(`${weekStart}T00:00:00+08:00`);
  const d = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start) || Number.isNaN(d)) return null;
  return Math.floor((d - start) / (7 * 86400000)) + 1;
}

function inWeeks(weeks, week) {
  if (!weeks || week == null) return true;
  const spec = String(weeks).trim();
  if (!spec) return true;
  for (const part of spec.split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (m) {
      if (week >= Number(m[1]) && week <= Number(m[2])) return true;
      continue;
    }
    if (/^\d+$/.test(seg) && week === Number(seg)) return true;
  }
  return false;
}

function main() {
  const now = DRY_RUN && process.env.REMINDER_NOW ? Number(process.env.REMINDER_NOW) : nowSec();
  const today = shanghaiParts(now);
  const periods = loadPeriods();
  const weekStart = process.env.WEEK_START_DATE || null;
  const week = weekOf(today.date, weekStart);

  const db = getDb();
  const rows = listReminderCandidates(db, today.weekday);

  const computed = [];
  for (const r of rows) {
    const base = periods[String(r.period_start)];
    if (!base) continue; // 节次不在映射表里，跳过
    const startTs = tsOfDayTime(today.date, base);
    if (startTs == null) continue;
    const fireTs = startTs - Number(r.remind_before) * 60;
    computed.push({
      item_id: r.id,
      user_id: r.user_id,
      title: r.title,
      room: r.room,
      weekday: r.weekday,
      period_start: r.period_start,
      remind_before: r.remind_before,
      fire_at: toIso(fireTs),
      fire_ts: fireTs,
      in_weeks: inWeeks(r.weeks, week),
    });
  }

  computed.sort((a, b) => a.fire_ts - b.fire_ts);

  if (DRY_RUN) {
    console.log(`[dry-run] now=${toIso(now)}（${TZ}） 今日 weekday=${today.weekday} 日期=${today.date}`);
    if (!computed.length) console.log("今天没有需要提醒的日程（或均未设 remind_before）");
    for (const c of computed) {
      const hit = c.fire_ts >= now && c.fire_ts < now + WINDOW_SEC;
      console.log(
        `  ${hit ? "★ 本窗口触发" : "      "} ${c.fire_at}  第${c.period_start}节 提前${c.remind_before}分钟  ${c.title}${c.room ? " @ " + c.room : ""}`,
      );
    }
    return;
  }

  const due = computed.filter((c) => c.in_weeks && c.fire_ts >= now && c.fire_ts < now + WINDOW_SEC);
  if (!due.length) {
    console.log(`[reminder] now=${toIso(now)} 窗口内无提醒`);
    return;
  }

  const outDir = path.join(ROOT, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "reminders.jsonl");
  for (const d of due) {
    // ⛔ 只写白名单字段，绝不写任何身份信息
    const line = JSON.stringify({
      item_id: d.item_id,
      user_id: d.user_id,
      title: d.title,
      room: d.room,
      fire_at: d.fire_at,
      queued_at: toIso(now),
    });
    fs.appendFileSync(outFile, line + "\n", "utf8");
    console.log(`[reminder] 触发 ${d.fire_at} ${d.title}${d.room ? " @ " + d.room : ""}`);
  }
  console.log(`[reminder] 本窗口触发 ${due.length} 条，已追加到 data/reminders.jsonl`);
}

main();
