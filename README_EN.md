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

- **Custom Pricing Configuration**:
  - Configure custom prices per Provider/Model combination (per 1M tokens).
  - **Two-level toggles**: Turn off **Enable custom pricing** globally, or disable a single rule, to switch between **recalculated costs from your custom $/1M rates** and **per-message costs embedded in sessions** (`usage.cost`, as produced by OpenClaw).
  - The pricing page includes an **OpenClaw built-in prices (reference)** table: read-only list of models that declare `cost` in `openclaw.json`, to help decide what to override.
  - Supports 4 price types: Input, Output, Cache Read, Cache Write.
  - Cache prices are optional; when left empty, automatically use 10% of Input/Output prices.
  - Dedicated pricing configuration page with add/edit/delete/reset functionality.
  - **Dynamic config path**: The pricing file (`openclaw-usage-pricing.json`) auto-detects the OpenClaw workspace directory, so it travels with your config across machines.

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

## 💰 Custom Pricing Configuration

### Pricing Config File Path

The pricing config file (`openclaw-usage-pricing.json`) uses **dynamic path detection** to follow the OpenClaw workspace directory, ensuring the config travels with your setup across different machines.

#### Path Priority (highest to lowest)

| Priority | Source | Example |
|----------|--------|---------|
| 1️⃣ | `OPENCLAW_DIR` environment variable | `OPENCLAW_DIR=/custom/path` |
| 2️⃣ | `agents.defaults.workspace` in `openclaw.json` | `/Users/gc/gcDora` → stored under `gcDora` dir |
| 3️⃣ | Fallback `~/.openclaw/` | Default fallback |

#### Migration Logic

On startup, the tool automatically handles path compatibility and migration:

1. Reads from the new path (following the OpenClaw workspace directory).
2. If the new path doesn't exist, tries the legacy path `~/.openclaw/openclaw-usage-pricing.json`.
3. If the legacy path exists, automatically copies its content to the new path for seamless migration.
4. If neither path exists, creates an empty config (falls back to OpenClaw built-in pricing).

#### Example

If `openclaw.json` has `"workspace": "/Users/gc/gcDora"`, the pricing config is stored at:

```
/Users/gc/gcDora/openclaw-usage-pricing.json
```

Instead of under `~/.openclaw/`. This keeps the pricing config bound to the OpenClaw workspace, making it easy to manage via dotfiles or share across machines.

### Configuration Methods

1. **Via Web Interface**:
   - Start the service and visit: `http://localhost:3000`
   - Click the "💰 Pricing Config" button in the top-right corner
   - Select a model and enter the price (unit: $ / 1M tokens)
   - Save and changes take effect immediately

2. **Via API**:
   ```bash
   # Get current pricing configuration
   curl http://localhost:3001/api/pricing

   # Update pricing configuration
   curl -X PUT http://localhost:3001/api/pricing \
     -H "Content-Type: application/json" \
     -d '{
       "version": "1.0",
       "updated": "2026-04-12T00:00:00.000Z",
       "pricing": {
         "openai/gpt-4": {
           "input": 30,
           "output": 60,
           "cacheRead": 3,
           "cacheWrite": 6
         }
       }
     }'

   # List models with cost in openclaw.json (joined with current custom rules)
   curl http://localhost:3001/api/openclaw/models

   # Reset to default configuration (use OpenClaw built-in pricing)
   curl -X POST http://localhost:3001/api/pricing/reset
   ```

### Pricing Calculation Rules

- **Price Unit**: Per 1M tokens (e.g., $30/1M input tokens)
- **Calculation Formula**: Cost = (Usage / 1,000,000) × Price
- **Cache Prices**: If left empty, automatically use 10% of Input/Output prices
- **Global `enabled`** (optional, defaults to on): When `false`, **all** models use session `usage.cost` (OpenClaw’s per-message cost breakdown); no custom recalculation.
- **Per-rule `pricing[k].enabled`** (optional, defaults to on): When `false`, **only that** `provider/model` uses session `usage.cost`; other models still use custom rates (if global custom pricing is on).
- **Optional Pricing**: Custom $/1M applies only when global custom pricing is on, a rule exists for that model, and that rule is enabled; otherwise session `usage.cost` is used.

### Example

Configure pricing for `openai/gpt-4`:
- Input: $30/1M
- Output: $60/1M
- Cache Read: Left empty (automatically uses $3/1M)
- Cache Write: Left empty (automatically uses $6/1M)

Using 100,000 input tokens, the cost is calculated as:
- 100,000 / 1,000,000 × 30 = $3

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
