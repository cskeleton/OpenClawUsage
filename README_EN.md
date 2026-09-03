# OpenClaw Token Usage Tool

A standalone token usage statistics and visualization tool for OpenClaw. It reads the local OpenClaw session database (SQLite, OpenClaw 2026.8.2+) in read-only mode to provide real-time cost monitoring and data analysis.

## 🌟 Key Features

- **Visual Dashboard (Web UI)**: Dark-themed interface built with Vite + Chart.js.
  - **Comprehensive Stats**: Covers all sessions including active, completed (`done`), reset, and deleted (archived) sessions from the SQLite transcript store.
  - **Time Filtering**: Built-in presets (Today, Last 7 Days, This Month, etc.) and custom date ranges.
  - **Provider / Model Filtering**: Filter by a Provider or a specific `provider/model` together with the selected time range. After filtering, **summary cards, all charts, and Session details are recalculated consistently**, while a chip at the top shows that dimension's cost / Tokens / request count for the selected period.
  - **Provider / Model Usage Details**: Aggregate by Provider or Model across Input / Output / Cache Read / Cache Write / Total Tokens, **Cost ($)**, cost share, and request count. Columns are sortable, and clicking any row drills down by applying it as a filter.
  - **Rich Metrics**: Tracks Input/Output Tokens, cost trends, Provider distribution, and Cache (Read/Write) performance. On the home summary row, **Total cost** is the **last** card (after token/cache/session summaries); the daily trend chart can switch between **Token / Cost** views; Provider-cost tooltips show each Provider's share of the currently filtered Provider cost.
  - **Model Comparison**: Each Model has one Input bar split into ordinary Input, Cache Write, and Cache Read, plus an adjacent Output bar. Date-checkpoint variants are grouped across Providers by default; the control can restore exact entries.
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
  - The pricing page includes **OpenClaw built-in prices (reference)** and **Models missing prices (reference)**: both are derived from `models.providers` in `openclaw.json` under `OPENCLAW_CONFIG_DIR` (default `~/.openclaw`; OpenClaw 2026.8.2+ — the legacy `agents/main/agent/models.json` is no longer generated), split by whether input/output rates are present. Each table shows whether a row is already covered by custom rules (including wildcard/regex matches) and lets you copy uncovered keys into “Add price”. **Models actually selectable in OpenClaw** are governed by **`agents.defaults.models`** in `openclaw.json`, which is not the same as the rows listed in these reference tables.
  - The “Add price” area on the pricing page provides a **Fetch reference prices from models.dev** button: it opens a searchable, single-select dialog backed by the public [models.dev](https://models.dev) catalog, and on confirm it **only fills the Input/Output/Cache Read/Cache Write price fields** — it never writes the model key. If any price field already has a value, you can choose **Overwrite all / Fill blanks only / Cancel**. The catalog is cached locally for 24 hours (`$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/models-dev-v1.json`); when expired, the last snapshot is shown first while a background refresh runs, and a failed first fetch fails closed with an error. Confirm Provider/Model yourself before saving.
  - Supports 4 price types: Input, Output, Cache Read, Cache Write.
  - Cache prices are optional; when left empty, costs are computed **at the Input list price** (both cache read and cache write traffic use Input $/M; no separate cache rate).
  - Dedicated pricing configuration page with add/edit/delete/reset functionality.
  - **Dynamic config path**: The pricing file (`openclaw-usage-pricing.json`) auto-detects the OpenClaw workspace directory, so it travels with your config across machines.

- **Persistent Incremental Stats Cache**:
  - The page will still request the server, but unchanged sessions and pricing will reuse the persistent cache without reparsing the database.
  - When changes are detected, the last successful result is returned first and only changed files are processed in the background. Normal refresh is incremental; a dropdown action performs a full rebuild.
  - Web and MCP share the same cache strategy. See the [persistent incremental stats cache specification](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md) for the complete design.

## 📊 Data Source & Logic

The tool reads OpenClaw's local SQLite session database in read-only mode (OpenClaw 2026.8.2+ architecture; the legacy JSONL session files are obsolete — their history is frozen in one shot from the old cache on first launch):

- **Target Database**: `$OPENCLAW_CONFIG_DIR/agents/main/agent/openclaw-agent.sqlite` (defaults to `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` when the env var is unset), opened read-only so the OpenClaw gateway keeps writing unaffected. **This path is NOT affected by `agents.defaults.workspace`** — workspace only controls where the pricing config file lives (see below).
- **Covered Tables**:
  - `transcript_events`: the full message/event log of active sessions (`event_json` mirrors the old JSONL rows).
  - `session_transcript_archives`: whole-session archives for post-migration deleted/reset sessions (zstd blobs that decompress to the original JSONL text); they never overlap with active events.
  - `session_windows`: session status (running/done/failed/killed/timeout → UI `active`/`done`).
- **Frozen History**: the legacy JSONL-era cache (`stats-v1.json`) is frozen into `legacy:*` contributions on the first v2 build, with zero overlap against SQLite sessions (no double counting); the old cache file is left untouched.

- **Data Capture**:
  The tool parses the `usage` field returned by LLM APIs from `type=message` events (OpenClaw internal mirror messages are filtered out):
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

- **A request is not a refresh**: The page may call `/api/stats` whenever it opens, but aggregation only runs when session identities or pricing have changed.
- **Reuse across restarts**: The cache lives at `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v2.json` and is shared by the Web and MCP processes.
- **Incremental updates**: Each session is identified by an `(event count, maxSeq, last event time, transcript_updated_at)` quadruple. Unchanged sessions reuse their cached contributions; only added or extended sessions are reparsed, and pricing changes only recalculate costs. Database schema changes (OpenClaw upgrades) trigger a full rebuild automatically.
- **Stale while revalidate**: When changes are found, the last successful result is returned first and the page updates automatically after the background refresh completes (`GET /api/stats?fresh=1`).
- **Two manual refresh modes**: Normal refresh is incremental (`GET /api/refresh`). A dropdown “Full rebuild” action bypasses every per-file cache entry (`GET /api/refresh?full=1`).
- **Last-known-good fallback**: Refresh failures or temporary source errors retain the last successful result and mark it `stale` instead of silently replacing it with empty data.
- **No persistent browser cache**: Page reloads continue to read from the server; IndexedDB and LocalStorage are not used to store stats.
- **API `cache` field**: `GET /api/stats` includes top-level `cache.state` (`fresh | refreshing | stale`), `revision`, `sourceId`, and `checkedAt`.
- **MCP**: `refresh_stats_cache` is incremental by default; optional `full: true` performs a full rebuild. Pricing tools do not trigger stats aggregation.

See the [design specification](docs/superpowers/specs/2026-08-01-persistent-incremental-stats-cache.md) for behavior, cache structure, and acceptance criteria (SQLite source architecture: [2026-09-03 SQLite migration spec](docs/superpowers/specs/2026-09-03-sqlite-session-source.md)).

## 🔄 Multi-source SSH sync and unified pricing

OpenClawUsage supports low-frequency, one-way full-snapshot sync from an MBP to `claw`. Both machines run the same Web UI and capability-driven code: the MBP can view its own data independently, while `claw` can combine local, MBP, and other configured sources. The receiver applies its own pricing configuration to every source, so changing prices on `claw` reprices all sources without another sync.

### Sanitized snapshot boundary

Sync sends one complete, versioned JSON envelope rather than a JSONL incremental patch. Its top-level fields are fixed:

```json
{
  "version": 1,
  "kind": "openclaw-usage-source-contributions",
  "scope": "local-only",
  "source": { "id": "mbp", "label": "MBP" },
  "revision": "opaque-revision",
  "generatedAt": "2026-08-24T12:00:00.000Z",
  "contributions": [
    {
      "contributionId": "opaque-sha256-id",
      "session": { "id": "session-id", "status": "active", "archivedAt": null },
      "firstTimestamp": "2026-08-24T11:00:00.000Z",
      "lastTimestamp": "2026-08-24T12:00:00.000Z",
      "buckets": [
        {
          "date": "2026-08-24",
          "provider": "provider",
          "model": "model",
          "usage": {
            "input": 10,
            "output": 20,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 30
          },
          "openclawCost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0
          },
          "requests": 1
        }
      ],
      "hasRecords": true
    }
  ]
}
```

Only the top-level, contribution, session, bucket, `usage`, and `openclawCost` fields shown above are allowed. Counters and costs must be finite and non-negative, and every numeric value must be no greater than `90,071,992` (so it remains safely accumulable at the maximum contribution/bucket limits). `usage` and `requests` must also be safe integers. `contributionId` is an opaque one-way hash of local file identity; the filename is never exposed. The snapshot retains `openclawCost`, so when the receiver has no matching custom price or custom pricing is disabled, the calculation falls back to the `usage.cost` written by OpenClaw in the session. Final `totalCost` is always calculated while merging on the receiver; the snapshot has no `totalCost` field.

Snapshots must not contain message content, prompts/responses, tool calls, file paths, filenames, file size/mtime, manifests, OpenClaw configuration, pricing configuration, credentials, logs, or any precomputed `totalCost`. The receiver validates size, version, types, authorization, numeric safety bounds, and array limits in memory first; snapshots that cannot be safely accumulated are rejected. Corrupt, incompatible, unauthorized, or interrupted input fails closed and cannot replace the last successful snapshot.

### Sync configuration and the SSH trust boundary

The sync configuration is fixed at `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json` (default `~/.openclaw/openclaw-usage-sync.json`). Application write paths enforce a `0700` config directory and `0600` file using a same-directory temporary file followed by an atomic rename. Loading validates content only; it does not repair permissions on a manually created file, and invalid configuration is never silently replaced. After copying and writing the JSON example, explicitly run:

```bash
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_CONFIG_DIR"
chmod 700 "$OPENCLAW_CONFIG_DIR"
chmod 600 "$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json"
```

These are minimal copyable configuration examples.

MBP (sender):

```json
{
  "version": 1,
  "source": { "id": "mbp", "label": "MBP" },
  "policy": {
    "allowedSshTargets": {
      "claw": { "label": "claw", "sshAlias": "claw" }
    }
  },
  "settings": { "enabled": true, "targetId": "claw", "intervalMinutes": 60 },
  "imports": { "allowedSourceIds": [] }
}
```

`claw` (receiver):

```json
{
  "version": 1,
  "source": { "id": "claw", "label": "claw" },
  "policy": { "allowedSshTargets": {} },
  "settings": { "enabled": false, "targetId": null, "intervalMinutes": 60 },
  "imports": { "allowedSourceIds": ["mbp"] }
}
```

The source ID `all` is reserved and cannot be used as `source.id` or in `imports.allowedSourceIds`; it denotes the Dashboard aggregate filter. `source.id`, target IDs, and `sshAlias` must use strict identifiers. Sync accepts only an allowlisted `targetId`, resolves it to the fixed `sshAlias`, and invokes the fixed remote command `openclaw-usage receive-sync` through an argument array; it never constructs a shell command.

The second SSH policy layer is the local `~/.ssh/config`, for example:

```sshconfig
Host claw
  HostName 192.0.2.20
  User your-user
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  # Keep ProxyJump and other connection details here as well
```

The two policy layers have separate responsibilities: `~/.ssh/config` controls the host, user, port, key, ProxyJump, and other connection details; `policy.allowedSshTargets` controls which aliases the application may use. The Web UI does not store credentials and does not allow arbitrary hosts, users, keys, SSH options, remote paths, or commands. After pre-authorization, Settings can edit only `settings.enabled`, an allowlisted `settings.targetId`, `settings.intervalMinutes` (1–10080 minutes), and the display-only `source.label`.

The scheduled-sync invariant is: when `settings.enabled` is `true`, `settings.targetId` must be an allowlisted target. Config validation and Settings UI both prevent the enabled/no-target combination. To remove a target, disable scheduled sync first. With no sync config file, the legacy single-source behavior is preserved: raw Session UUIDs and contribution keys remain unprefixed; once multi-source configuration is enabled, local and imported sources use source namespaces.

Settings shows this exact security help:

> SSH connections are managed by the local `~/.ssh/config`. This page can only select SSH aliases pre-authorized in `$OPENCLAW_CONFIG_DIR/openclaw-usage-sync.json`. It does not store credentials or allow arbitrary hosts, SSH options, remote paths, or commands.

### CLI, scheduling, and deployment

The sync-related lines in `openclaw-usage help` are an exact CLI contract:

```text
  sync [targetId]    Push one sanitized snapshot to an allowlisted target
  receive-sync       Receive one sanitized snapshot from stdin
  sync-status        Print the last sync attempt/success/failure as JSON
```

When omitted, `sync` uses `settings.targetId`; `receive-sync` reads exactly one snapshot from stdin; `sync-status` prints only the safe public status projection. Web manual actions map to `POST /api/sync/run` and `POST /api/sync/test`; Settings maps to `GET /api/sync/config`, `GET /api/sync/status`, and `PUT /api/sync/settings`. These routes are available for Web/API use and do not need to be presented as ordinary-user CLI commands. Manual sync remains available even when scheduled sync is disabled.

The default interval is 60 minutes and one run does not retry. After a failure, the next scheduler tick or a manual run is required. On macOS, `./scripts/install-sync-scheduler.sh` installs a LaunchAgent at `~/Library/LaunchAgents/com.openclaw.usage.sync.plist`; on Linux, the same installer creates user systemd service/timer units under `~/.config/systemd/user/`. The timer uses `Persistent=false`, so offline or sleep periods do not create a retry storm. The installer embeds absolute local `node` and CLI paths in the LaunchAgent/systemd scheduler. Scheduled runs call `openclaw-usage sync --scheduled` and reread `settings.enabled` each time; disabled scheduled runs skip, while manual `openclaw-usage sync [targetId]` remains available. Only the remote non-interactive SSH receiver must resolve `openclaw-usage` in its PATH. If the remote side reports `openclaw-usage: command not found`, fix the remote PATH/launcher installation instead of exposing a command or path in Web settings.

Status is stored at `$OPENCLAW_CONFIG_DIR/run/openclaw-usage/sync-status.json` and contains `lastAttempt`, `lastSuccess`, `failureSince`, `targetId`, and a safe error classification. Imported snapshots live at `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/imports/<sourceId>.json`; the local stats cache remains `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v2.json`. For an imported source, `lastReceivedAt` is the last successful replacement time and expiry is `lastReceivedAt + intervalMinutes`, using the receiver's interval setting. Configured-but-not-yet-received sources remain listed as missing; stale and missing sources remain in the All aggregate and are visibly flagged by the Dashboard.

To deploy the Web service on `claw`, an explicit example is:

```bash
./scripts/install-systemd-user-service.sh --host 0.0.0.0 --port 3001 --config-dir "$OPENCLAW_CONFIG_DIR"
```

`--host 0.0.0.0 --port 3001` is suitable only for a user-accepted home-LAN/ZeroTier boundary. The service has no authentication and must never be exposed to the public Internet. The default installation still binds to `127.0.0.1`.

### Dashboard and troubleshooting

The Dashboard Source filter scopes summary cards, all charts, Provider/Model options, Breakdown, and the Session table; `All` uses combined statistics and the Session table includes a Source column. The Dashboard reads sync capabilities from the `instance.capabilities` field in the `GET /api/stats` response; Settings reads targets and actions from the public `capabilities` field in the `GET /api/sync/config` response. Both machines share the same UI and capability contract instead of guessing a role from the machine name.

Common issues:

- SSH alias failures: first run `ssh claw` in a terminal to verify `~/.ssh/config`, network reachability, and keys, then check the sender allowlist. Web Settings never edits SSH configuration.
- Remote `openclaw-usage` not found: the remote login PATH may omit `~/bin`; install/reinstall the local launcher on the remote and fix its PATH.
- MBP offline: `claw` retains the last-good snapshot and retries only on the next scheduler tick or manual run; All is not cleared, and the source status becomes stale/missing.
- Invalid snapshot: the receiver rejects it and preserves the last successful file; it never replaces good data with empty or corrupt content. Inspect the safe receiver error classification and fix the sender/configuration.

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
| Stats cache | `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/stats-v2.json` (not deleted by `start`/`stop`) |

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
      "args": ["<repository-root>/mcp-server.js"]
    }
  }
}
```

### MCP Management Tool Examples

> ⚠️ `update_pricing_config` writes to the pricing configuration file. Verify the payload before running it.

- `get_pricing_config`: Read the current pricing config (read-only).
- `update_pricing_config`: Update pricing config (write operation).
- `refresh_stats_cache`: Refreshes the aggregate cache without altering business data. It performs an **incremental refresh by default** (only added/changed sessions are reparsed) and accepts `full: true` for a full rebuild.

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
| 2️⃣ | `agents.defaults.workspace` in `openclaw.json` | `$OPENCLAW_WORKSPACE` → stored under that workspace |
| 3️⃣ | Fallback `~/.openclaw/` | Default fallback |

> ⚠️ The table above applies **only to the pricing config file**. **The session database and model catalog (openclaw.json)** are always read from `$OPENCLAW_CONFIG_DIR` (default `~/.openclaw`) and do **not** follow the workspace.

#### Model catalog (`openclaw.json` `models.providers`, pricing reference API)

| Variable | Meaning |
|----------|---------|
| `OPENCLAW_CONFIG_DIR` | Config root; defaults to `~/.openclaw` if unset |
| Model catalog source | `models.providers` in `$OPENCLAW_CONFIG_DIR/openclaw.json` |

Independent of `OPENCLAW_DIR` (used for pricing file path detection).

#### Migration Logic

On startup, the tool automatically handles path compatibility and migration:

1. Reads from the new path (following the OpenClaw workspace directory).
2. If the new path doesn't exist, tries the legacy path `~/.openclaw/openclaw-usage-pricing.json`.
3. If the legacy path exists, automatically copies its content to the new path for seamless migration.
4. If neither path exists, creates an empty config (falls back to OpenClaw built-in pricing).

#### Example

If `openclaw.json` has `"workspace": "$OPENCLAW_WORKSPACE"`, the pricing config is stored at:

```
$OPENCLAW_WORKSPACE/openclaw-usage-pricing.json
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

   # List models with / without prices from openclaw.json models.providers (joined via findMatchingPricing)
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
