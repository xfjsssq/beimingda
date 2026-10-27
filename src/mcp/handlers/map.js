/**
 * M3 · MCP 工具注册（map_list_nodes / map_get_node）
 * 由 src/mcp/handlers.js 的 MODULE_REGISTRARS 调用。
 */
import { registerTool } from "../tools.js";
import { listNodes, getNode } from "../../services/map.js";

export function registerMapTools() {
  registerTool(
    "m3",
    {
      name: "map_list_nodes",
      description:
        "列出校园地图节点（宿舍楼/食堂/教学楼/校门/服务设施）。可按 category 过滤。只返回节点名称、类别、位置描述与是否有 360° 实景；不返回距离或步行时间。",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["dorm", "canteen", "teaching", "gate", "service"],
            description: "节点类别，省略则返回全部",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => ({ nodes: listNodes({ category: args.category }) }),
  );

  registerTool(
    "m3",
    {
      name: "map_get_node",
      description:
        "查询单个校园地点的详情（位置描述、周边有什么、是否有 360° 实景）。找不到该节点时返回 NOT_FOUND。",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "节点 id，例如 dorm-12；也可先调用 map_list_nodes 获取" },
        },
        required: ["node_id"],
        additionalProperties: false,
      },
    },
    async (args) => getNode(args.node_id),
  );
}

export default { registerMapTools };
