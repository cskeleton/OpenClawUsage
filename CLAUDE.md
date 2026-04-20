# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClawUsage is a token usage statistics and visualization tool for OpenClaw. It parses local session files from `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` (defaulting to `~/.openclaw/agents/main/sessions/`) to provide real-time cost monitoring and data analysis through a web dashboard and MCP server.

## Commands

### Development
- `npm run dev` - Start both the Express API server (port 3001) and Vite dev server (port 3000)
- `npm run server` - Run only the Express API server
- `npm run build` - Build the frontend with Vite
- `npm run preview` - Preview the production build

### MCP Server
- `npm run mcp` - Run the MCP server in stdio mode

## Architecture

### Core Components

1. **aggregator.js** - Shared data processing engine
   - Scans `$OPENCLAW_CONFIG_DIR/agents/main/sessions/` via `getSessionDir()` (delegates to `openclaw-config.js`)
   - Parses JSONL files (`.jsonl`, `.jsonl.reset.*`, `.jsonl.deleted.*`)
   - Skips `.checkpoint.*.jsonl` variants to avoid double-counting against the main session / reset files
   - Extracts usage records from messages with `usage` field
   - Filters out OpenClaw internal messages (`provider === 'openclaw'`)
   - Returns aggregated data: summary, byProvider, byModel, byDate, **byDateProvider**, **byDateModel**, sessions (each with per-day breakdown)

2. **server.js** - Express API server (port 3001)
   - Provides `/api/stats` endpoint with 30-second TTL + `pricing.updated` cache invalidation
   - Provides `/api/refresh` to force cache invalidation
   - Provides `/api/pricing` (GET/PUT) and `/api/pricing/reset` for custom pricing management
   - Provides `/api/pricing/models` and `/api/openclaw/models` for the pricing page UI
   - Serves stats data for the frontend dashboard

3. **mcp-server.js** - MCP stdio server
   - Implements 5 tools: `get_total_usage`, `get_usage_by_provider`, `get_usage_by_model`, `list_recent_sessions`, `get_session_stats` (expects a UUID sessionId)
   - Uses the same `pricing.updated`-aware cache strategy as `server.js`
   - Allows OpenClaw agents to query their own token consumption

4. **pricing.js** - Custom pricing engine
   - `loadPricingConfig` / `savePricingConfig` with automatic path migration from the legacy `~/.openclaw/` location to the current workspace directory
   - `calculateCostFromUsage` computes per-record cost using custom $/M rates (falls back to OpenClaw session cost when disabled or unmatched)
   - `findMatchingPricing` implements exact → wildcard → regex match priority

5. **openclaw-config.js** - Reads `$OPENCLAW_CONFIG_DIR/agents/main/agent/models.json`
   - Exposes `getOpenClawConfigDir()`, `listOpenClawPricedModels()`, `listUnpricedModels()`
   - Supplies "built-in reference" data for the pricing page

6. **Frontend (index.html, pricing.html, src/)**
   - Light/dark/system theme via `src/theme.js`
   - Dark-themed dashboard with Chart.js visualizations; cost card pinned to the **last** slot of the summary row
   - Time filtering (today, 7d, 30d, this-month, custom ranges) driven by server-side `byDateProvider` / `byDateModel` cross-tables (accurate across multi-provider sessions)
   - Interactive charts: timeline, provider distribution, model comparison (log-scale toggle)
   - Paginated session table with search and sorting
   - `src/util.js` houses shared HTML escapers and the toast helper
   - Vite proxy routes `/api` requests to Express server

### Data Flow

1. Session files → `aggregator.aggregateStats(pricingConfig)` → aggregated JSON (summary + cross-tables)
2. Aggregated data → Express API (`/api/stats`) → Frontend → Charts/Tables
3. Aggregated data → MCP Server → Tool calls for OpenClaw agents

### Session File Parsing

- Active sessions: `<uuid>.jsonl`
- Reset sessions: `<uuid>.jsonl.reset.<timestamp>`
- Deleted sessions: `<uuid>.jsonl.deleted.<timestamp>`
- Checkpoint variants: `<uuid>.checkpoint.<id>.jsonl` — **skipped** because their messages are already present in the main/reset file
- Each JSONL line contains a message with `usage` field containing tokens and cost
- Session status is determined from filename pattern via `parseSessionFile()`

### Key Functions

- `parseSessionFile(filename)` - Extracts session ID, status, and archive timestamp from filename (skips checkpoint and non-session files)
- `parseSessionJsonl(filepath, pricingConfig)` - Parses a single JSONL file and returns usage records with recomputed cost
- `aggregateStats(pricingConfig?)` - Main aggregation; emits `byDate`, `byDateProvider`, `byDateModel`, and per-session `byDate`
- `filterDataByDateRange(fullData, from, to)` - Frontend function that collapses the server-provided cross-tables into accurate range-specific `byProvider` / `byModel`

### Environment variables

| Variable | Controls | Default |
|----------|----------|---------|
| `OPENCLAW_CONFIG_DIR` | Where `agents/main/sessions/` and `agents/main/agent/models.json` live | `~/.openclaw` |
| `OPENCLAW_DIR` | Where `openclaw-usage-pricing.json` is stored (overrides workspace detection) | unset |
| `openclaw.json.agents.defaults.workspace` | Fallback path for the pricing config file when `OPENCLAW_DIR` is unset | unset |

## Development Notes

- Both API server and MCP server use a 30-second TTL + `pricing.updated` cache key
- The frontend uses Chart.js via CDN (dynamically loaded)
- Session timestamps are in ISO 8601 format (`archivedAt` is reconstructed from filenames; only the time portion's separators are normalized back to `:`)
- Model comparison chart supports logarithmic scale for better visualization of small values
- The project is configured as an ES module (`"type": "module"` in package.json)
