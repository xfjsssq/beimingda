/**
 * 跨模块 · MCP 工具注册（app_open_view）
 *
 * 为什么有这一个：
 *   评委把平台接进 WorkBuddy 之后，除了"帮我发个代取"这类动作，还常常需要
 *   "**帮我把某个界面打开**" —— 例如"打开明湖风光的 3D 实景"、"把课表页面打开"。
 *   这个工具不改变任何状态，只把**一个可以直接点的深链**交给对话方（WB 会把它渲染成可点链接）。
 *
 * 口径：
 *   · 只返回本站自己的路径（相对路径 + 依据请求 Host 推出来的绝对地址），⛔ 不返回任何外部地址
 *   · pano 只在 view=welcome 时有意义；给了 pano 就带 ?pano=<sceneId>，打开即自动进入 3D 街景
 *   · 找不到对应场景时如实说明（available_scenes 里列出可用的），⛔ 不假装存在
 */
import { registerTool } from "../tools.js";
import { listNodes, listScenes } from "../../services/map.js";

const VIEWS = {
  welcome: { path: "/welcome", label: "迎新导览 · 校园地图与 3D 街景" },
  takeout: { path: "/takeout", label: "代取看板" },
  buddy: { path: "/buddy", label: "搭子墙" },
  schedule: { path: "/schedule", label: "日程与课表" },
  agent: { path: "/agent", label: "接入说明（评委页）" },
};

export function registerAppTools() {
  registerTool(
    "app",
    {
      name: "app_open_view",
      description:
        "生成一个可以直接打开的站点深链，用来把某个界面（或某处 360° 实景）在浏览器里打开。只读、不改任何状态；" +
        "例如「打开明湖风光的 3D 实景」「把课表页面打开」。返回相对路径 relative_path 与绝对地址 url，对话方直接把 url 给用户点即可。",
      inputSchema: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: Object.keys(VIEWS),
            description: "要打开的界面：welcome=地图与 3D 街景 / takeout=代取看板 / buddy=搭子墙 / schedule=课表 / agent=接入说明",
          },
          pano: {
            type: "string",
            description: "可选：360° 实景的场景 id（仅 view=welcome 有效，例如 pano-3）。省略则只打开地图。",
          },
        },
        required: ["view"],
        additionalProperties: false,
      },
    },
    async (args, ctx = {}) => {
      const view = VIEWS[args.view];
      if (!view) {
        return {
          opened: false,
          reason: `不认识的界面「${args.view || "空"}」`,
          available_views: Object.keys(VIEWS),
        };
      }

      let query = "";
      let panoTitle = null;
      if (args.pano) {
        const scenes = listScenes();
        const hit = scenes.find((s) => s.scene_id === args.pano);
        if (!hit) {
          return {
            opened: false,
            reason: `没有找到实景场景「${args.pano}」`,
            available_scenes: scenes.map((s) => ({ scene_id: s.scene_id, title: s.title })),
          };
        }
        query = `?pano=${encodeURIComponent(hit.scene_id)}`;
        panoTitle = hit.title;
      }

      const relative = `${view.path}${query}`;
      const host = ctx.host || "";
      return {
        opened: true,
        view: args.view,
        label: view.label,
        relative_path: relative,
        url: host ? `http://${host}${relative}` : relative,
        pano: args.pano ?? null,
        pano_title: panoTitle,
        hint: args.pano
          ? `打开后会自动进入「${panoTitle}」的 3D 街景（可左右环视，不带缩放）`
          : "打开后就是该界面；需要某个实景时把 pano 一起给我",
      };
    },
  );
}

export default { registerAppTools };
