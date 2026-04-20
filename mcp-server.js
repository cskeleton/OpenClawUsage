import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  getStats,
  getPricingConfig,
  updatePricingConfig,
  refreshStatsCache,
} from "./stats-service.js";

/**
 * 创建一个配置完成的 MCP Server 实例（不连接 stdio）。
 * 返回的实例带有 `__handlers = { listTools, callTool }`，
 * 这是为测试开的“逃生门”：MCP SDK 未暴露已注册 handler 的公共 API，
 * 因此直接挂在实例上以便单元/集成测试绕过 stdio 传输直接调用。
 */
export function createMcpServer() {
  const server = new Server(
    {
      name: "openclaw-usage-stats",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const listToolsHandler = async () => ({
    tools: [
      {
        name: "get_total_usage",
        description: "获取 OpenClaw 总体 Token 用量与费用汇总 / Get overall OpenClaw token usage and cost summary.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_usage_by_provider",
        description: "按 LLM 提供商查看用量与费用明细 / Get usage and cost breakdown by LLM provider (e.g. openai, anthropic, minimax).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_usage_by_model",
        description: "按具体模型查看用量与费用明细 / Get usage and cost breakdown by specific models.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_recent_sessions",
        description: "列出最近会话及其用量统计 / List the most recent sessions with usage statistics.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Number of sessions to return", default: 10 },
          },
        },
      },
      {
        name: "get_session_stats",
        description: "获取指定会话 ID 的详细用量统计 / Get detailed usage statistics for a specific session ID (usually UUID).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "The UUID of the session" },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_pricing_config",
        description: "读取当前价格配置 / Get current pricing configuration.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "update_pricing_config",
        description: "更新价格配置并失效缓存 / Update pricing configuration and invalidate cached stats.",
        inputSchema: {
          type: "object",
          properties: {
            config: {
              type: "object",
              description: "完整价格配置对象 / Full pricing configuration object",
            },
          },
          required: ["config"],
        },
      },
      {
        name: "refresh_stats_cache",
        description: "主动刷新统计缓存 / Force refresh aggregated stats cache.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  });

  const callToolHandler = async (request) => {
    const { name, arguments: args } = request.params;
    const data = await getStats();

    try {
      switch (name) {
        case "get_total_usage": {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(data.summary, null, 2),
              },
            ],
          };
        }

        case "get_usage_by_provider": {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(data.byProvider, null, 2),
              },
            ],
          };
        }

        case "get_usage_by_model": {
          const sortedModels = Object.values(data.byModel)
            .sort((a, b) => b.totalTokens - a.totalTokens);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(sortedModels, null, 2),
              },
            ],
          };
        }

        case "list_recent_sessions": {
          const limit = args?.limit || 10;
          const recent = data.sessions.slice(0, limit).map(s => ({
            id: s.id,
            status: s.status,
            providers: s.providers,
            models: s.models,
            totalTokens: s.totalTokens,
            totalCost: s.totalCost,
            lastActive: s.lastTimestamp,
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(recent, null, 2),
              },
            ],
          };
        }

        case "get_session_stats": {
          const { sessionId } = args;
          const session = data.sessions.find(s => s.id === sessionId);
          if (!session) {
            return {
              content: [{ type: "text", text: `Session with ID ${sessionId} not found.` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        }
        case "get_pricing_config": {
          const config = await getPricingConfig();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(config, null, 2),
              },
            ],
          };
        }
        case "update_pricing_config": {
          const result = await updatePricingConfig(args.config);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        case "refresh_stats_cache": {
          const result = await refreshStatsCache();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);

  server.__handlers = { listTools: listToolsHandler, callTool: callToolHandler };
  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenClaw Usage MCP server running on stdio");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error in MCP server:", error);
    process.exit(1);
  });
}
