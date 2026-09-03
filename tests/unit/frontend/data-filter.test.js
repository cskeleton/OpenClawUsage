import { describe, it, expect } from 'vitest';
import {
  filterDataByDateRange,
  filterData,
  buildKeyMatcher,
  selectSourceData,
  sourceOptions,
} from '../../../src/data-filter.js';

const bucket = (input, output) => ({
  input, output, cacheRead: 0, cacheWrite: 0,
  totalTokens: input + output, totalCost: input / 100 + output / 100, requests: 1,
});

const fullData = {
  summary: {},
  byDate: {
    '2026-04-15': bucket(100, 50),
    '2026-04-16': bucket(200, 100),
    '2026-04-17': bucket(300, 150),
  },
  byDateProvider: {
    '2026-04-15': { openai: bucket(100, 50) },
    '2026-04-16': { anthropic: bucket(200, 100) },
    '2026-04-17': { openai: bucket(300, 150) },
  },
  byDateModel: {
    '2026-04-15': { 'openai/gpt-4o': bucket(100, 50) },
    '2026-04-16': { 'anthropic/claude-sonnet-4': bucket(200, 100) },
    '2026-04-17': { 'openai/gpt-4o': bucket(300, 150) },
  },
  sessions: [
    { id: 's1', byDate: { '2026-04-15': bucket(100, 50) }, lastTimestamp: '2026-04-15T00:00:00Z' },
    { id: 's2', byDate: { '2026-04-17': bucket(300, 150) }, lastTimestamp: '2026-04-17T00:00:00Z' },
  ],
  generatedAt: '2026-04-20T00:00:00Z',
};

describe('filterDataByDateRange', () => {
  it('returns original data when no range', () => {
    expect(filterDataByDateRange(fullData, null, null)).toBe(fullData);
  });

  it('filters by from only', () => {
    const r = filterDataByDateRange(fullData, '2026-04-16', null);
    expect(Object.keys(r.byDate).sort()).toEqual(['2026-04-16', '2026-04-17']);
    expect(r.summary.totalInput).toBe(500);
  });

  it('filters by to only', () => {
    const r = filterDataByDateRange(fullData, null, '2026-04-15');
    expect(Object.keys(r.byDate)).toEqual(['2026-04-15']);
  });

  it('collapses byDateProvider into byProvider over range', () => {
    const r = filterDataByDateRange(fullData, '2026-04-15', '2026-04-16');
    expect(r.byProvider).toHaveProperty('openai');
    expect(r.byProvider).toHaveProperty('anthropic');
    expect(r.byProvider.openai.input).toBe(100);
    expect(r.byProvider.anthropic.input).toBe(200);
  });

  it('collapses byDateModel into byModel with provider/model split', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.byModel['openai/gpt-4o'].provider).toBe('openai');
    expect(r.byModel['openai/gpt-4o'].model).toBe('gpt-4o');
    expect(r.byModel['openai/gpt-4o'].input).toBe(300);
  });

  it('filters sessions by byDate and recomputes totals', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(r.sessions[0].totalInput).toBe(300);
    expect(r.summary.totalSessions).toBe(1);
  });

  it('drops sessions with no overlap in range', () => {
    const r = filterDataByDateRange(fullData, '2026-04-18', null);
    expect(r.sessions).toEqual([]);
    expect(r.summary.totalSessions).toBe(0);
  });
});

// ---- Provider / Model 维度筛选 ----

/** 单日内混用两个 provider 的会话，用于验证「精确到 model」的切片 */
const mixedData = {
  summary: {},
  byDate: {
    '2026-04-15': bucket(300, 150),
    '2026-04-16': bucket(200, 100),
  },
  byDateProvider: {
    '2026-04-15': { openai: bucket(100, 50), anthropic: bucket(200, 100) },
    '2026-04-16': { anthropic: bucket(200, 100) },
  },
  byDateModel: {
    '2026-04-15': {
      'openai/gpt-4o': bucket(100, 50),
      'anthropic/claude-opus-5': bucket(200, 100),
    },
    '2026-04-16': { 'anthropic/claude-sonnet-5': bucket(200, 100) },
  },
  sessions: [
    {
      id: 'mixed',
      providers: ['openai', 'anthropic'],
      models: ['gpt-4o', 'claude-opus-5'],
      lastTimestamp: '2026-04-15T00:00:00Z',
      byDate: { '2026-04-15': bucket(300, 150) },
      byDateModel: {
        '2026-04-15': {
          'openai/gpt-4o': bucket(100, 50),
          'anthropic/claude-opus-5': bucket(200, 100),
        },
      },
    },
    {
      id: 'sonnet-only',
      providers: ['anthropic'],
      models: ['claude-sonnet-5'],
      lastTimestamp: '2026-04-16T00:00:00Z',
      byDate: { '2026-04-16': bucket(200, 100) },
      byDateModel: { '2026-04-16': { 'anthropic/claude-sonnet-5': bucket(200, 100) } },
    },
  ],
  generatedAt: '2026-04-20T00:00:00Z',
};

describe('buildKeyMatcher', () => {
  it('returns null without dimension filter', () => {
    expect(buildKeyMatcher({})).toBeNull();
  });

  it('matches by provider prefix only', () => {
    const m = buildKeyMatcher({ provider: 'openai' });
    expect(m('openai/gpt-4o')).toBe(true);
    expect(m('openai-proxy/gpt-4o')).toBe(false);
    expect(m('anthropic/claude-opus-5')).toBe(false);
  });

  it('model filter wins over provider', () => {
    const m = buildKeyMatcher({ provider: 'anthropic', model: 'openai/gpt-4o' });
    expect(m('openai/gpt-4o')).toBe(true);
    expect(m('anthropic/claude-opus-5')).toBe(false);
  });
});

describe('filterData with provider/model', () => {
  it('returns original data without any filter', () => {
    expect(filterData(mixedData, {})).toBe(mixedData);
  });

  it('slices summary/byDate to the selected provider', () => {
    const r = filterData(mixedData, { provider: 'anthropic' });
    expect(r.summary.totalInput).toBe(400);
    expect(r.byDate['2026-04-15'].input).toBe(200);
    expect(r.byDate['2026-04-16'].input).toBe(200);
    expect(Object.keys(r.byProvider)).toEqual(['anthropic']);
    expect(Object.keys(r.byModel).sort())
      .toEqual(['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']);
  });

  it('slices to a single model key', () => {
    const r = filterData(mixedData, { model: 'anthropic/claude-opus-5' });
    expect(Object.keys(r.byModel)).toEqual(['anthropic/claude-opus-5']);
    expect(r.summary.totalInput).toBe(200);
    expect(Object.keys(r.byDate)).toEqual(['2026-04-15']);
  });

  it('recomputes mixed-model session totals for the selected model', () => {
    const r = filterData(mixedData, { model: 'openai/gpt-4o' });
    expect(r.sessions.map((s) => s.id)).toEqual(['mixed']);
    // 该会话当天共 300 input，但 openai/gpt-4o 只占 100
    expect(r.sessions[0].totalInput).toBe(100);
    expect(r.sessions[0].totalOutput).toBe(50);
    expect(r.sessions[0].requestCount).toBe(1);
    expect(r.summary.totalSessions).toBe(1);
  });

  it('combines date range with dimension filter', () => {
    const r = filterData(mixedData, {
      from: '2026-04-16', to: '2026-04-16', provider: 'anthropic',
    });
    expect(Object.keys(r.byDate)).toEqual(['2026-04-16']);
    expect(r.sessions.map((s) => s.id)).toEqual(['sonnet-only']);
    expect(r.summary.totalInput).toBe(200);
  });

  it('drops sessions that never used the selected model', () => {
    const r = filterData(mixedData, { model: 'anthropic/claude-sonnet-5' });
    expect(r.sessions.map((s) => s.id)).toEqual(['sonnet-only']);
  });

  it('falls back to whole-session totals when byDateModel is missing (legacy snapshot)', () => {
    const legacy = {
      ...mixedData,
      sessions: [
        {
          id: 'legacy',
          providers: ['openai', 'anthropic'],
          models: ['gpt-4o', 'claude-opus-5'],
          lastTimestamp: '2026-04-15T00:00:00Z',
          byDate: { '2026-04-15': bucket(300, 150) },
        },
      ],
    };

    const hit = filterData(legacy, { model: 'openai/gpt-4o' });
    expect(hit.sessions.map((s) => s.id)).toEqual(['legacy']);
    // 回退路径给出整期合计（宁可偏大，也不静默丢数据）
    expect(hit.sessions[0].totalInput).toBe(300);

    const miss = filterData(legacy, { provider: 'mistral' });
    expect(miss.sessions).toEqual([]);
  });
});

describe('filterData with source selection', () => {
  const local = {
    ...mixedData,
    sessions: [{ ...mixedData.sessions[0], sourceId: 'local', sourceLabel: 'Local' }],
  };
  const remote = {
    ...mixedData,
    byDate: { '2026-04-16': bucket(700, 80) },
    byDateProvider: { '2026-04-16': { anthropic: bucket(700, 80) } },
    byDateModel: { '2026-04-16': { 'anthropic/claude-sonnet-5': bucket(700, 80) } },
    sessions: [{ ...mixedData.sessions[1], sourceId: 'remote', sourceLabel: 'MBP' }],
  };
  const multiSource = {
    ...mixedData,
    statsBySource: { local, remote },
    sources: [
      { id: 'local', label: 'Local', kind: 'local', status: 'fresh' },
      { id: 'remote', label: 'MBP', kind: 'imported', status: 'stale', lastReceivedAt: '2026-04-10T00:00:00Z', staleSince: '2026-04-11T00:00:00Z' },
      { id: 'missing', label: 'Other', kind: 'imported', status: 'missing' },
    ],
  };

  it('selects a source before date/provider/model filtering and leaves All combined', () => {
    expect(selectSourceData(multiSource, 'all')).toBe(multiSource);
    expect(selectSourceData(multiSource, 'remote')).toBe(remote);
    const filtered = filterData(multiSource, {
      source: 'remote', from: '2026-04-16', to: '2026-04-16', provider: 'anthropic',
    });
    expect(filtered.summary.totalInput).toBe(700);
    expect(filtered.sessions[0].sourceLabel).toBe('MBP');
  });

  it('returns an empty source shape for configured but missing sources', () => {
    const filtered = filterData(multiSource, { source: 'missing' });
    expect(filtered.summary.totalTokens).toBe(0);
    expect(filtered.sessions).toEqual([]);
    expect(filtered.sourceId).toBe('missing');
  });

  it('builds source options including stale and missing sources', () => {
    expect(sourceOptions(multiSource)).toEqual([
      { id: 'all', label: 'All sources', status: 'all' },
      { id: 'local', label: 'Local', status: 'fresh' },
      { id: 'remote', label: 'MBP', status: 'stale' },
      { id: 'missing', label: 'Other', status: 'missing' },
    ]);
  });
});

describe('filterData with reserved provider and model names', () => {
  it('preserves own JSON rows without mutating Object.prototype', () => {
    delete Object.prototype.input;
    const date = '2026-04-15';
    const dangerous = ['__proto__', 'constructor', 'toString'];
    const byProvider = JSON.parse(`{"${date}":{${dangerous.map((name) => `"${name}":${JSON.stringify(bucket(10, 1))}`).join(',')}}}`);
    const byModel = JSON.parse(`{"${date}":{${dangerous.map((name) => `"${name}/model":${JSON.stringify(bucket(10, 1))}`).join(',')}}}`);
    const data = {
      byDate: { [date]: bucket(30, 3) },
      byDateProvider: byProvider,
      byDateModel: byModel,
      sessions: [],
    };

    for (const name of dangerous) {
      const providerFiltered = filterData(data, { from: date, to: date, provider: name });
      expect(Object.keys(providerFiltered.byProvider)).toContain(name);
      expect(Object.keys(providerFiltered.byModel)).toContain(`${name}/model`);
      expect(providerFiltered.byProvider[name].input).toBe(10);

      const modelFiltered = filterData(data, { from: date, to: date, model: `${name}/model` });
      expect(Object.keys(modelFiltered.byProvider)).toContain(name);
      expect(Object.keys(modelFiltered.byModel)).toContain(`${name}/model`);
      expect(modelFiltered.byModel[`${name}/model`].input).toBe(10);
    }

    expect(Object.hasOwn(Object.prototype, 'input')).toBe(false);
  });
});

describe('sliceHourTable / byHour', () => {
  const hourlyData = {
    ...fullData,
    byHourModel: {
      '2026-04-15T08': { 'openai/gpt-4o': bucket(60, 20), 'anthropic/claude-sonnet-4': bucket(40, 10) },
      '2026-04-15T09': { 'openai/gpt-4o': bucket(100, 30) },
      '2026-04-16T01': { 'openai/gpt-4o': bucket(200, 100) },
    },
  };

  it('aggregates hour buckets across models for a single-day range', () => {
    const r = filterData(hourlyData, { from: '2026-04-15', to: '2026-04-15' });
    expect(Object.keys(r.byHour).sort()).toEqual(['2026-04-15T08', '2026-04-15T09']);
    expect(r.byHour['2026-04-15T08']).toMatchObject({ input: 100, output: 30 });
  });

  it('respects the model matcher when slicing hours', () => {
    const r = filterData(hourlyData, {
      from: '2026-04-15', to: '2026-04-16', model: 'openai/gpt-4o',
    });
    expect(r.byHour['2026-04-15T08']).toMatchObject({ input: 60, output: 20 });
    expect(Object.keys(r.byHour).sort()).toEqual([
      '2026-04-15T08', '2026-04-15T09', '2026-04-16T01',
    ]);
  });

  it('attaches byHour on the unfiltered path when byHourModel exists', () => {
    const r = filterData(hourlyData, {});
    expect(Object.keys(r.byHour)).toHaveLength(3);
  });
});
