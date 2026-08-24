# Dashboard Cache Read and Source Overview Design

## Scope

This is a bounded dashboard-only change. It does not change the stats API,
snapshot schema, sync behavior, pricing, or chart datasets.

## Cache summary card

- Keep the existing fourth summary card, disk icon, rose accent, spacing, and
  responsive placement.
- Make `Cache Read` the card label and `summary.totalCacheRead` the prominent
  value.
- Show `Write: {count}` below it using `summary.totalCacheWrite`.
- Keep all dashboard text available in both `zh-CN` and `en-US` dictionaries.

## Source overview

- Add a `Source overview / 来源概览` section immediately after the summary
  cards and before the charts.
- Show it only when the selected source is `all` and at least two configured
  sources exist. Hide it for a concrete source or fewer than two configured
  sources.
- Render every configured source, including `stale` and `missing` sources.
- Every source row displays:
  - source label and sync freshness state;
  - total tokens and share of the displayed sources' token total;
  - estimated cost;
  - request count;
  - session count.
- Compute every row with the same active date, Provider, and Model filters as
  the rest of the dashboard, changing only the source selector for that row.
  A source with no matching snapshot or usage displays zero values.
- Each row is a keyboard-accessible button. Activating it selects that source,
  clears Provider and Model exactly like the existing source selector, resets
  pagination, and re-renders the dashboard.
- Match the existing glass-card visual language. Use a compact desktop grid,
  visible token-share bar, clear status colors, hover/focus feedback, and a
  stacked mobile layout. Support the existing light/dark themes.
- Re-render all dynamic copy when the locale changes.

## Accessibility and safety

- User-provided source IDs and labels must be escaped before insertion into
  HTML or attributes.
- Status must not be communicated by color alone.
- Interactive rows must have a localized accessible name and visible keyboard
  focus.

## Verification

- DOM tests cover the Cache Read/Write hierarchy using distinct non-zero values.
- DOM tests cover visibility, all configured source rows, current-filter-aware
  metrics and token shares, zero data for missing sources, status text, click
  drill-down, and locale switching.
- Run the focused frontend DOM test, full test suite, production build, and
  `git diff --check`.
