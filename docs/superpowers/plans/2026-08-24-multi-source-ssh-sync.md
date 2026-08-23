# Multi-Source SSH Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, low-frequency SSH push synchronization so one OpenClawUsage instance can aggregate and filter local plus imported OpenClaw sources while pricing all sources locally.

**Architecture:** Preserve the existing pricing-independent contribution layer. Export a sanitized complete snapshot for the local source, receive and atomically persist allowlisted remote snapshots, namespace all imported identities, and merge every contribution through the existing pricing function. Use one capability-driven Web UI on every machine, with policy fixed in a local config file and only safe daily settings editable in the browser.

**Tech Stack:** Node.js ESM, Express, Vite, vanilla JavaScript, Vitest/jsdom, parameterized OpenSSH invocation, macOS LaunchAgent, Linux user systemd.

## Global Constraints

- Implement against `docs/superpowers/specs/2026-08-24-multi-source-ssh-sync-design.md`.
- Use test-driven development: demonstrate focused RED, implement minimally, then run focused GREEN.
- Preserve existing HTTP/MCP and no-config single-source behavior.
- Never transmit raw JSONL, message content, file paths, manifest identity, pricing config, credentials, or precomputed total cost.
- Never construct an SSH shell command from user input; `targetId` must resolve through the config allowlist and execute through an argument array.
- Keep `README.md` and `README_EN.md`, plus `zh-CN` and `en-US` UI strings, synchronized.
- Do not modify `CLAUDE.md`, `.cursor/hooks/state/*`, the root checkout's `AGENTS.md`, or unrelated user files.
- Per-task agents may create local commits for review. Do not push until root verification passes.

## Task 1: Configuration, Policy and Sanitized Snapshot Storage

**Files:**
- Create: `sync-config.js`
- Create: `sync-snapshot.js`
- Create: `tests/unit/sync-config.test.js`
- Create: `tests/unit/sync-snapshot.test.js`

**Interfaces:**
- `loadSyncConfig(options?)`, `updateSyncSettings(patch, options?)`, `getPublicSyncConfig(options?)`.
- `buildSourceSnapshot(cacheSnapshot, syncConfig)`, `validateSourceSnapshot(value, syncConfig)`, `storeImportedSnapshot(value, options?)`, `loadImportedSnapshots(options?)`.

- [ ] Write failing tests for missing-config defaults, strict identifiers, policy/settings separation, atomic mode-0600 writes, and rejection of unknown update fields.
- [ ] Implement config discovery under `OPENCLAW_CONFIG_DIR`, schema version 1 validation, safe defaults, and public capability projection.
- [ ] Write failing tests for exact exported allowlist, opaque contribution IDs, source authorization, finite non-negative counters, size/array limits, corrupt/version-mismatch preservation and mode-0600 atomic imports.
- [ ] Implement snapshot conversion/validation/storage without exposing filename, identity, manifest, paths, pricing or content.
- [ ] Run `npx vitest run tests/unit/sync-config.test.js tests/unit/sync-snapshot.test.js` and the existing cache/contribution tests.
- [ ] Commit only Task 1 changes.

## Task 2: SSH Transport, CLI and Low-Frequency Scheduling

**Files:**
- Create: `sync-service.js`
- Modify: `scripts/openclaw-usage-cli.js`
- Modify: `scripts/install-local-launcher.sh`
- Create: `scripts/install-sync-scheduler.sh`
- Create: `scripts/install-systemd-user-service.sh`
- Create: `deploy/openclaw-usage.service`
- Create: `deploy/openclaw-usage-sync.service`
- Create: `deploy/openclaw-usage-sync.timer`
- Create/Modify: focused CLI, transport and installer tests under `tests/unit/` and `tests/integration/`.

**Interfaces:**
- `syncToTarget(targetId?, options?)`, `receiveSync(input, options?)`, `getSyncStatus(options?)`, `testSyncTarget(targetId, options?)`.
- CLI subcommands `sync [targetId]`, `receive-sync`, `sync-status`.

- [ ] Write failing transport tests proving target IDs must be allowlisted, `execFile` receives a fixed SSH alias/remote command, stdin carries the snapshot, timeout/nonzero exit is explicit, and errors never expose credentials/raw output.
- [ ] Implement one-shot sync and status persistence; do not retry inside a run.
- [ ] Write failing CLI tests for default target, explicit allowlisted target, stdin receiver, exit codes and machine-readable-safe output.
- [ ] Implement CLI commands while preserving start/stop/status/build behavior.
- [ ] Add repeatable LaunchAgent and user-systemd timer installers; timer uses configured interval/default hourly and `Persistent=false` semantics (no retry storm).
- [ ] Add/install a user-systemd Web service template that can preserve `OPENCLAW_USAGE_HOST=0.0.0.0` and port 3001 through an environment file or explicit safe defaults.
- [ ] Run focused tests plus launcher tests; inspect generated plist/units for absolute paths and no embedded credentials.
- [ ] Commit only Task 2 changes.

## Task 3: Multi-Source Aggregation, Cache Invalidation and HTTP/MCP Integration

**Files:**
- Modify: `stats-contribution.js`
- Modify: `stats-cache-store.js` as narrowly required
- Modify: `stats-service.js`
- Modify: `server.js`
- Modify: `mcp-server.js` only if needed to preserve combined stats
- Create/Modify: `tests/integration/stats-service/multi-source.test.js`, HTTP and MCP tests.

**Interfaces:**
- `getStats()` keeps current top-level combined stats and adds `instance`, `sources`, `statsBySource`.
- HTTP adds safe sync config/status/settings/manual-action endpoints; exact routes must be documented in the spec audit.

- [ ] Write failing aggregation tests with colliding local/remote filenames and session IDs, configured-but-missing sources, stale imports, and All = sum(source) token/request invariants.
- [ ] Implement source namespacing and per-source/combined merge using one receiver-side pricing config.
- [ ] Include imported snapshot identity in cache freshness so successful receive and source removal/replacement cannot return silently stale combined stats.
- [ ] Write failing HTTP tests for public capabilities, settings field allowlist, manual sync target allowlist, same-origin/JSON guard, safe error bodies and backward-compatible `/api/stats`.
- [ ] Implement routes and ensure normal refresh/full refresh affects local parsing while still merging imports.
- [ ] Verify MCP statistics continue to use the combined result without breaking tool schemas.
- [ ] Run focused stats, server and MCP suites, then commit only Task 3 changes.

## Task 4: Dashboard Source Filter and Unified Settings UI

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`
- Modify: `src/data-filter.js`
- Modify: `src/style.css`
- Modify: `src/locales/zh-CN.js`
- Modify: `src/locales/en-US.js`
- Create: `settings.html`
- Create: `src/settings.js`
- Modify: `vite.config.js`
- Create/Modify: frontend jsdom tests for filter, rendering, settings and i18n.

- [ ] Write failing pure filter tests proving source selection changes every aggregate/table view, Provider/Model options are scoped, date is retained, dimension clear resets source/provider/model and source change resets pagination.
- [ ] Implement source-aware data selection before existing provider/model/date filtering; add dynamic selector and Session Source column.
- [ ] Write failing DOM tests for missing/stale source indicators, capability-driven “Sync to …” refresh action, and identical page behavior with/without outbound capabilities.
- [ ] Implement dashboard rendering and non-blocking status messages using existing theme/layout conventions.
- [ ] Write failing settings tests for public-only fields, empty allowlist guidance, valid target selection, interval/enabled save, connection test and manual sync.
- [ ] Implement settings page; do not render arbitrary host, command, path, credential or SSH-option inputs.
- [ ] Add exact bilingual SSH policy help text and maintain locale key parity.
- [ ] Run focused frontend/i18n tests and `npm run build`; commit only Task 4 changes.

## Task 5: Documentation, Deployment Assets and Post-Implementation Sync Audit

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/superpowers/specs/2026-08-24-multi-source-ssh-sync-design.md`
- Modify: deployment assets from Task 2 only where runtime evidence requires correction.
- Create/Modify: documentation/config-example validation tests if the repo has an appropriate pattern.

- [ ] Document the architecture, exact sanitized schema, SSH alias setup, config examples for MBP/claw, Web settings boundary, CLI, scheduler, failure semantics and `0.0.0.0` exposure note in both languages.
- [ ] Validate every documented command against the actual CLI help and installer behavior.
- [ ] Perform Post-Implementation Sync Audit: compare every implemented route, file path, config field, status rule and scheduler behavior to the design; update the design status, implementation summary and intentional deviations.
- [ ] Run README bilingual parity/manual link checks and `git diff --check`; commit only Task 5 changes.

## Root Acceptance and Release

- [ ] Run complete `npm test` and `npm run build` from the isolated worktree.
- [ ] Run a whole-branch reviewer subagent; return every actionable finding to the owning implementer and re-review fixes.
- [ ] Inspect the exported snapshot for prohibited fields and exercise rejection paths with temporary config directories.
- [ ] Start a temporary local server and verify stats/settings/manual-sync endpoints plus dashboard/settings pages in a real browser.
- [ ] Exercise an actual MBP -> `ssh claw` sync using safe temporary/production-compatible config, then verify source totals and status without overwriting last good data on a negative test.
- [ ] Confirm the final diff excludes unrelated root-checkout changes and secrets; run `git diff --check` and secret-oriented searches.
- [ ] If task commits were used, retain or squash them into a coherent final history only after verification; push `codex/multi-source-sync`, integrate to `master` without overwriting user changes, and push `master`.
- [ ] Update the local launcher/scheduler deployment and verify health.
- [ ] Update `claw`, install/refresh the user systemd Web service and timer as applicable, keep `0.0.0.0:3001`, and verify HTTP plus systemd state.

## Exact Verification Commands

```bash
npm test
npm run build
git diff --check
git status --short
```

Additional focused commands and deployed health probes must be recorded in the SDD progress ledger as they become concrete.
