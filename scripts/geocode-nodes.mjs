/**
 * 用高德「Web服务」key 反查校名 + 批量取 12 个点位的真实经纬度（只读探测，不写文件）
 * 用法：node scripts/geocode-nodes.mjs [--write]
 *   --write 才写回 config/map-nodes.json；默认只打印候选与距离，供人工判断
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) throw new Error("缺少 .env");
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const KEY = env.AMAP_WEB_KEY || "";
if (!KEY) throw new Error("AMAP_WEB_KEY 未配置");

const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "map-nodes.json"), "utf8")).nodes;
const bg = JSON.parse(fs.readFileSync(path.join(ROOT, "static", "map", "map-bg.json"), "utf8"));
const CENTER = { lng: bg.amap?.center?.lng ?? 106.107718, lat: bg.amap?.center?.lat ?? 38.497704 };

const haversine = (a, b) => {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
};

const q = async (url) => {
  const r = await fetch(url);
  const j = await r.json();
  if (String(j.status) !== "1") throw new Error(`高德返回异常: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

// 1) 先确认校园中心点到底是什么地方
const regeo = await q(
  `https://restapi.amap.com/v3/geocode/regeo?location=${CENTER.lng},${CENTER.lat}&key=${KEY}&extensions=base`,
);
console.log("[中心点反查]", JSON.stringify(regeo.regeocode?.formatted_address ?? regeo));

const campusKw = process.argv.includes("--campus") ? process.argv[process.argv.indexOf("--campus") + 1] : "北方民族大学";
const rows = [];
for (const n of nodes) {
  const kw = `${campusKw} ${n.label}`;
  const url =
    `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(kw)}` +
    `&city=${encodeURIComponent("银川")}&citylimit=true&offset=5&page=1&extensions=base&key=${KEY}`;
  const j = await q(url);
  const pois = j.pois ?? [];
  // 选离校园中心最近的一个
  let best = null;
  for (const p of pois) {
    const [lng, lat] = String(p.location).split(",").map(Number);
    const dist = haversine(CENTER, { lng, lat });
    if (!best || dist < best.dist) best = { name: p.name, addr: p.address, lng, lat, dist };
  }
  rows.push({ id: n.id, label: n.label, hit: best, poiCount: pois.length });
  await new Promise((r) => setTimeout(r, 250)); // 别把免费额度打太急
}

console.log("\n[批量结果]");
for (const r of rows) {
  if (!r.hit) {
    console.log(`  ${r.id.padEnd(16)} ${r.label.padEnd(10)} ❌ 无结果`);
    continue;
  }
  const flag = r.hit.dist <= 1500 ? "✅" : r.hit.dist <= 4000 ? "⚠️" : "❌";
  console.log(
    `  ${r.id.padEnd(16)} ${r.label.padEnd(10)} ${flag} ${String(r.hit.dist).padStart(5)}m  ` +
      `"${r.hit.name}" @ ${r.hit.lng},${r.hit.lat}  (候选 ${r.poiCount} 条, 地址: ${r.hit.addr || "-"})`,
  );
}

if (process.argv.includes("--write")) {
  const cfgFile = path.join(ROOT, "config", "map-nodes.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  let changed = 0;
  for (const n of cfg.nodes) {
    const r = rows.find((x) => x.id === n.id);
    if (r?.hit && r.hit.dist <= 1500) {
      n.lat = r.hit.lat;
      n.lng = r.hit.lng;
      changed += 1;
    }
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\n[写入] config/map-nodes.json 更新 ${changed} 个点位（仅 ≤1500m 的）`);
}
