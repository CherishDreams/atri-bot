/**
 * MCP 测试用的 stdio 桩服务器：一个**标准的** MCP 实现（SDK 的底层 Server）。
 *
 * 放在 test/fixtures/ 而不是临时目录：ESM 的依赖解析按脚本位置向上找
 * node_modules —— 仓库内的路径能解析到 `@modelcontextprotocol/sdk`，/tmp 下的
 * 临时脚本解析不到。用底层 Server 而不是 McpServer 门面，是因为门面的
 * inputSchema 绑定 zod，而 zod 只是 SDK 的传递依赖（本仓不直接依赖它）。
 *
 * 提供三颗工具：
 * - `echo`：原样返回输入（正常调用路径）。
 * - `boom`：isError: true（远端报错的回喂路径）。
 * - `大写工具`：名字拼不出合法工具 id（应被客户端跳过并 warn）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stub", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "原样返回输入",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    { name: "boom", description: "总是报错", inputSchema: { type: "object", properties: {} } },
    {
      name: "大写工具",
      description: "名字拼不出合法 id",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "echo") {
    const text = (request.params.arguments ?? {}).text;
    return { content: [{ type: "text", text: `回声:${String(text)}` }] };
  }
  if (name === "boom") {
    return { content: [{ type: "text", text: "炸了" }], isError: true };
  }
  return { content: [] };
});

await server.connect(new StdioServerTransport());
