import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { aggregateStats } from "./aggregator.js";
import { loadPricingConfig } from "./pricing.js";

// Server instance
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

/**
 * Cache for aggregated data to avoid repeated high-intensity IO
 */
let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

async function getData() {
  const now = Date.now();

  // 检查价格版本是否变化
  const currentPricingVersion = (await loadPricingConfig()).version;
  const cachedPricingVersion = cachedData?.pricingVersion || 'none';

  if (!cachedData ||
      now - lastFetchTime > CACHE_TTL ||
      cachedPricingVersion !== currentPricingVersion) {
    const pricingConfig = await loadPricingConfig();
    cachedData = await aggregateStats(pricingConfig);
    cachedData.pricingVersion = currentPricingVersion;
    lastFetchTime = now;
  }
  return cachedData;
}

// 1. List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_total_usage",
        description: "Get the overall token usage and cost summary for OpenClaw.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_usage_by_provider",
        description: "Get token usage and cost breakdown by LLM provider (e.g., openai, anthropic, minimax).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_usage_by_model",
        description: "Get token usage and cost breakdown by specific models.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_recent_sessions",
        description: "List the most recent conversation sessions with their usage stats.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Number of sessions to return", default: 10 },
          },
        },
      },
      {
        name: "get_session_stats",
        description: "Get detailed usage stats for a specific session ID. The ID is usually a UUID.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "The UUID of the session" },
          },
          required: ["sessionId"],
        },
      },
    ],
  };
});

// 2. Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const data = await getData();

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

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// 3. Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenClaw Usage MCP server running on stdio");
}

main().catch(error => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});
