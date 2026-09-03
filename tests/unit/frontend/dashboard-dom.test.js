import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/charts.js', () => ({
  renderCharts: vi.fn(),
  destroyCharts: vi.fn(),
}));

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

function ensureLocalStorage() {
  if (typeof localStorage?.setItem === 'function') return;
  const values = new Map();
  const mock = {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: mock });
}

function bucket(input, output = 10) {
  return {
    input,
    output,
    cacheRead: input / 2,
    cacheWrite: input / 4,
    totalTokens: input + output,
    totalCost: input / 100,
    requests: 1,
  };
}

function addKey(target, date, key, stats) {
  target[date] ||= {};
  target[date][key] = stats;
}

function sourceStats(sourceId, sourceLabel, key, input, sessionCount = 1, today, yesterday) {
  const todayBucket = bucket(input);
  const yesterdayBucket = bucket(Math.max(1, Math.floor(input / 2)));
  const todayAggregate = bucket(input * sessionCount, 10 * sessionCount);
  const yesterdayAggregate = bucket(Math.max(1, Math.floor(input / 2)) * sessionCount, 10 * sessionCount);
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    id: `${sourceId}-session-${index}`,
    sourceId,
    sourceLabel,
    status: 'active',
    providers: [key.split('/')[0]],
    models: [key.split('/')[1]],
    totalTokens: todayBucket.totalTokens,
    totalInput: todayBucket.input,
    totalOutput: todayBucket.output,
    totalCost: todayBucket.totalCost,
    requestCount: todayBucket.requests,
    firstTimestamp: `${today}T00:00:00.000Z`,
    lastTimestamp: `${today}T12:00:00.000Z`,
    byDate: { [today]: todayBucket },
    byDateModel: { [today]: { [key]: todayBucket } },
  }));
  return {
    summary: {},
    byDate: { [today]: todayAggregate, [yesterday]: yesterdayAggregate },
    byDateProvider: {
      [today]: { [key.split('/')[0]]: todayAggregate },
      [yesterday]: { [key.split('/')[0]]: yesterdayAggregate },
    },
    byDateModel: { [today]: { [key]: todayAggregate }, [yesterday]: { [key]: yesterdayAggregate } },
    sessions,
    generatedAt: `${today}T12:00:00.000Z`,
  };
}

function combinedStats(local, remote, today, yesterday) {
  const all = {
    summary: {},
    byDate: {},
    byDateProvider: {},
    byDateModel: {},
    sessions: [...local.sessions, ...remote.sessions],
    generatedAt: `${today}T12:00:00.000Z`,
  };
  for (const source of [local, remote]) {
    for (const [date, map] of Object.entries(source.byDateModel)) {
      for (const [key, stats] of Object.entries(map)) addKey(all.byDateModel, date, key, stats);
    }
    for (const [date, map] of Object.entries(source.byDateProvider)) {
      for (const [key, stats] of Object.entries(map)) addKey(all.byDateProvider, date, key, stats);
    }
    for (const [date, stats] of Object.entries(source.byDate)) {
      all.byDate[date] ||= bucket(0, 0);
      all.byDate[date].input += stats.input;
      all.byDate[date].output += stats.output;
      all.byDate[date].cacheRead += stats.cacheRead;
      all.byDate[date].cacheWrite += stats.cacheWrite;
      all.byDate[date].totalTokens += stats.totalTokens;
      all.byDate[date].totalCost += stats.totalCost;
      all.byDate[date].requests += stats.requests;
    }
  }
  return all;
}

function makeStats({ canSync = true } = {}) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  const yesterday = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`;
  const local = sourceStats('local', 'Local', 'openai/gpt-4o', 100, 1, today, yesterday);
  const remote = sourceStats('remote', 'MBP', 'anthropic/claude-sonnet-5', 700, 11, today, yesterday);
  const combined = combinedStats(local, remote, today, yesterday);
  return {
    ...combined,
    statsBySource: { local, remote },
    sources: [
      { id: 'local', label: 'Local', kind: 'local', status: 'fresh' },
      { id: 'remote', label: 'MBP', kind: 'imported', status: 'stale', lastReceivedAt: '2026-04-10T00:00:00.000Z', staleSince: '2026-04-11T00:00:00.000Z' },
      { id: 'missing', label: 'Other', kind: 'imported', status: 'missing', lastReceivedAt: null, staleSince: null },
    ],
    instance: {
      source: { id: 'local', label: 'Local' },
      capabilities: canSync ? { canSync: true, outboundTargets: [{ id: 'claw', label: 'claw' }] } : { canSync: false, outboundTargets: [] },
    },
    cache: { state: 'fresh' },
  };
}

async function loadDashboard(statsResponses) {
  ensureLocalStorage();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  document.documentElement.className = 'theme-light';
  localStorage.setItem('openclaw-locale', 'en-US');
  const stats = [...statsResponses];
  globalThis.fetch = vi.fn(async (url, options) => {
    // /api/stats 可能携带 tzOffset / fresh 查询参数，按路径前缀匹配
    if (typeof url === 'string' && url.startsWith('/api/stats')) return new Response(JSON.stringify(stats.shift() || statsResponses.at(-1)), { status: 200 });
    if (url === '/api/refresh') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url === '/api/sync/run') {
      globalThis.__lastSyncRequest = { url, options };
      return new Response(JSON.stringify({ ok: true, targetId: 'claw' }), { status: 200 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.resetModules();
  await import('../../../src/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Dashboard multi-source DOM flow', () => {
  beforeEach(() => {
    globalThis.__lastSyncRequest = null;
  });

  it('filters source/provider/model/date, resets pagination, renders source/status, clears all dimensions, and syncs', async () => {
    const stats = makeStats();
    const noSync = makeStats({ canSync: false });
    await loadDashboard([stats, noSync]);
    const source = document.getElementById('source-filter');
    const provider = document.getElementById('provider-filter');
    const model = document.getElementById('model-filter');
    const clear = document.getElementById('clear-dimension-filter');

    expect([...source.options].map((option) => option.value)).toEqual(['all', 'local', 'remote', 'missing']);
    expect(document.getElementById('source-status').textContent).toContain('MBP');
    expect(document.getElementById('source-status').textContent).toContain('Other');

    source.value = 'remote';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clear.hidden).toBe(false);
    expect([...provider.options].map((option) => option.value)).toEqual(['', 'anthropic']);
    expect([...model.options].map((option) => option.value)).toEqual(['', 'anthropic/claude-sonnet-5']);
    expect(document.querySelector('#breakdown-tbody .breakdown-key').textContent).toBe('anthropic');
    expect(document.querySelector('#sessions-tbody .source-label').textContent).toBe('MBP');
    expect(document.querySelector('#summary-cards .stat-value').textContent).toBe('7.8K');

    provider.value = 'anthropic';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    model.value = 'anthropic/claude-sonnet-5';
    model.dispatchEvent(new Event('change', { bubbles: true }));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayValue = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    document.getElementById('date-from').value = yesterdayValue;
    document.getElementById('date-to').value = yesterdayValue;
    document.getElementById('date-from').dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('summary-cards').textContent).toContain('4.0K');

    document.querySelector('[data-range="today"]').click();
    document.getElementById('page-size').value = '10';
    document.getElementById('page-size').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#page-buttons [data-page="2"]')?.click();
    source.value = 'local';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('pagination-info').textContent).toContain('1');

    clear.click();
    expect(source.value).toBe('all');
    expect(provider.value).toBe('');
    expect(model.value).toBe('');

    document.getElementById('refresh-menu-btn').click();
    expect(document.querySelector('[data-sync-target]')?.textContent).toBe('Sync to claw');
    document.querySelector('[data-locale-control="zh-CN"]').click();
    expect(document.querySelector('[data-sync-target]')?.textContent).toBe('同步到 claw');
    expect(document.querySelectorAll('.refresh-dropdown-separator')).toHaveLength(1);
    document.querySelector('[data-sync-target]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(globalThis.__lastSyncRequest.options.body).toBe(JSON.stringify({ targetId: 'claw' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById('refresh-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-sync-target]')).toBeNull();
  });

  it('renders cache hierarchy and filter-aware source overview drill-down', async () => {
    const stats = makeStats();
    await loadDashboard([stats]);

    const cacheCard = document.querySelector('#summary-cards .stat-card:nth-child(4)');
    expect(cacheCard.querySelector('.stat-label').textContent).toBe('Cache Read');
    expect(cacheCard.querySelector('.stat-value').textContent).toBe('3.9K');
    expect(cacheCard.querySelector('.stat-sub').textContent).toBe('Write: 1.9K');

    const overview = document.getElementById('source-overview');
    expect(overview.hidden).toBe(false);
    expect(overview.textContent).toContain('Source overview');
    expect(overview.textContent).toContain('Local');
    expect(overview.textContent).toContain('MBP');
    expect(overview.textContent).toContain('Other');
    expect(overview.textContent).toContain('Stale');
    expect(overview.textContent).toContain('Missing');

    const row = (id) => overview.querySelector(`[data-source-overview-id="${id}"]`);
    expect(row('local').querySelector('.source-overview-tokens').textContent).toBe('110');
    expect(row('local').querySelector('.source-overview-cost').textContent).toBe('$1.00');
    expect(row('local').querySelector('.source-overview-requests').textContent).toBe('1');
    expect(row('local').querySelector('.source-overview-sessions').textContent).toBe('1');
    expect(row('local').querySelector('.source-overview-share').textContent).toBe('1.4%');
    expect(row('remote').querySelector('.source-overview-tokens').textContent).toBe('7.8K');
    expect(row('remote').querySelector('.source-overview-share').textContent).toBe('98.6%');
    expect(row('missing').querySelector('.source-overview-tokens').textContent).toBe('0');
    expect(row('missing').querySelector('.source-overview-cost').textContent).toBe('$0.000000');

    const provider = document.getElementById('provider-filter');
    provider.value = 'anthropic';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(row('local').querySelector('.source-overview-tokens').textContent).toBe('0');
    expect(row('remote').querySelector('.source-overview-tokens').textContent).toBe('7.8K');
    expect(row('remote').querySelector('.source-overview-share').textContent).toBe('100.0%');

    document.querySelector('#page-buttons [data-page="2"]').click();
    row('remote').click();
    expect(document.getElementById('source-filter').value).toBe('remote');
    expect(provider.value).toBe('');
    expect(document.getElementById('model-filter').value).toBe('');
    expect(overview.hidden).toBe(true);
    expect(document.getElementById('pagination-info').textContent).toContain('1-10');
  });

  it('renders all session status badges including SQLite-era done', async () => {
    const stats = makeStats();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dayBucket = {
      input: 50, output: 50, cacheRead: 0, cacheWrite: 0,
      totalTokens: 100, totalCost: 0.1, requests: 1,
    };
    stats.sessions = ['active', 'done', 'reset', 'deleted'].map((status, index) => ({
      id: `0000000${index}-0000-0000-0000-00000000000${index}`,
      sourceId: 'local',
      sourceLabel: 'Local',
      status,
      providers: ['anthropic'],
      models: ['anthropic/claude-sonnet-5'],
      totalTokens: 100,
      totalInput: 50,
      totalOutput: 50,
      totalCost: 0.1,
      requestCount: 1,
      lastTimestamp: '2026-09-03T00:00:00.000Z',
      byDate: { [today]: dayBucket },
      byDateModel: {},
    }));
    await loadDashboard([stats]);

    const badges = [...document.querySelectorAll('#sessions-tbody .status-badge')];
    expect(badges).toHaveLength(4);
    expect(badges[0].className).toContain('status-active');
    expect(badges[1].className).toContain('status-done');
    expect(badges[1].textContent).toContain('Done');
    expect(badges[2].className).toContain('status-reset');
    expect(badges[3].className).toContain('status-deleted');

    const statusFilter = document.getElementById('status-filter');
    expect([...statusFilter.options].map((o) => o.value)).toEqual(['all', 'active', 'done', 'reset', 'deleted']);
    statusFilter.value = 'done';
    statusFilter.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelectorAll('#sessions-tbody tr')).toHaveLength(1);
  });
});
