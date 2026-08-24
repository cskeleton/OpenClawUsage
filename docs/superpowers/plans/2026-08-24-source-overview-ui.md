# Dashboard Source Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote Cache Read in the dashboard summary and add a filter-aware, clickable source overview for the All sources view.

**Architecture:** Keep the API unchanged. Reuse `filterData` once per configured source so overview metrics inherit the dashboard's date, Provider, and Model semantics; render the result in a new dynamic section managed by `src/main.js`. Use one delegated click handler to reuse the existing source-selection behavior.

**Tech Stack:** Vanilla JavaScript, semantic HTML, CSS, project i18n dictionaries, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-24-source-overview-ui.md`

## Global Constraints

- Do not change the HTTP API, stats/snapshot schema, sync behavior, pricing, or chart datasets.
- Keep all new user-facing copy synchronized in `zh-CN` and `en-US`.
- Preserve existing visual tokens, light/dark themes, responsive behavior, and HTML escaping boundaries.
- Use strict TDD: add behavior tests first, run them and record the expected feature-missing failure, then change production code.
- Preserve unrelated files and do not push or deploy.

---

### Task 1: Cache hierarchy and source overview

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`
- Modify: `src/style.css`
- Modify: `src/locales/zh-CN.js`
- Modify: `src/locales/en-US.js`
- Modify: `tests/unit/frontend/dashboard-dom.test.js`
- Verify: `docs/superpowers/specs/2026-08-24-source-overview-ui.md`

**Interfaces:**
- Consumes: `filterData(fullData, { from, to, source, provider, model })`, current `sources` and `statsBySource` response fields, `escapeHtml`, `escapeAttr`, and dashboard `t()`.
- Produces: dynamic `#source-overview` UI; source buttons identified by `[data-source-overview-id]`; localized Cache Read/Write and source-overview copy.

- [ ] **Step 1: Add failing DOM tests for the cache card**

  Give the fixture distinct non-zero `cacheRead` and `cacheWrite` values. Assert
  that the fourth summary card renders `Cache Read` with the read value as
  `.stat-value` and `Write: …` with the write value as `.stat-sub`. The test
  must fail against the current production code because the hierarchy is
  reversed.

- [ ] **Step 2: Add failing DOM tests for the source overview**

  Keep one compact focused flow against the existing three-source fixture. It
  must assert the All sources rows and stale/missing status copy, hand-derived
  tokens/cost/requests/sessions and token share for populated rows, zero data
  for `missing`, current-filter-aware metrics and shares, and selecting a row
  changes the source selector, hides the overview, clears Provider/Model, and
  resets pagination. Use distinct non-zero cache values in the same flow for
  the Cache Read/Write hierarchy. Do not build dedicated locale, responsive,
  or single-source test matrices; cover those with implementation review,
  existing i18n/visibility mechanisms, and manual browser verification. Run
  the focused test and record that it fails for missing/reversed UI, not for
  test setup.

- [ ] **Step 3: Implement the cache hierarchy and localized copy**

  In `renderSummaryCards`, use `dashboard.summaryCacheRead` as the fourth card
  label, `summary.totalCacheRead` as the main value, and a new
  `dashboard.summaryCacheWrite` template (`Write: {count}`) for the subline.
  Use separate unambiguous translation keys if that avoids overloading current
  keys, but keep both dictionaries structurally identical.

- [ ] **Step 4: Add the source overview container and renderer**

  Insert `<section id="source-overview">` between `#summary-cards` and the
  charts. In `src/main.js`, build rows from `fullData.sources` and compute each
  row by calling `filterData` with the active date/provider/model filters and
  that row's source ID. Compute token share from the sum of rendered row token
  totals. Render missing sources with the valid empty aggregate already
  provided by `selectSourceData`. Escape labels/IDs and provide localized
  accessible names. Hide the section unless source=`all` and at least two
  sources are configured.

- [ ] **Step 5: Add drill-down interaction and styling**

  Extract or reuse one source-selection path so the select's `change` event and
  overview row activation both set the source, clear Provider/Model, reset the
  page, and rerender. Style the section as an existing glass card with compact
  grid rows, token-share bars, textual status plus status color, hover and
  `:focus-visible` states. At <=900px reduce columns; at <=500px use stacked
  source cards without horizontal overflow.

- [ ] **Step 6: Verify green and commit**

  Run `npm test -- tests/unit/frontend/dashboard-dom.test.js`, `npm test`,
  `npm run build`, and `git diff --check`. Review the diff for out-of-scope API
  or schema changes, then commit only the listed implementation, test, spec,
  and plan files with message `feat: add dashboard source overview`.
