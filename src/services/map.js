/**
 * M3 · 地图节点业务层（HTTP API 与 MCP 共用，⛔ 不许各写一份）
 * 契约：contracts/m3-welcome.md §2 / §4 / §5
 */
import { getDb } from "../db/index.js";
import { CODES, reject } from "../util/envelope.js";

const CATEGORIES = ["dorm", "canteen", "teaching", "gate", "service"];

/** MCP map_list_nodes / HTTP GET /api/map/nodes 的公共实现 */
export function listNodes({ category } = {}) {
  const db = getDb();
  if (category != null && category !== "") {
    if (!CATEGORIES.includes(category)) {
      reject(CODES.SCHEMA_REJECTED, `category 非法：${category}（可选 ${CATEGORIES.join("/")}）`);
    }
    return db
      .prepare(
        `SELECT id,label,category,lat,lng,pano_url,desc FROM map_nodes
         WHERE category = ? ORDER BY sort ASC, id ASC`,
      )
      .all(category);
  }
  return db
    .prepare(
      `SELECT id,label,category,lat,lng,pano_url,desc FROM map_nodes ORDER BY sort ASC, id ASC`,
    )
    .all();
}

/** MCP map_get_node 的实现；节点不存在 → NOT_FOUND */
export function getNode(nodeId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id,label,category,lat,lng,pano_url,pano_yaw,desc FROM map_nodes WHERE id = ?`,
    )
    .get(String(nodeId ?? ""));
  if (!row) reject(CODES.NOT_FOUND, `节点不存在：${nodeId}`);
  return {
    id: row.id,
    label: row.label,
    category: row.category,
    lat: row.lat,
    lng: row.lng,
    pano_url: row.pano_url,
    pano_yaw: row.pano_yaw,
    desc: row.desc,
    // 前端友好：明确告知有没有实景，避免"假装有图"
    has_pano: Boolean(row.pano_url),
  };
}

/** 供页面与自检使用：类别与当前实景覆盖情况 */
export function mapSummary() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) n, SUM(CASE WHEN pano_url IS NOT NULL THEN 1 ELSE 0 END) with_pano
       FROM map_nodes GROUP BY category ORDER BY category`,
    )
    .all();
  const total = db.prepare("SELECT COUNT(*) n FROM map_nodes").get().n;
  const withPano = db
    .prepare("SELECT COUNT(*) n FROM map_nodes WHERE pano_url IS NOT NULL")
    .get().n;
  return { total, with_pano: withPano, by_category: rows, categories: CATEGORIES };
}

export default { listNodes, getNode, mapSummary, CATEGORIES };
