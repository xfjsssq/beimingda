/**
 * 数据库连接与初始化（冻版）
 *   - better-sqlite3，同步 API，单连接
 *   - 启动时自动执行 schema.sql（幂等：schema 里全是 IF NOT EXISTS）
 *   - PRAGMA foreign_keys = ON
 * ⛔ DB 文件受 .gitignore 保护，永远不许提交进仓库。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

const DEFAULT_DB_PATH = "./data/beimingda.db";

let db = null;

export function dbPath() {
  return process.env.DB_PATH || DEFAULT_DB_PATH;
}

export function initDb(options = {}) {
  if (db && !options.force) return db;

  const file = options.path || dbPath();
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  ensureColumns(conn);   // 老库补新列

  if (options.force) {
    db = conn;
    return db;
  }
  db = conn;
  return db;
}

/** 老库兼容：schema 里新增的列在既有库上补一遍（SQLite 没有 IF NOT EXISTS 的 ADD COLUMN） */
function ensureColumns(conn) {
  const want = [["tasks", "photo", "TEXT"], ["matches", "source", "TEXT NOT NULL DEFAULT 'engine'"]];
  for (const [table, col, type] of want) {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

export function getDb() {
  if (!db) initDb();
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** 事务包裹（better-sqlite3 的 transaction 语法糖） */
export function tx(fn) {
  return getDb().transaction(fn);
}

export default { initDb, getDb, closeDb, dbPath, tx };
