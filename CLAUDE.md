# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClawUsage is a token usage statistics and visualization tool for OpenClaw. It parses local session files from `~/.openclaw/agents/main/sessions/` to provide real-time cost monitoring and data analysis through a web dashboard and MCP server.

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
   - Scans `~/.openclaw/agents/main/sessions/` for session files
   - Parses JSONL files (`.jsonl`, `.jsonl.reset.*`, `.jsonl.deleted.*`)
   - Extracts usage records from messages with `usage` field
   - Filters out OpenClaw internal messages (`provider === 'openclaw'`)
   - Returns aggregated data: summary, byProvider, byModel, byDate, and sessions

2. **server.js** - Express API server (port 3001)
   - Provides `/api/stats` endpoint with 30-second cache
   - Provides `/api/refresh` endpoint to force cache invalidation
   - Serves stats data for the frontend dashboard

3. **mcp-server.js** - MCP stdio server
   - Implements 5 tools: `get_total_usage`, `get_usage_by_provider`, `get_usage_by_model`, `list_recent_sessions`, `get_session_stats`
   - Uses 30-second cache to avoid repeated file I/O
   - Allows OpenClaw agents to query their own token consumption

4. **Frontend (index.html, src/)**
   - Dark-themed dashboard with Chart.js visualizations
   - Time filtering (today, 7d, 30d, this-month, custom ranges)
   - Interactive charts: timeline, provider distribution, model comparison
   - Paginated session table with search and sorting
   - Vite proxy routes `/api` requests to Express server

### Data Flow

1. Session files in `~/.openclaw/agents/main/sessions/` → `aggregator.aggregateStats()` → aggregated JSON
2. Aggregated data → Express API (`/api/stats`) → Frontend → Charts/Tables
3. Aggregated data → MCP Server → Tool calls for OpenClaw agents

### Session File Parsing

- Active sessions: `<uuid>.jsonl`
- Reset sessions: `<uuid>.jsonl.reset.<timestamp>`
- Deleted sessions: `<uuid>.jsonl.deleted.<timestamp>`
- Each JSONL line contains a message with `usage` field containing tokens and cost
- Session status is determined from filename pattern via `parseSessionFile()`

### Key Functions

- `parseSessionFile(filename)` - Extracts session ID, status, and archive timestamp from filename
- `parseSessionJsonl(filepath)` - Parses a single JSONL file and returns usage records
- `aggregateStats()` - Main aggregation function that processes all session files
- `filterDataByDateRange(fullData, from, to)` - Frontend function to filter aggregated data by date range

## Development Notes

- Both API server and MCP server use a 30-second TTL cache to avoid repeated file system scans
- The frontend uses Chart.js via CDN (dynamically loaded)
- Session timestamps are in ISO 8601 format
- Model comparison chart supports logarithmic scale for better visualization of small values
- The project is configured as an ES module (`"type": "module"` in package.json)
