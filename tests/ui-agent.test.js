/**
 * /agent 分栏式接入页 · 静态回归守卫（`npm test` 会跑）
 *
 * 背景：评委核心页原本是「一整串从上到下」（6 个区块全铺开），又长又没层次。
 * 2026-10-28 改成 hero + 三步概览 + 5 个分栏（一键配置 / 手动接入 / 使用示例 /
 * MCP 工具 / 合规声明）。本文件把这些约定用**静态断言**钉死，改页面时坏了立刻红。
 *
 * ⛔ 只读文件、不起服务、不碰真实令牌；行为验证在浏览器走查（截图）里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "static/agent.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static/css/app.css"), "utf8");
const frontendMd = fs.readFileSync(path.join(ROOT, "contracts/frontend.md"), "utf8");
const mcpConfig = await import("../static/js/mcp-config.js");

/** 全部 tab 声明（顺序即页面顺序） */
const TAB_PANELS = ["p-oneclick", "p-manual", "p-examples", "p-tools", "p-compliance"];

/* ------------------------------------------------------------------ 1. 分栏骨架 */
test("/agent：5 个分栏按顺序接在 role=tablist 上，data-panel 与 tabpanel id 一一对应", () => {
  assert.match(html, /<div class="tabs"\s+id="agentTabs"\s+role="tablist"/);

  const tabs = [...html.matchAll(/role="tab"[^>]*data-panel="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, TAB_PANELS, "分栏顺序必须是：一键配置 → 手动接入 → 使用示例 → MCP 工具 → 合规声明");

  // aria-controls 指向的面板必须真的存在，且 role=tabpanel
  for (const id of TAB_PANELS) {
    assert.match(html, new RegExp(`aria-controls="${id}"`), `${id} 的 tab 缺 aria-controls`);
    assert.match(
      html,
      new RegExp(`<section class="tabpanel" id="${id}"[^>]*role="tabpanel"`),
      `缺少 tabpanel #${id}`,
    );
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-labelledby="tab-`), `${id} 缺 aria-labelledby`);
  }
  assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 5, "tabpanel 必须正好 5 个");
});

test("/agent：默认选中「一键配置」，且只有它 aria-selected=true；其余面板初始 hidden", () => {
  const tabTags = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabTags.length, TAB_PANELS.length, "tab 数量与分栏数量不一致");

  const selected = tabTags.filter((t) => /aria-selected="true"/.test(t));
  assert.equal(selected.length, 1, "必须有且只有一个默认选中项");
  assert.match(selected[0], /data-panel="p-oneclick"/, "默认选中项应是一键配置");

  for (const id of TAB_PANELS.slice(1)) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), `非默认面板 #${id} 应带 hidden，避免首屏闪烁`);
  }
});

test("/agent：用共享层的 mountTabs 接线并开 hash 同步（刷新后停在同一栏）", () => {
  assert.match(html, /import\s*\{[^}]*\bmountTabs\b[^}]*\}\s*from\s*"\/js\/ui\.js"/);
  assert.match(html, /mountTabs\(\s*"#agentTabs"\s*,\s*\{[\s\S]{0,120}?syncHash:\s*true/);
  // mountTabs 的 hash 语义（读 hash → 选中该栏 → replaceState 回写）在 ui.js 里
  const ui = fs.readFileSync(path.join(ROOT, "static/js/ui.js"), "utf8");
  assert.match(ui, /export function mountTabs/);
  assert.match(ui, /location\.hash/);
  assert.match(ui, /history\.replaceState/);
  // 浏览器前进/后退（同文档 hash 变化）由共享层负责，页面里不再重复监听一遍
  assert.match(ui, /addEventListener\("hashchange"/);
  assert.ok(!/addEventListener\("hashchange"/.test(html), "页面不该再自己写一遍 hashchange（ui.js 已内置）");
});

/* ------------------------------------------------------------------ 2. Hero + 顶部概览 */
test("/agent：Hero 是 hero--split 双栏（左文字 + 右透明插画），插画不加 box-shadow", () => {
  assert.match(html, /<section class="hero hero--split"/);
  assert.match(html, /class="hero__art"/);
  const art = /<div class="hero__art">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(art, "找不到 hero__art");
  assert.match(art[1], /<img src="\/img\/agent-connect\.png"/, "hero 右侧必须是本地插画 agent-connect.png");
  assert.ok(!/box-shadow/.test(art[1]), "透明 PNG 上不许加 box-shadow（会在透明区留下方块）");
  // 两个按钮 + 一句话
  assert.equal([...html.matchAll(/class="btn btn--(light|outline)"/g)].length, 2, "hero 应有两个按钮");
});

test("/agent：顶部只留 hero + 一条极简三步概览（3 个 icon-tile）", () => {
  const quick = /<section class="quick-steps"[\s\S]*?<\/section>/.exec(html);
  assert.ok(quick, "找不到三步概览区块");
  assert.equal([...quick[0].matchAll(/class="quick-step"/g)].length, 3, "三步概览正好 3 条");
  assert.equal([...quick[0].matchAll(/class="icon-tile"/g)].length, 3, "每条一个 icon-tile 图标");
  // 概览在 tabs 之前（顶部只留这些，其余全进分栏）
  assert.ok(html.indexOf('class="quick-steps"') < html.indexOf('id="agentTabs"'));
});

/* ------------------------------------------------------------------ 3. 图标：不许再有 emoji / 外链 */
test("/agent：图标全部来自本地 vendor/phosphor（emoji 清零，图标文件真实存在）", () => {
  // 只抓「当图标用的 emoji / dingbats」，不误伤中文排版里的箭头与全角符号
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2049}\u{203C}\u{2600}-\u{27BF}\u{2A00}-\u{2BFF}\u{FE0F}]/u;
  assert.ok(!emoji.test(html), "页面里不允许出现 emoji 图标，请用 .icon + vendor/phosphor/icons");

  const names = [...html.matchAll(/--icon:url\(\/vendor\/phosphor\/icons\/([a-z0-9-]+)\.svg\)/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `页面用到的 phosphor 图标太少（${names.length} 处），像是没接图标系统`);
  for (const n of names) {
    assert.ok(
      fs.existsSync(path.join(ROOT, "static/vendor/phosphor/icons", `${n}.svg`)),
      `图标文件不存在：${n}.svg`,
    );
  }
  // 动态渲染的图标也要走 ui.js 的 icon()（它拼的是同一套路径）
  assert.match(html, /from\s*"\/js\/ui\.js"/);
  assert.match(html, /icon\(name,\s*\{\s*size/);
});

test("/agent：零外链（断网可跑）—— 没有外站 src/href，也没有内联 @import", () => {
  const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
  assert.deepEqual(external, [], `引用了外部资源：${external.join(", ")}`);
  assert.ok(!/@import/i.test(html), "页面不该 @import 任何外部样式");
  // 页面内联 style 只做微调，不许出现四位像素固定宽度（375px 会破版）
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, "本页应有页面内 <style> 微调段");
  assert.ok(!/width:\s*\d{4,}px/.test(style[1]), "页面内样式出现固定四位像素宽度");
});

/* ------------------------------------------------------------------ 4. 原有可用功能一个都不能丢 */
test("/agent：保留原有可用功能（复制 / 下载 / 实时核对 / 演示徽章 / 6 个区块锚点）", () => {
  for (const id of ["block1-title", "block2-title", "block3-title", "block4-title", "block5-title", "block6-title"]) {
    assert.match(html, new RegExp(`id="${id}"`), `丢了区块锚点 ${id}`);
  }
  assert.match(html, /id="copy-btn"/);
  assert.match(html, /id="download-btn"/);
  assert.match(html, /id="mcp-json"/);
  assert.match(html, /id="copy-state"/);
  assert.match(html, /id="tools-live"/);
  assert.match(html, /id="tool-count-badge"/);
  assert.match(html, /id="setup-steps"/);
  assert.match(html, /id="dialogues"/);
  assert.ok(!/id="token-notes"/.test(html), "令牌说明列表已按用户要求下线");
  assert.match(html, /id="compliance"/);
  // 复制反馈：文案 + toast
  assert.match(html, /navigator\.clipboard/);
  assert.match(html, /已复制到剪贴板/);
  assert.match(html, /toast\(/);
  // 下载文件名
  assert.match(html, /a\.download = "mcp\.json"/);
  // 实时核对：仍走 /mcp 的 tools/list，并显示「页面宣称 N / 服务端实际 N」
  assert.match(html, /mcpToolNames\(\)/);
  assert.match(html, /tools\/list|MCP_PATH/);
  assert.match(html, /页面宣称 /);
  assert.match(html, /服务端实际 /);
  // 演示模式仍在
  assert.match(html, /from "\/js\/demo\.js"/);
  assert.match(html, /initDemo\(\)/);
});

/* ------------------------------------------------------------------ 5. 分栏内容约定 */
test("/agent：分栏 1/2 用共享层常量渲染（示例与四步指引照抄契约，一字不改）", () => {
  assert.match(html, /SETUP_STEPS/);
  assert.match(html, /SAMPLE_DIALOGUES/);
  assert.match(html, /TOOLS_BY_MODULE/);
  assert.match(html, /COMPLIANCE_LINE/);
  assert.ok(!/TOKEN_NOTES/.test(html), "令牌话术常量已从页面移除");
  assert.match(html, /toMcpConfigJson/);
  assert.match(html, /resolveMcpUrl/);
  assert.equal(mcpConfig.SAMPLE_DIALOGUES.length, 5);
  assert.equal(mcpConfig.SETUP_STEPS.length, 4);

  // 契约 §3 的示例对话代码块 == 前端常量（防"照抄"抄歪）
  const block = /### 示例对话文案（直接照抄）\s*```([\s\S]*?)```/.exec(frontendMd);
  assert.ok(block, "从 contracts/frontend.md 里找不到示例对话代码块");
  assert.deepEqual(
    block[1].trim().split("\n").map((s) => s.trim()),
    mcpConfig.SAMPLE_DIALOGUES.map((d) => d.text),
    "页面展示的示例对话必须与 contracts/frontend.md §3 原文完全一致",
  );
});

test("/agent：分栏 3 的每条示例都标注了模块与真实存在的 MCP 工具名", () => {
  const block = /const TOOLS_FOR_DIALOGUE = (\[[\s\S]*?\]);/.exec(html);
  assert.ok(block, "找不到 示例对话 → MCP 工具 的映射表");
  const mapping = JSON.parse(block[1].replace(/,(\s*[\]}])/g, "$1").replace(/'/g, '"'));
  assert.equal(mapping.length, mcpConfig.SAMPLE_DIALOGUES.length, "映射条数应与示例条数一致");

  const known = new Set(mcpConfig.toolNames());
  const flat = mapping.flat();
  assert.ok(flat.length >= mapping.length, "每条示例至少要挂一个工具");
  for (const t of flat) {
    assert.ok(known.has(t), `示例里标注的工具名 ${t} 不在 14 个工具清单里`);
  }
  // 5 条示例覆盖 4 个模块
  assert.equal(new Set(mcpConfig.SAMPLE_DIALOGUES.map((d) => d.module)).size, 4);
});

test("/agent：分栏 2 的四步是折叠步骤卡（details/summary），不是又一大坨正文", () => {
  assert.match(html, /document\.createElement\("details"\)/);
  assert.match(html, /document\.createElement\("summary"\)/);
  assert.match(html, /fold\.open = true/, "第一步应默认展开，其余收起来");
  assert.match(html, /classList\.add\("fold__chev"\)/);
});

test("/agent：分栏 5 的合规五条都在（身份信息 / 校内系统 / 课表入口 / 脱敏审计 / 写入凭据口径）", () => {
  const panel = /<section class="tabpanel" id="p-compliance"[\s\S]*?<\/section>/.exec(html);
  assert.ok(panel, "找不到合规声明面板");
  const p = panel[0];
  assert.equal([...p.matchAll(/class="rule"/g)].length, 5, "合规声明应是 5 条");
  for (const kw of ["不收集身份信息", "不接学校内部系统", "没有课表上传入口", "脱敏审计只记字段名", "写入凭据口径说清楚"]) {
    assert.ok(p.includes(kw), `合规声明缺「${kw}」`);
  }
  assert.match(p, /scrub_audit/);
  assert.match(p, /&lt;DEMO_TOKEN&gt;/);
});

/* ------------------------------------------------------------------ 6. 移动端与合规红线 */
test("/agent：375px 不破版（分栏单列 + tabs 横向滚动 + 长 JSON 横向滚动）", () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(style, /@media \(max-width: 880px\)[\s\S]*?grid-template-columns: 1fr/);
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?grid-template-columns: 1fr/);
  // tabs 横向滚动由共享层提供
  assert.match(css, /\.tabs\s*\{[\s\S]{0,220}?overflow-x:\s*auto/);
  assert.match(css, /pre\.code\s*\{[\s\S]{0,400}?overflow-x:\s*auto/);
});

test("/agent：合规红线 —— 无文件上传控件、无真实令牌、无真实姓名学号手机号", () => {
  assert.ok(!/type\s*=\s*["']file["']/.test(html), "/agent 不该出现 file 上传控件");
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(html), "不该出现疑似 API key");
  assert.ok(!/1[3-9]\d{9}/.test(html), "不该出现手机号形态的数字");
  const bearers = [...html.matchAll(/Bearer\s+([^\s"'`\\<]+)/g)].map((m) => m[1]);
  for (const b of bearers) assert.equal(b, "&lt;DEMO_TOKEN&gt;", `Bearer 后必须是占位符，实际是 ${b}`);
  // 页面只出现占位符形态
  assert.match(html, /&lt;DEMO_TOKEN&gt;/);
});

/* ------------------------------------------------------------------ 7. 精简：合规只留一处、分栏之间不重复 */
test("/agent：合规的详细说明只集中在「合规声明」分栏，别处不再重复介绍一遍", () => {
  // 剥掉与分栏正文无关的部分：样式 / 脚本 / 注释 / head / tab 标签栏 / 页脚（共享版式）
  const body = html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/g, "")
    .replace(/<div class="tabs"[\s\S]*?<\/div>/, "")
    .replace(/<footer[\s\S]*?<\/footer>/g, "");

  const panel = /<section class="tabpanel" id="p-compliance"[\s\S]*?<\/section>/.exec(body);
  assert.ok(panel, "找不到合规声明分栏");
  const outside = body.replace(panel[0], "");

  // 1) 合规的长句一条都不许出现在别处（重复介绍 = 界面变乱）
  for (const kw of [
    "不收集身份信息",
    "不接学校内部系统",
    "不接入、不登录",
    "没有课表上传入口",
    "脱敏审计只记字段名",
    "限频",
    "泄露无风险",
  ]) {
    assert.ok(!outside.includes(kw), `「${kw}」只该出现在合规声明分栏里，别处不要再介绍一遍`);
  }

  // 2) 别处最多留一句带锚点的指引
  const hits = [...outside.matchAll(/合规/g)];
  assert.ok(hits.length <= 1, `合规声明以外的「合规」字样最多 1 处（带锚点的指引），实际 ${hits.length} 处`);
  if (hits.length === 1) {
    const line = outside.split("\n").find((l) => l.includes("合规"));
    assert.match(line, /href="#p-compliance"/, "唯一那处应是指向合规声明分栏的锚点链接");
  }
});

test("/agent：分栏之间不再互相重复，每栏说明收敛（不再把话堆在一处）", () => {
  // 顶部已有「三步接入概览」，分栏 1 里不再重复一份三步走
  assert.ok(!/id="quick-steps"/.test(html), "分栏 1 里的三步走与顶部概览重复，应已删除");
  assert.ok(!/class="icon-steps"/.test(html), "icon-steps 是重复的三步走样式，应已删除");

  // 手动接入：与四步正文重复的补充卡已删，只留一张卡
  const manual = /<section class="tabpanel" id="p-manual"[\s\S]*?<\/section>/.exec(html);
  assert.ok(manual, "找不到手动接入分栏");
  assert.equal([...manual[0].matchAll(/class="rule"/g)].length, 0, "手动接入不该再有与四步重复的说明卡");
  assert.equal([...manual[0].matchAll(/class="panel-card"/g)].length, 1, "手动接入只保留一张卡");

  // 一键配置：令牌只讲操作性那一条，合规口径回合规栏讲
  assert.ok(!/TOKEN_NOTES/.test(html), "令牌说明整块已下线（用户要求：没什么用）");
  assert.match(html, /id="copy-btn"/, "一键复制按钮必须保留");

  // 每栏的说明段落收敛到 ≤3 段
  for (const id of ["p-oneclick", "p-manual", "p-examples", "p-tools"]) {
    const panel = new RegExp(`<section class="tabpanel" id="${id}"[\\s\\S]*?</section>`).exec(html)[0];
    const notes = [...panel.matchAll(/class="section__note"/g)].length;
    assert.ok(notes <= 3, `${id} 的说明段落有 ${notes} 段，还是太杂`);
  }
});
