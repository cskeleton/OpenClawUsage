# Dashboard Chart Clarity and Model Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard charts show cache composition and Provider cost share clearly, group date-checkpoint variants across Providers by default, and remove decorative Emoji without changing precise filter or API data.

**Architecture:** Keep backend aggregates and precise `provider/model` keys unchanged. Add a pure model-chart transformation module, then let `charts.js` build stacked Input presentation from its rows; the dashboard checkbox only controls this presentation step. Keep UI copy bilingual and validate both chart configuration and real browser behavior.

**Tech Stack:** Vite 6, vanilla ES modules, Chart.js 4.4.7, Vitest 4 with jsdom, existing lightweight i18n.

## Global Constraints

- Implement against `docs/superpowers/specs/2026-08-11-dashboard-chart-clarity-and-model-grouping-design.md`.
- Do not modify HTTP API, MCP tools, stats aggregation, persistent cache, or snapshot schemas.
- Model grouping affects only the Model usage chart; filters and breakdown tables keep exact `provider/model` keys.
- “Merge date checkpoints” defaults on, is not persisted, and strips only valid trailing `MMDD`, `YYYYMMDD`, or `YYYY-MM-DD` checkpoints.
- Input stack total is `input + cacheRead + cacheWrite`; Cache Read is darkest, Cache Write medium, ordinary Input lightest; Output remains adjacent and separate.
- Remove decorative heading Emoji, but retain `🦞`, Session status icons, summary-card icons, and `💰 价格配置 / Pricing Config`.
- Keep user-facing UI and README copy synchronized in Chinese and English.
- Preserve all pre-existing worktree changes. In particular, do not stage `.cursor/hooks/state/*`, `AGENTS.md`, `.superpowers/`, or `docs/superpowers/plans/2026-08-09-models-dev-pricing-reference.md`.
- Do not modify `CLAUDE.md`.

## Approved Pre-Flight Rulings

- Test rendered DOM behavior instead of grepping HTML source text. Reading the static HTML fixture is allowed only to parse it into a DOM whose elements, attributes, and text are asserted.
- Verify the isolated worktree with its own launcher process, temporary `OPENCLAW_CONFIG_DIR`, and a free `OPENCLAW_USAGE_PORT`; do not invoke or replace the globally installed `~/bin/openclaw-usage` wrapper.

## File Structure

- Create `src/model-chart-data.js`: date-checkpoint validation, normalization, cross-Provider chart-only aggregation, stable sorting.
- Create `tests/unit/frontend/model-chart-data.test.js`: pure transformation edge cases.
- Modify `src/charts.js`: Provider percentage tooltip, stacked Model datasets, total-Input tooltip, i18n labels.
- Create `tests/unit/frontend/charts.test.js`: presentation helper and tooltip contracts without loading Chart.js from the CDN.
- Modify `index.html`: default-on checkpoint checkbox and decorative Emoji cleanup.
- Modify `src/main.js`: bind the new checkbox to the existing destroy-and-render lifecycle.
- Modify `src/style.css`: place both Model-chart controls consistently and responsively.
- Modify `src/locales/zh-CN.js` and `src/locales/en-US.js`: synchronized chart labels/control copy and Emoji-clean heading text.
- Modify `tests/unit/frontend/i18n.test.js`: bilingual key parity and exact heading/retained-icon assertions.
- Modify `README.md` and `README_EN.md`: synchronized user-facing behavior.
- Modify `docs/superpowers/specs/2026-08-11-dashboard-chart-clarity-and-model-grouping-design.md`: Post-Implementation Sync Audit only after implementation and browser evidence exist.

---

### Task 1: Pure Date-Checkpoint Normalization and Model Aggregation

**Files:**
- Create: `src/model-chart-data.js`
- Create: `tests/unit/frontend/model-chart-data.test.js`

**Interfaces:**
- Produces: `stripDateCheckpoint(modelName: string): string`.
- Produces: `buildModelChartRows(byModel: Record<string, object>, options?: { mergeDateCheckpoints?: boolean }): Array<ModelChartRow>`.
- `ModelChartRow` shape: `{ key, label, input, output, cacheRead, cacheWrite, totalInput, totalTokens, totalCost, requests }` with finite numeric fields.
- Consumes: existing `byModel` entries shaped like `{ provider, model, input, output, cacheRead, cacheWrite, totalTokens, totalCost, requests }`.

- [ ] **Step 1: Write failing checkpoint-normalization tests**

Create table-driven tests that require valid suffix removal and conservative preservation:

```js
import { describe, expect, it } from 'vitest';
import { stripDateCheckpoint, buildModelChartRows } from '../../../src/model-chart-data.js';

describe('stripDateCheckpoint', () => {
  it.each([
    ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['gpt-4o-2024-08-06', 'gpt-4o'],
    ['checkpoint-0229', 'checkpoint'],
  ])('strips valid trailing date checkpoint from %s', (input, expected) => {
    expect(stripDateCheckpoint(input)).toBe(expected);
  });

  it.each([
    'deepseek-v4-flash-0230',
    'claude-sonnet-4-20250229',
    'gpt-4o-2024-13-01',
    'deepseek-v4',
    'gemini-2.5',
    'model-2025',
    'model-42',
    'model-0731-preview',
  ])('preserves non-checkpoint suffix %s', (input) => {
    expect(stripDateCheckpoint(input)).toBe(input);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/frontend/model-chart-data.test.js
```

Expected: FAIL because `src/model-chart-data.js` does not exist.

- [ ] **Step 3: Implement strict calendar validation and suffix removal**

Implement explicit pattern precedence (`YYYY-MM-DD`, `YYYYMMDD`, then `MMDD`) and round-trip calendar validation. Validate `MMDD` against leap year 2000 so `0229` is accepted while `0230` is rejected. Coerce non-string inputs to a safe string only if needed by the function contract; never throw for chart labels.

Core shape:

```js
function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function stripDateCheckpoint(modelName) {
  const name = typeof modelName === 'string' ? modelName : '';
  // Match from most specific format to least specific, validate, then slice.
  return name;
}
```

- [ ] **Step 4: Add failing aggregation tests**

Cover cross-Provider merge, disabled merge, finite-number sanitation, immutability, and cache-inclusive sorting:

```js
const byModel = {
  'provider-a/deepseek-v4-flash': {
    provider: 'provider-a', model: 'deepseek-v4-flash',
    input: 100, cacheRead: 40, cacheWrite: 10, output: 20,
    totalTokens: 170, totalCost: 1.2, requests: 2,
  },
  'provider-b/deepseek-v4-flash-0731': {
    provider: 'provider-b', model: 'deepseek-v4-flash-0731',
    input: 50, cacheRead: 30, cacheWrite: 5, output: 10,
    totalTokens: 95, totalCost: 0.8, requests: 1,
  },
};

it('merges normalized model names across providers', () => {
  expect(buildModelChartRows(byModel)).toEqual([
    expect.objectContaining({
      key: 'deepseek-v4-flash', label: 'deepseek-v4-flash',
      input: 150, cacheRead: 70, cacheWrite: 15,
      totalInput: 235, output: 30, requests: 3,
    }),
  ]);
});

it('keeps exact entries when merging is disabled', () => {
  expect(buildModelChartRows(byModel, { mergeDateCheckpoints: false })).toHaveLength(2);
});
```

Add one row whose ordinary Input is smaller but cache-inclusive total is larger, proving sort order uses `totalInput + output`. Add `NaN`, `Infinity`, `null`, and missing fields and assert they become zero without mutating the source object.

- [ ] **Step 5: Implement minimal aggregation**

Use a local `Map`; when merging is enabled, map by normalized `model`, and when disabled map by the original full `provider/model` key. Sum only finite numbers through one helper. Return fresh rows sorted by descending `totalInput + output`, then `label.localeCompare`, then `key.localeCompare`.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
npx vitest run tests/unit/frontend/model-chart-data.test.js
```

Expected: all checkpoint and aggregation tests PASS.

- [ ] **Step 7: Commit Task 1 only**

```bash
git add src/model-chart-data.js tests/unit/frontend/model-chart-data.test.js
git diff --cached --check
git commit -m "feat(charts): normalize and group model checkpoints"
```

---

### Task 2: Cache-Stacked Model Bars and Provider Percentage Tooltip

**Files:**
- Modify: `src/charts.js:37-48, 90-97, 241-389`
- Modify: `src/locales/zh-CN.js:34-52`
- Modify: `src/locales/en-US.js:34-52`
- Create: `tests/unit/frontend/charts.test.js`

**Interfaces:**
- Consumes: `buildModelChartRows` from Task 1.
- Produces: `buildModelDatasets(rows)` exported for focused tests and used by `renderModelChart`.
- Produces: `formatProviderTooltipLabel(label, value, total)` exported for focused tests and used by the Provider doughnut callback.
- Produces: `formatModelTotalInput(items)` exported for focused tests and used by the Model tooltip footer.
- Adds i18n keys under `dashboard`: `modelMergeCheckpoints`, `chartInput`, `chartOutput`, `chartCacheRead`, `chartCacheWrite`, `chartTotalInput`.

- [ ] **Step 1: Write failing chart-presentation tests**

Test the exact stacking and tooltip contracts without invoking `renderCharts` or loading the CDN:

```js
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildModelDatasets,
  formatModelTotalInput,
  formatProviderTooltipLabel,
} from '../../../src/charts.js';
import { setLocale } from '../../../src/i18n.js';

beforeEach(() => setLocale('en-US'));

it('builds three cache-aware input segments and a separate output stack', () => {
  const datasets = buildModelDatasets([{
    input: 100, cacheWrite: 20, cacheRead: 80, output: 30,
  }]);
  expect(datasets.map((d) => [d.label, d.stack, d.data])).toEqual([
    ['Cache Read', 'input', [80]],
    ['Cache Write', 'input', [20]],
    ['Input', 'input', [100]],
    ['Output', 'output', [30]],
  ]);
  expect(datasets[0].backgroundColor).not.toBe(datasets[1].backgroundColor);
  expect(datasets[1].backgroundColor).not.toBe(datasets[2].backgroundColor);
});

it('shows provider cost and one-decimal share', () => {
  expect(formatProviderTooltipLabel('openai', 2.5, 10))
    .toBe(' openai: $2.50 (25.0%)');
  expect(formatProviderTooltipLabel('openai', 0, 0))
    .toBe(' openai: $0 (0.0%)');
});
```

For `formatModelTotalInput`, pass tooltip items whose datasets have `stack: 'input'` and parsed values `80`, `20`, and `100`; assert `Total Input: 200`. Include one Output item and assert it is excluded.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/frontend/charts.test.js
```

Expected: FAIL because the exported helpers and i18n keys do not exist.

- [ ] **Step 3: Add synchronized chart labels to both locales**

Add the same six keys in the same dashboard section. Exact copy:

```js
// zh-CN
modelMergeCheckpoints: '合并日期 checkpoint',
chartInput: 'Input',
chartOutput: 'Output',
chartCacheRead: 'Cache Read',
chartCacheWrite: 'Cache Write',
chartTotalInput: '总 Input',

// en-US
modelMergeCheckpoints: 'Merge date checkpoints',
chartInput: 'Input',
chartOutput: 'Output',
chartCacheRead: 'Cache Read',
chartCacheWrite: 'Cache Write',
chartTotalInput: 'Total Input',
```

- [ ] **Step 4: Implement Provider percentage formatting**

Replace the fixed four-decimal callback with `formatProviderTooltipLabel`. Compute `totalCost` once from finite `costs`; share is zero when total is not positive. Reuse `formatCostValue(value)` for cost precision and append `(${share.toFixed(1)}%)`.

- [ ] **Step 5: Implement cache-aware Model datasets**

Import `buildModelChartRows`. In `renderModelChart`, read:

```js
const mergeDateCheckpoints = document.getElementById('model-merge-checkpoints')?.checked ?? true;
const rows = buildModelChartRows(byModel, { mergeDateCheckpoints });
```

Build datasets in bottom-to-top Input order: Cache Read (darkest), Cache Write (medium), ordinary Input (lightest); give all three `stack: 'input'`. Give Output `stack: 'output'`. Use a consistent indigo Input family such as alpha `0.88`, `0.58`, `0.28`, plus the existing violet Output family. Preserve outer rounded corners without adding gaps between stack segments.

Set tooltip interaction to `{ mode: 'index', intersect: false }`. Keep per-dataset localized labels and add a footer callback using `formatModelTotalInput`. Calculate the log-scale hint from each row’s `totalInput` and `output`, not from individual cache segments.

- [ ] **Step 6: Run focused chart and i18n tests**

Run:

```bash
npx vitest run tests/unit/frontend/charts.test.js tests/unit/frontend/model-chart-data.test.js tests/unit/frontend/i18n.test.js
```

Expected: all PASS; no CDN request is attempted because tests only call exported pure helpers.

- [ ] **Step 7: Commit Task 2 only**

```bash
git add src/charts.js src/locales/zh-CN.js src/locales/en-US.js tests/unit/frontend/charts.test.js
git diff --cached --check
git commit -m "feat(charts): show cache composition and provider share"
```

---

### Task 3: Default-On Merge Control, Emoji Cleanup, and Bilingual User Docs

**Files:**
- Modify: `index.html:121-190`
- Modify: `src/main.js:560-570, 770-782`
- Modify: `src/style.css:1048-1085`
- Modify: `src/locales/zh-CN.js:34-52`
- Modify: `src/locales/en-US.js:34-52`
- Modify: `tests/unit/frontend/i18n.test.js`
- Modify: `README.md:7-19`
- Modify: `README_EN.md:5-14`

**Interfaces:**
- Produces DOM control: `#model-merge-checkpoints`, a checked checkbox whose label uses `dashboard.modelMergeCheckpoints`.
- Produces DOM group: `.model-chart-controls` containing merge and log-scale controls.
- Consumes existing `destroyCharts()`, `renderCharts(filteredData, { timelineMetric })`, `filterData`, and `getCurrentFilter()`.

- [ ] **Step 1: Write failing i18n and markup contract tests**

Extend `tests/unit/frontend/i18n.test.js` to parse `index.html` and `pricing.html` into DOM documents and assert the rendered static behavior:

```js
import fs from 'node:fs';

it('keeps dashboard chart controls and heading emoji contract synchronized', () => {
  const dashboardHtml = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  const pricingHtml = fs.readFileSync(new URL('../../../pricing.html', import.meta.url), 'utf8');
  const dashboardDoc = new DOMParser().parseFromString(dashboardHtml, 'text/html');
  const pricingDoc = new DOMParser().parseFromString(pricingHtml, 'text/html');

  expect(dashboardDoc.querySelector('#model-merge-checkpoints')?.checked).toBe(true);
  expect(zhCNMessages.dashboard.chartTimeline).toBe('用量趋势（按日）');
  expect(zhCNMessages.dashboard.chartProvider).toBe('Provider 费用分布');
  expect(zhCNMessages.dashboard.chartModel).toBe('Model 用量对比');
  expect(zhCNMessages.dashboard.breakdownTitle).toBe('Provider / Model 消耗明细');
  expect(zhCNMessages.dashboard.sessionDetails).toBe('Session 明细');
  expect(enUSMessages.dashboard.chartModel).toBe('Model usage comparison');
  expect(pricingDoc.querySelector('.pricing-title-text')?.textContent).toContain('💰');
  expect(dashboardDoc.querySelector('.logo')?.textContent).toBe('🦞');
});
```

Also assert all new `dashboard` chart keys exist in both locales with equal key sets.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/frontend/i18n.test.js
```

Expected: FAIL because the checkbox is absent and decorative heading Emoji remain.

- [ ] **Step 3: Add the default-on merge control and responsive layout**

Update the Model chart title row to contain:

```html
<div class="model-chart-controls">
  <label class="log-toggle">
    <input type="checkbox" id="model-merge-checkpoints" checked />
    <span data-i18n="dashboard.modelMergeCheckpoints">合并日期 checkpoint</span>
  </label>
  <label class="log-toggle">
    <input type="checkbox" id="model-log-scale" />
    <span data-i18n="dashboard.logScale">对数坐标</span>
  </label>
</div>
```

Add `.model-chart-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }`. At the existing mobile breakpoint, let the title row align to the start and keep controls readable without horizontal overflow.

- [ ] **Step 4: Bind the checkbox through the existing chart lifecycle**

Extract the duplicated chart-only rerender body into a local helper:

```js
function rerenderChartsOnly() {
  if (!fullData) return;
  const filteredData = filterData(fullData, getCurrentFilter());
  destroyCharts();
  renderCharts(filteredData, { timelineMetric });
}
```

Bind both `#model-log-scale` and `#model-merge-checkpoints` change events to it. The checkbox DOM state is the current-page state; do not introduce another persistence layer or reset it during other rerenders.

- [ ] **Step 5: Remove only approved decorative Emoji**

Update both locale dictionaries and HTML fallback text for `chartTimeline`, `chartProvider`, `chartModel`, `breakdownTitle`, and `sessionDetails`. Preserve the logo, status option icons, stat-card icons, and `pricing.html`’s `💰 价格配置` exactly.

- [ ] **Step 6: Update README in Chinese and English**

Revise the dashboard bullets in both README files to state:

- Model comparison shows one Input bar split into ordinary Input, Cache Write, and Cache Read, plus an adjacent Output bar.
- Date-checkpoint variants are grouped across Providers by default, and the control can restore exact entries.
- Provider cost tooltip includes its percentage of currently filtered Provider cost.

Keep the two documents semantically synchronized; do not change unrelated pricing/cache sections.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
npx vitest run tests/unit/frontend/i18n.test.js tests/unit/frontend/charts.test.js tests/unit/frontend/model-chart-data.test.js
npm run build
```

Expected: all focused tests PASS and Vite build exits 0.

- [ ] **Step 8: Commit Task 3 only**

```bash
git add index.html src/main.js src/style.css src/locales/zh-CN.js src/locales/en-US.js tests/unit/frontend/i18n.test.js README.md README_EN.md
git diff --cached --check
git commit -m "feat(dashboard): add model grouping control and clarify headings"
```

---

### Task 4: Full Verification, Real-Browser QA, and Post-Implementation Sync Audit

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-dashboard-chart-clarity-and-model-grouping-design.md`
- Modify only if evidence reveals a defect: files from Tasks 1-3 and their focused tests.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: final spec status `已实现（同步审计后回写）` and an evidence-based implementation note.

- [ ] **Step 1: Run all automated gates from a clean index**

Run:

```bash
git diff --cached --quiet
npm test
npm run build
```

Expected: index has no staged leftovers, all Vitest projects PASS, and Vite build exits 0. Record the observed test counts and build result; do not reuse earlier results.

- [ ] **Step 2: Start the worktree build in an isolated runtime**

Create a temporary config root, link only the real read-only data sources needed for browser evidence, and use a free port. Do not invoke or modify the globally installed wrapper:

```bash
QA_CONFIG_DIR=$(mktemp -d)
mkdir -p "$QA_CONFIG_DIR"
ln -s "$HOME/.openclaw/agents" "$QA_CONFIG_DIR/agents"
if [ -f "$HOME/.openclaw/openclaw.json" ]; then
  ln -s "$HOME/.openclaw/openclaw.json" "$QA_CONFIG_DIR/openclaw.json"
fi
OPENCLAW_CONFIG_DIR="$QA_CONFIG_DIR" OPENCLAW_USAGE_PORT=3101 node scripts/openclaw-usage-cli.js build
OPENCLAW_CONFIG_DIR="$QA_CONFIG_DIR" OPENCLAW_USAGE_PORT=3101 node scripts/openclaw-usage-cli.js start
OPENCLAW_CONFIG_DIR="$QA_CONFIG_DIR" OPENCLAW_USAGE_PORT=3101 node scripts/openclaw-usage-cli.js status
```

If port 3101 is occupied, select another explicit free loopback port and use the same value for every command. This task owns this isolated process; after browser QA, stop it with the same environment and retain `QA_CONFIG_DIR` until all screenshots and fault checks are complete.

- [ ] **Step 3: Perform real-browser functional and visual QA**

Use the `playwright` skill and the launcher URL. Verify with current local data in both light and dark themes:

1. Decorative heading Emoji are gone while the approved retained icons remain.
2. Merge checkbox is checked on initial load.
3. With merging on, date-checkpoint variants across Providers produce one normalized label and summed values; with it off, exact entries return.
4. Input height equals ordinary Input + Cache Write + Cache Read; the three segments use visibly distinct same-family depths and Output remains adjacent.
5. Hovering a Model group shows ordinary Input, Cache Write, Cache Read, Total Input, and Output.
6. Linear/log switches preserve chart validity and the merge checkbox state.
7. Provider hover shows cost and a one-decimal percentage; visible shares are consistent with the filtered total.
8. Provider/Model/time filters, theme switch, and language switch rerender current data without stale chart instances.
9. Narrow viewport controls wrap without overlap or horizontal clipping.

Capture screenshots for at least: light merged chart, dark merged chart with tooltip, merge-off chart, and Provider percentage tooltip. Keep screenshots outside git unless the user requests repository artifacts.

After QA, stop the isolated process and remove only the validated temporary directory created above:

```bash
OPENCLAW_CONFIG_DIR="$QA_CONFIG_DIR" OPENCLAW_USAGE_PORT=3101 node scripts/openclaw-usage-cli.js stop
test -n "$QA_CONFIG_DIR" && test "$QA_CONFIG_DIR" != / && rm -rf -- "$QA_CONFIG_DIR"
```

- [ ] **Step 4: Fix any evidence-backed defect with a failing regression test first**

For each defect found, add the smallest failing test to the relevant focused test file, run it to confirm RED, implement the correction, rerun it to GREEN, then repeat `npm test` and `npm run build`. Do not broaden scope into unrelated refactoring.

Commit each verified correction before continuing QA, using the matching exact path set:

```bash
# Model normalization/aggregation correction
git add src/model-chart-data.js tests/unit/frontend/model-chart-data.test.js

# Chart dataset/tooltip correction
git add src/charts.js tests/unit/frontend/charts.test.js

# Control/copy/layout correction
git add index.html src/main.js src/style.css src/locales/zh-CN.js src/locales/en-US.js tests/unit/frontend/i18n.test.js

git diff --cached --check
git commit -m "fix(dashboard): correct chart verification finding"
```

Run only the matching `git add` group for the defect; never stage all three groups speculatively.

- [ ] **Step 5: Run the Post-Implementation Sync Audit**

Compare every requirement in Sections 1-6 of the design spec with code, tests, and browser evidence. Update the spec header to:

```markdown
**状态**：已实现（同步审计后回写）
```

Add an implementation note listing the actual module names, recognized checkpoint formats, exact chart stack/tooltip behavior, UI control placement, tests, gate counts, and browser evidence. If implementation intentionally differs from the original design, state the verified final behavior and rationale rather than leaving a contradiction.

- [ ] **Step 6: Re-run final gates after spec synchronization**

Run:

```bash
git diff --check
npm test
npm run build
git status --short
```

Expected: tests/build PASS; only intended task files plus the user’s pre-existing unrelated changes appear.

- [ ] **Step 7: Commit the audit and any final regression correction**

```bash
git add docs/superpowers/specs/2026-08-11-dashboard-chart-clarity-and-model-grouping-design.md
git diff --cached --check
git commit -m "docs(spec): sync dashboard chart implementation"
```

Do not stage the pre-existing unrelated paths listed in Global Constraints.
