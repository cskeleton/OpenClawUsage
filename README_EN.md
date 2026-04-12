# OpenClaw Token Usage Tool

A standalone token usage statistics and visualization tool for OpenClaw. It parses local session files (JSONL) to provide real-time cost monitoring and data analysis.

## 🌟 Key Features

- **Visual Dashboard (Web UI)**: Dark-themed interface built with Vite + Chart.js.
  - **Comprehensive Stats**: Covers all sessions include active (`.jsonl`), reset (`.jsonl.reset.*`), and archived deleted sessions.
  - **Time Filtering**: Built-in presets (Today, Last 7 Days, This Month, etc.) and custom date ranges.
  - **Rich Metrics**: Tracks Input/Output Tokens, cost trends, Provider distribution, and Cache (Read/Write) performance.
  - **UX Enhancements**: Logarithmic scale for Model comparison, and paginated/searchable session details table.
  
- **MCP Server (Model Context Protocol)**:
  - Enables OpenClaw Agents to query their own token consumption directly.
  - Provides 5 core tools: `get_total_usage`, `get_usage_by_model`, `list_recent_sessions`, etc.

## 📊 Data Source & Logic

The tool monitors and parses the local OpenClaw persistence directory:

- **Target Path**: `~/.openclaw/agents/main/sessions/`
- **Supported Files**:
  - `*.jsonl`: Currently active session records.
  - `*.jsonl.reset.*`: Archived sessions after a `/reset` command.
  - `*.jsonl.deleted.*`: Archived deleted sessions.
  - `sessions.json`: Session index and snapshot statistics.

- **Data Capture**:
  It recursively reads the `usage` field returned by LLM APIs in JSONL files:
  ```json
  {
    "usage": {
      "input": 41, "output": 66, "cacheRead": 0, "cacheWrite": 19934,
      "totalTokens": 20041,
      "cost": { "input": 1.23e-05, "output": 7.92e-05, "total": 0.00757 }
    },
    "provider": "minimax-portal", "model": "MiniMax-M2.7"
  }
  ```

## 🚀 Quick Start

### Prerequisites
- Node.js (v18+ recommended)
- An active OpenClaw instance with session data

### Installation
```bash
git clone <repository-url>
cd OpenClawUsage
npm install
```

### Run Web Dashboard
```bash
npm run dev
```
Visit: `http://localhost:3000`

### Run MCP Server (Stdio)
```bash
npm run mcp
```

## 🛠️ MCP Configuration Example

Add the following to your OpenClaw or Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "openclaw-usage": {
      "command": "node",
      "args": ["/Users/gc/Dev/MyProject/OpenClawUsage/mcp-server.js"]
    }
  }
}
```

## 📜 License

```
            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                    Version 2, December 2004

 Copyright (C) 2004 Sam Hocevar <sam@hocevar.net>

 Everyone is permitted to copy and distribute verbatim or modified
 copies of this license document, and changing it is allowed as long
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. You just DO WHAT THE FUCK YOU WANT TO.
```
