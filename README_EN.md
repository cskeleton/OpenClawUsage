# OpenClaw Token Usage Tool

A standalone token usage statistics and visualization tool for OpenClaw. It parses local session files (JSONL) to provide real-time cost monitoring and data analysis.

## 🌟 Key Features

- **Visual Dashboard (Web UI)**: Dark-themed interface built with Vite + Chart.js.
  - **Comprehensive Stats**: Covers all sessions include active (`.jsonl`), reset (`.jsonl.reset.*`), and archived deleted sessions.
  - **Time Filtering**: Built-in presets (Today, Last 7 Days, This Month, etc.) and custom date ranges.
  - **Rich Metrics**: Tracks Input/Output Tokens, cost trends, Provider distribution, and Cache (Read/Write) performance. On the home summary row, **Total cost** is the **last** card (after token/cache/session summaries).
  - **UX Enhancements**: Logarithmic scale for Model comparison, and paginated/searchable session details table.
  
- **MCP Server (Model Context Protocol)**:
  - Enables OpenClaw Agents to query their own token consumption directly.
  - Provides 5 tools: `get_total_usage`, `get_usage_by_provider`, `get_usage_by_model`, `list_recent_sessions`, `get_session_stats`.

- **Custom Pricing Configuration**:
  - Configure custom prices per Provider/Model combination (unit **$/M**, per million tokens).
  - **Two-level toggles**: Turn off **Enable custom pricing** globally, or disable a single rule, to switch between **recalculated costs from your custom $/M rates** and **per-message costs embedded in sessions** (`usage.cost`, as produced by OpenClaw).
  - The pricing page includes **OpenClaw built-in prices (reference)** and **Models missing prices (reference)**: both are derived from `agents/main/agent/models.json` under `OPENCLAW_CONFIG_DIR` (default `~/.openclaw`), split by whether input/output rates are present. Each table shows whether a row is already covered by custom rules (including wildcard/regex matches) and lets you copy uncovered keys into “Add price”. **Models actually selectable in OpenClaw** are governed by **`agents.defaults.models`** in `openclaw.json`, which is not the same as the rows listed in these reference tables.
  - Supports 4 price types: Input, Output, Cache Read, Cache Write.
  - Cache prices are optional; when left empty, costs are computed **at the Input / Output list price** (read traffic at Input $/M, write traffic at Output $/M; no separate cache rate).
  - Dedicated pricing configuration page with add/edit/delete/reset functionality.
  - **Dynamic config path**: The pricing file (`openclaw-usage-pricing.json`) auto-detects the OpenClaw workspace directory, so it travels with your config across machines.

## 📊 Data Source & Logic

The tool monitors and parses the local OpenClaw persistence directory:

- **Target Path**: `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` (defaults to `~/.openclaw/agents/main/sessions/` when the env var is unset); the same config root as `agents/main/agent/models.json`. **This path is NOT affected by `agents.defaults.workspace`** — workspace only controls where the pricing config file lives (see below).
- **Supported Files** (directory scan is **not recursive** — only top-level files):
  - `*.jsonl`: Currently active session records.
  - `*.jsonl.reset.*`: Archived sessions after a `/reset` command.
  - `*.jsonl.deleted.*`: Archived deleted sessions.
  - `*.checkpoint.*.jsonl`: **Skipped**. Checkpoint content is already captured in the main/reset file; counting both would double the totals.
  - `sessions.json`: Session index and snapshot statistics (not counted toward usage).

- **Data Capture**:
  The tool reads each JSONL file line-by-line, extracting the `usage` field returned by LLM APIs:
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

> ⚠️ The table above applies **only to the pricing config file**. **Sessions and models.json** are always read from `$OPENCLAW_CONFIG_DIR` (default `~/.openclaw`) and do **not** follow the workspace.

#### Model catalog (`models.json`, pricing reference API)

| Variable | Meaning |
|----------|---------|
| `OPENCLAW_CONFIG_DIR` | Config root; defaults to `~/.openclaw` if unset |
| Model list file | `$OPENCLAW_CONFIG_DIR/agents/main/agent/models.json` |

Independent of `OPENCLAW_DIR` (used for pricing file path detection).

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
   - Select a model and enter the price (unit: $/M)
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

   # List models with / without prices from models.json (joined via findMatchingPricing)
   curl http://localhost:3001/api/openclaw/models

   # Reset to default configuration (use OpenClaw built-in pricing)
   curl -X POST http://localhost:3001/api/pricing/reset
   ```

### Pricing Calculation Rules

- **Price Unit**: $/M (USD per million tokens per field)
- **Calculation Formula**: Cost = (Usage / 1,000,000) × Price
- **Cache prices**: If left empty, cache read volume uses the **Input** price and cache write volume uses the **Output** price ($/M).
- **Global `enabled`** (optional, defaults to on): When `false`, **all** models use session `usage.cost` (OpenClaw’s per-message cost breakdown); no custom recalculation.
- **Per-rule `pricing[k].enabled`** (optional, defaults to on): When `false`, **only that** `provider/model` uses session `usage.cost`; other models still use custom rates (if global custom pricing is on).
- **Optional Pricing**: Custom $/M applies only when global custom pricing is on, a rule exists for that model, and that rule is enabled; otherwise session `usage.cost` is used.

### Example

Configure pricing for `openai/gpt-4`:
- Input: $30/M
- Output: $60/M
- Cache Read: Left empty (priced at Input $30/M)
- Cache Write: Left empty (priced at Output $60/M)

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
