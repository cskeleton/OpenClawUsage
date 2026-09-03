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

describe('buildModelChartRows', () => {
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

  it('labels same-model exact entries with their provider when merging is disabled', () => {
    const rows = buildModelChartRows({
      'provider-a/shared-model': {
        provider: 'provider-a', model: 'shared-model', input: 20,
      },
      'provider-b/shared-model': {
        provider: 'provider-b', model: 'shared-model', input: 10,
      },
    }, { mergeDateCheckpoints: false });

    expect(rows.map(({ key, label }) => [key, label])).toEqual([
      ['provider-a/shared-model', 'provider-a/shared-model'],
      ['provider-b/shared-model', 'provider-b/shared-model'],
    ]);
  });

  it('sorts by cache-inclusive input plus output rather than ordinary input', () => {
    const rows = buildModelChartRows({
      'provider-a/ordinary-input-winner': {
        provider: 'provider-a', model: 'ordinary-input-winner',
        input: 100, cacheRead: 0, cacheWrite: 0, output: 0,
      },
      'provider-b/cache-input-winner': {
        provider: 'provider-b', model: 'cache-input-winner',
        input: 50, cacheRead: 100, cacheWrite: 0, output: 0,
      },
    });

    expect(rows.map(({ key }) => key)).toEqual([
      'cache-input-winner',
      'ordinary-input-winner',
    ]);
  });

  it('sanitizes non-finite numbers without mutating source entries', () => {
    const invalid = {
      provider: 'provider-a', model: 'invalid-numbers',
      input: NaN, cacheRead: Infinity, cacheWrite: null, output: undefined,
      totalTokens: NaN, totalCost: Infinity, requests: null,
    };
    const valid = {
      provider: 'provider-a', model: 'valid-model',
      input: 10, cacheRead: 0, cacheWrite: 0, output: 5,
      totalTokens: 15, totalCost: 0.1, requests: 1,
    };
    const source = {
      'provider-a/invalid-numbers': invalid,
      'provider-a/valid-model': valid,
    };

    // 非法数字清洗后全 0 的行被过滤；源数据保持原样
    expect(buildModelChartRows(source).map((row) => row.key)).toEqual(['valid-model']);
    expect(invalid).toEqual({
      provider: 'provider-a', model: 'invalid-numbers',
      input: NaN, cacheRead: Infinity, cacheWrite: null, output: undefined,
      totalTokens: NaN, totalCost: Infinity, requests: null,
    });
  });

  it('drops rows that are entirely zero', () => {
    const rows = buildModelChartRows({
      'provider-a/zero-model': {
        provider: 'provider-a', model: 'zero-model',
        input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
        totalTokens: 0, totalCost: 0, requests: 0,
      },
      'provider-a/live-model': {
        provider: 'provider-a', model: 'live-model',
        input: 1, cacheRead: 0, cacheWrite: 0, output: 0,
        totalTokens: 1, totalCost: 0, requests: 1,
      },
    });

    expect(rows.map((row) => row.key)).toEqual(['live-model']);
  });

  it('merges routing-prefixed model names when mergeProviders is on', () => {
    const rows = buildModelChartRows({
      'bohe/bohe/deepseek-v4-flash': {
        provider: 'bohe', model: 'bohe/deepseek-v4-flash',
        input: 100, cacheRead: 0, cacheWrite: 0, output: 10,
        totalTokens: 110, totalCost: 0.5, requests: 1,
      },
      'agy/agy/deepseek-v4-flash-0731': {
        provider: 'agy', model: 'agy/deepseek-v4-flash-0731',
        input: 50, cacheRead: 0, cacheWrite: 0, output: 5,
        totalTokens: 55, totalCost: 0.2, requests: 1,
      },
    }, { mergeProviders: true });

    expect(rows).toEqual([
      expect.objectContaining({
        key: 'deepseek-v4-flash', label: 'deepseek-v4-flash',
        input: 150, output: 15, requests: 2,
      }),
    ]);
  });

  it('keeps accumulated and derived metrics finite after numeric overflow', () => {
    const rows = buildModelChartRows({
      'provider-a/overflow-model': {
        provider: 'provider-a', model: 'overflow-model', input: Number.MAX_VALUE,
      },
      'provider-b/overflow-model-0731': {
        provider: 'provider-b', model: 'overflow-model-0731', input: Number.MAX_VALUE,
      },
    });

    expect(rows[0]).toMatchObject({
      input: Number.MAX_VALUE,
      totalInput: Number.MAX_VALUE,
    });
    expect(Number.isFinite(rows[0].input)).toBe(true);
    expect(Number.isFinite(rows[0].totalInput)).toBe(true);
  });

  it('ranks overflow-sized totals by magnitude before label tie-breaking', () => {
    const rows = buildModelChartRows({
      'provider-a/a-smaller-overflow': {
        provider: 'provider-a', model: 'a-smaller-overflow',
        input: Number.MAX_VALUE, output: Number.MAX_VALUE / 2,
      },
      'provider-z/z-larger-overflow': {
        provider: 'provider-z', model: 'z-larger-overflow',
        input: Number.MAX_VALUE, output: Number.MAX_VALUE,
      },
    });

    expect(rows.map(({ key }) => key)).toEqual([
      'z-larger-overflow',
      'a-smaller-overflow',
    ]);
  });
});
