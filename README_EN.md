# OpenClaw Token Usage Tool

A standalone token usage statistics and visualization tool for OpenClaw. It parses local session files (JSONL) to provide real-time cost monitoring and data analysis.

## 🌟 Key Features

- **Visual Dashboard (Web UI)**: Dark-themed interface built with Vite + Chart.js.
  - **Comprehensive Stats**: Covers all sessions include active (`.jsonl`), reset (`.jsonl.reset.*`), and archived deleted sessions.
  - **Time Filtering**: Built-in presets (Today, Last 7 Days, This Month, etc.) and custom date ranges.
  - **Provider / Model Filtering**: Filter by a Provider or a specific `provider/model` together with the selected time range. After filtering, **summary cards, all charts, and Session details are recalculated consistently**, while a chip at the top shows that dimension's cost / Tokens / request count for the selected period.
  - **Provider / Model Usage Details**: Aggregate by Provider or Model across Input / Output / Cache Read / Cache Write / Total Tokens, **Cost ($)**, cost share, and request count. Columns are sortable, and clicking any row drills down by applying it as a filter.
  - **Rich Metrics**: Tracks Input/Output Tokens, cost trends, Provider distribution, and Cache (Read/Write) performance. On the home summary row, **Total cost** is the **last** card (after token/cache/session summaries); the daily trend chart can switch between **Token / Cost** views.
  - **UX Enhancements**: Logarithmic scale for Model comparison, and paginated/searchable session details table.
  
- **MCP Server (Model Context Protocol)**:
  - Enables OpenClaw Agents to query their own token consumption directly.
  - Provides 8 tools:
    - Usage queries: `get_total_usage`, `get_usage_by_provider`, `get_usage_by_model`, `list_recent_sessions`, `get_session_stats`
    - Management tools: `get_pricing_config`, `update_pricing_config`, `refresh_stats_cache`
  - MCP tool descriptions are bilingual (Chinese/English); tool names and input field names stay in stable English identifiers.

- **Custom Pricing Configuration**:
  - Configure custom prices per Provider/Model combination (unit **$/M**, per million tokens).
  - **Two-level toggles**: Turn off **Enable custom pricing** globally, or disable a single rule, to switch between **recalculated costs from your custom $/M rates** and **per-message costs embedded in sessions** (`usage.cost`, as produced by OpenClaw).
  - The pricing page includes **OpenClaw built-in prices (reference)** and **Models missing prices (reference)**: both are derived from `agents/main/agent/models.json` under `OPENCLAW_CONFIG_DIR` (default `~/.openclaw`), split by whether input/output rates are present. Each table shows whether a row is already covered by custom rules (including wildcard/regex matches) and lets you copy uncovered keys into “Add price”. **Models actually selectable in OpenClaw** are governed by **`agents.defaults.models`** in `openclaw.json`, which is not the same as the rows listed in these reference tables.
  - The “Add price” area on the pricing page provides a **Fetch reference prices from models.dev** button: it opens a searchable, single-select dialog backed by the public [models.dev](https://models.dev) catalog, and on confirm it **only fills the Input/Output/Cache Read/Cache Write price fields** — it never writes the model key. If any price field already has a value, you can choose **Overwrite all / Fill blanks only / Cancel**. The catalog is cached locally for 24 hours (`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/models-dev-v1.json`); when expired, the last snapshot is shown first while a background refresh runs, and a failed first fetch fails closed with an error. Confirm Provider/Model yourself before saving.
  - Supports 4 price types: Input, Output, Cache Read, Cache Write.
  - Cache prices are optional; when left empty, costs are computed **at the Input list price** (both cache read and cache write traffic use Input $/M; no separate cache rate).
  - Dedicated pricing configuration page with add/edit/delete/reset functionality.
  - **Dynamic config path**: The pricing file (`openclaw-usage-pricing.json`) auto-detects the OpenClaw workspace directory, so it travels with your config across machines.

- **Persistent Incremental Stats Cache**:
  - The page will still request the server, but unchanged sessions and pricing will reuse the persistent cache without reparsing JSONL files.
  - When changes are detected, the last successful result is returned first and only changed files are processed in the background. Normal refresh is incremental; a dropdown action performs a full rebuild.
  - Web and MCP share the same cache strategy. See the [persistent incremental stats cache specification](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md) for the complete design.

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

## 🗄️ Persistent Incremental Cache

- **A request is not a refresh**: The page may call `/api/stats` whenever it opens, but aggregation only runs when session file identities or pricing have changed.
- **Reuse across restarts**: The cache lives at `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json` and is shared by the Web and MCP processes.
- **Incremental updates**: Unchanged files reuse their cached contributions. Only added, modified, or removed files are processed; pricing changes only recalculate costs.
- **Stale while revalidate**: When changes are found, the last successful result is returned first and the page updates automatically after the background refresh completes (`GET /api/stats?fresh=1`).
- **Two manual refresh modes**: Normal refresh is incremental (`GET /api/refresh`). A dropdown “Full rebuild” action bypasses every per-file cache entry (`GET /api/refresh?full=1`).
- **Last-known-good fallback**: Refresh failures or temporary source errors retain the last successful result and mark it `stale` instead of silently replacing it with empty data.
- **No persistent browser cache**: Page reloads continue to read from the server; IndexedDB and LocalStorage are not used to store stats.
- **API `cache` field**: `GET /api/stats` includes top-level `cache.state` (`fresh | refreshing | stale`), `revision`, `sourceId`, and `checkedAt`.
- **MCP**: `refresh_stats_cache` is incremental by default; optional `full: true` performs a full rebuild. Pricing tools do not trigger stats aggregation.

See the [design specification](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md) for behavior, cache structure, and acceptance criteria.

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

### Local quick start (recommended for daily use)

Aligned with the `oc-switch` local workflow: install a thin wrapper once, then start/stop a **single** background Node process from any directory (API + built static frontend together).

```bash
# 1. Install ~/bin/openclaw-usage (use --force if a non-installer script already exists)
./scripts/install-local-launcher.sh

# 2. Explicit frontend build (start does not auto-run npm install / build)
openclaw-usage build

# 3. Start in the background (default http://127.0.0.1:3001; opens the browser on success)
openclaw-usage start

# Common commands
openclaw-usage status
openclaw-usage stop
openclaw-usage start --no-open   # for scripts; skip opening a browser
openclaw-usage help
```

| Item | Path / notes |
|------|----------------|
| Default URL | `http://127.0.0.1:3001` (dashboard `/`, pricing `/pricing.html`) |
| Port | `OPENCLAW_USAGE_PORT` (`1..65535`, default `3001`) |
| Run state | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/serve.json` |
| Lifecycle lock | `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/lifecycle.lock` |
| Background log | `$OPENCLAW_CONFIG_DIR/logs/openclaw-usage/serve.log` (rotated to `serve.log.1` above 5 MiB) |
| Stats cache | `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v1.json` (not deleted by `start`/`stop`) |

See the [local launcher spec](docs/superpowers/specs/2026-08-01-local-launcher-like-oc-switch.md).

#### Troubleshooting (local launcher)

- **`Missing build output`**: run `openclaw-usage build` first.
- **Port in use / `port-conflict`**: default API port is `3001`, same as `npm run dev`. Run `openclaw-usage stop` first, or set a free `OPENCLAW_USAGE_PORT`. Do not run both on the default port at once.
- **`unhealthy`**: managed process is alive but `/api/health` identity does not match. Check the log, then `stop` and `start` again.
- **`stale` / ownership uncertain**: the CLI will **not** signal a suspicious PID. Inspect the process, then retry `stop` or clear state deliberately.
- **After moving the repo**: re-run `./scripts/install-local-launcher.sh` (the wrapper embeds an absolute path).
- **`~/bin` not on PATH**: follow the installer hint to add `$HOME/bin` to your shell profile.

### Development Web dashboard
```bash
npm run dev
```
Visit: `http://127.0.0.1:3000` (Vite; `/api` proxies to `127.0.0.1:3001`).

> ⚠️ Dev mode and the local launcher both default to API port `3001` and **must not run at the same time**. Run `openclaw-usage stop` before `npm run dev`.

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

### MCP Management Tool Examples

> ⚠️ `update_pricing_config` writes to the pricing configuration file. Verify the payload before running it.

- `get_pricing_config`: Read the current pricing config (read-only).
- `update_pricing_config`: Update pricing config (write operation).
- `refresh_stats_cache`: Refreshes the aggregate cache without altering business data. It performs an **incremental refresh by default** (only added/changed session files are reparsed) and accepts `full: true` for a full rebuild.

Example `config` payload for `update_pricing_config` (full config object):

```json
{
  "version": "1.0",
  "enabled": true,
  "updated": "2026-04-20T00:00:00.000Z",
  "pricing": {
    "openai/gpt-4": {
      "input": 30,
      "output": 60,
      "cacheRead": 3,
      "cacheWrite": 6
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
   curl -X POST http://localhost:3001/api/pricing/reset \
     -H "Content-Type: application/json"
   ```

   > Write endpoints (`PUT /api/pricing`, `POST /api/pricing/reset`) require
   > `Content-Type: application/json`. If an `Origin` header is present it must be same-origin
   > or a local loopback origin, otherwise the request is rejected with 403. This blocks other
   > websites from silently changing your local pricing config via cross-site forms.

### Pricing Calculation Rules

- **Price Unit**: $/M (USD per million tokens per field)
- **Calculation Formula**: Cost = (Usage / 1,000,000) × Price
- **Cache prices**: Optional. When left empty there is no separate cache rate; **both cache read and cache write volume are priced at the Input rate** ($/M).
- **Global `enabled`** (optional, defaults to on): When `false`, **all** models use session `usage.cost` (OpenClaw’s per-message cost breakdown); no custom recalculation.
- **Per-rule `pricing[k].enabled`** (optional, defaults to on): When `false`, **only that** `provider/model` uses session `usage.cost`; other models still use custom rates (if global custom pricing is on).
- **Optional Pricing**: Custom $/M applies only when global custom pricing is on, a rule exists for that model, and that rule is enabled; otherwise session `usage.cost` is used.

### Example

Configure pricing for `openai/gpt-4`:
- Input: $30/M
- Output: $60/M
- Cache Read: Left empty (priced at Input $30/M)
- Cache Write: Left empty (priced at Input $30/M)

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
