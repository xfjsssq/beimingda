/* =============================================================================
   北名大小助手 · MCP 接入配置生成  static/js/mcp-config.js
   契约：contracts/frontend.md §3（/agent 页）、contracts/core.md §鉴权、docs/MCP-TOOLS.md

   为什么单独一个模块：
     /agent 页的核心是"一键复制的 MCP 配置 JSON 必须合法"。
     把生成逻辑抽成纯函数，页面只负责渲染，Node 单测可以直接 import 本模块
     用 JSON.parse 校验复制出来的内容（tests/f0-frontend.test.js）。

   硬规则：
     - 令牌一律写占位符 <DEMO_TOKEN>，⛔ 任何位置都不许出现真实令牌
     - url 用「当前站点」（location.origin）+ /mcp；取不到才退回服务端注入的 window.__SITE_DOMAIN__
       ⛔ 不硬编码任何域名
     - 本模块零依赖、无 CDN、断网可跑
   ============================================================================= */

/** MCP 服务器在配置里的键名（评委在 WorkBuddy 里看到的名字） */
export const MCP_SERVER_KEY = "beimingda";

/** MCP Streamable HTTP 端点路径（冻版：POST /mcp，⛔ 不做本地 stdio） */
export const MCP_PATH = "/mcp";

/** 材料与页面上令牌一律用这个占位符，⛔ 真值不进任何参赛材料 */
export const TOKEN_PLACEHOLDER = "<DEMO_TOKEN>";

/** 令牌能力说明（放在 JSON 旁边） */
export const TOKEN_NOTES = [
  "令牌是<b>只读 + 限频</b>的演示令牌：HTTP 接口 60 次/分钟、MCP 工具 30 次/分钟，且短周期轮换，泄露无风险。",
  "页面上永远只出现占位符 <code class=\"inline\">&lt;DEMO_TOKEN&gt;</code>；真实值只存在于服务端环境变量，由站长单独发给评委。",
  "拿到真令牌后，把配置里的 <code class=\"inline\">&lt;DEMO_TOKEN&gt;</code> 整段替换掉即可。",
];

/** 四步接入指引（contracts/frontend.md §3 区块三，照抄） */
export const SETUP_STEPS = [
  {
    title: "打开配置文件",
    body: "在电脑上打开 <code class=\"inline\">~/.workbuddy/mcp.json</code>（没有这个文件就新建一个）。",
  },
  {
    title: "粘贴配置",
    body: "把上一段 JSON 整段粘进去；如果文件里已经有 <code class=\"inline\">mcpServers</code>，就把 <code class=\"inline\">beimingda</code> 这一项放进那个对象里。",
  },
  {
    title: "重启 WorkBuddy",
    body: "完全退出再打开 WorkBuddy，让连接器重新读取配置。",
  },
  {
    title: "点一次「信任」",
    body: "在 WorkBuddy 的连接器管理页找到 <code class=\"inline\">beimingda</code>，点一次<b>信任</b>；之后就能直接用自然语言操作平台了。",
  },
];

/** 可复制的示例对话（contracts/frontend.md §3 + docs/MCP-TOOLS.md，照抄） */
export const SAMPLE_DIALOGUES = [
  { module: "M1 代取撮合", text: "帮我发个代取，12 号楼取快递送到 15 号楼，今晚 8 点前，报酬 3 到 5 块" },
  { module: "M1 代取撮合", text: "我今晚 6 点到 9 点有空，12 到 16 号楼都能去，报酬 2 块以上就行" },
  { module: "M2 搭子匹配", text: "我想找个一起自习的搭子，大二，工科，晚上比较有空，喜欢算法和摄影" },
  { module: "M3 迎新导览", text: "帮我看看 15 号楼在哪，有实景吗" },
  { module: "M4 日程提醒", text: "周三下午要交实验报告，提前两小时提醒我" },
];

/** 14 个 MCP 工具，按模块分组（与 docs/MCP-TOOLS.md 一一对应） */
export const TOOLS_BY_MODULE = [
  {
    module: "M1 · 代取撮合",
    owner: "feat/m1-takeout",
    count: 5,
    tools: [
      { name: "task_parse_screenshot", desc: "从快递取件截图抽取楼栋/驿站/时间（⛔ 不抽姓名、手机号、运单号，不落盘）" },
      { name: "task_publish", desc: "发布代取任务（报酬区间与截止时间必须合法）" },
      { name: "runner_register", desc: "登记跑腿能力（可达楼栋 / 报酬下限 / 空闲时间窗）" },
      { name: "match_find_for_task", desc: "对任务找候选跑腿者，只回 score ≥ 60 并给出 reason" },
      { name: "task_list_open", desc: "列出当前开放且未过期的代取任务" },
    ],
  },
  {
    module: "M2 · 搭子匹配",
    owner: "feat/m2-buddy",
    count: 3,
    tools: [
      { name: "buddy_publish", desc: "发布搭子帖，服务端抽画像，anon_token 随机生成" },
      { name: "buddy_search", desc: "搜索搭子候选，只回 score ≥ 60，不含任何联系方式" },
      { name: "buddy_consent", desc: "双选表决：双方都点头（revealed=1）才揭示联系方式" },
    ],
  },
  {
    module: "M3 · 迎新导览",
    owner: "feat/m3-welcome",
    count: 2,
    tools: [
      { name: "map_list_nodes", desc: "列出校园地图节点，可按类别过滤" },
      { name: "map_get_node", desc: "取单个节点详情（⛔ 不编造距离与步行时间）" },
    ],
  },
  {
    module: "M4 · 日程与提醒",
    owner: "feat/m4-schedule",
    count: 4,
    tools: [
      { name: "schedule_import", desc: "批量导入课表，只收 6 个白名单匿名字段" },
      { name: "schedule_add", desc: "加一条日程（period_end ≥ period_start）" },
      { name: "schedule_query", desc: "按星期与节次升序查日程" },
      { name: "schedule_remove", desc: "删除一条日程" },
    ],
  },
];

/** 一句话合规声明（contracts/frontend.md §3 区块六） */
export const COMPLIANCE_LINE =
  "不收集身份信息（姓名 / 学号 / 手机号 / 身份证 / 学生证照片 / 校园网账号口令都不收）；" +
  "不接入、不登录、不抓取学校任何内部系统；演示令牌只读 + 限频。";

/** 工具总数（应为 14） */
export function toolCount() {
  return TOOLS_BY_MODULE.reduce((n, g) => n + g.tools.length, 0);
}

/** 扁平的 14 个工具名 */
export function toolNames() {
  return TOOLS_BY_MODULE.flatMap((g) => g.tools.map((t) => t.name));
}

function normOrigin(origin) {
  return typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
}

function normDomain(domain) {
  return typeof domain === "string"
    ? domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
    : "";
}

/**
 * 解析 MCP 端点 URL。
 *   mode="origin"（默认）：`${location.origin}/mcp` —— 页面开到哪，配置就指哪，⛔ 不硬编码域名
 *   mode="site"          ：`https://${window.__SITE_DOMAIN__}/mcp`（服务端 /config.js 注入）
 * 两者都取不到时返回空串（页面会提示，而不是编一个域名出来）。
 * @param {{origin?:string, siteDomain?:string, mode?:string}} [opts]
 */
export function resolveMcpUrl(opts = {}) {
  const mode = opts.mode === "site" ? "site" : "origin";
  const origin = normOrigin(
    opts.origin !== undefined
      ? opts.origin
      : typeof location !== "undefined"
        ? location.origin
        : "",
  );
  const domain = normDomain(
    opts.siteDomain !== undefined
      ? opts.siteDomain
      : typeof window !== "undefined"
        ? window.__SITE_DOMAIN__
        : "",
  );

  if (mode === "site" && domain) return `https://${domain}${MCP_PATH}`;
  if (origin) return `${origin}${MCP_PATH}`;
  if (domain) return `https://${domain}${MCP_PATH}`;
  return "";
}

/**
 * 构造可复制进 ~/.workbuddy/mcp.json 的配置对象。
 * @param {{origin?:string, siteDomain?:string, mode?:string}} [opts]
 */
export function buildMcpConfig(opts = {}) {
  const url = resolveMcpUrl(opts);
  return {
    mcpServers: {
      [MCP_SERVER_KEY]: {
        url,
        headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
      },
    },
  };
}

/**
 * 复制按钮真正的剪贴板内容 —— 必须是合法 JSON。
 * @param {{origin?:string, siteDomain?:string, mode?:string}} [opts]
 * @returns {string}
 */
export function toMcpConfigJson(opts = {}) {
  return JSON.stringify(buildMcpConfig(opts), null, 2);
}

/** 当前环境下的 14 个工具（静态清单；页面可选再用 /mcp tools/list 实时核对） */
export function currentToolNames() {
  return toolNames();
}

export default {
  MCP_SERVER_KEY,
  MCP_PATH,
  TOKEN_PLACEHOLDER,
  TOKEN_NOTES,
  SETUP_STEPS,
  SAMPLE_DIALOGUES,
  TOOLS_BY_MODULE,
  COMPLIANCE_LINE,
  toolCount,
  toolNames,
  resolveMcpUrl,
  buildMcpConfig,
  toMcpConfigJson,
  currentToolNames,
};
