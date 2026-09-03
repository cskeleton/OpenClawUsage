import { describe, expect, it } from 'vitest';
import { buildContributionFromRecords, mergeFileContributions, normalizeTzOffsetMinutes } from '../../stats-contribution.js';

function contribution(input) {
  return {
    hasRecords: true,
    session: { id: 'session', status: 'active', archivedAt: null },
    firstTimestamp: '2026-08-24T00:00:00.000Z',
    lastTimestamp: '2026-08-24T00:00:00.000Z',
    buckets: [{
      date: '2026-08-24',
      provider: 'provider',
      model: 'model',
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input },
      openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      requests: 1,
    }],
  };
}

function usageRecord(timestamp, input, output = 0) {
  return {
    provider: 'provider',
    model: 'model',
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
    openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp,
  };
}

describe('mergeFileContributions numeric safety', () => {
  it('rejects an aggregate that would become unsafe instead of returning Infinity', () => {
    const files = {
      first: contribution(Number.MAX_SAFE_INTEGER),
      second: contribution(1),
    };
    expect(() => mergeFileContributions(files, { enabled: false, pricing: {} }))
      .toThrow(/safe|finite|aggregate/i);
  });
});

describe('hour-granular buckets', () => {
  it('buckets records by UTC hour', () => {
    const result = buildContributionFromRecords(
      { id: 's', status: 'active', archivedAt: null },
      [
        usageRecord('2026-09-03T08:10:00.000Z', 100),
        usageRecord('2026-09-03T08:50:00.000Z', 200),
        usageRecord('2026-09-03T09:05:00.000Z', 300),
      ],
    );

    expect(result.buckets.map((b) => [b.date, b.usage.input])).toEqual([
      ['2026-09-03T08', 300],
      ['2026-09-03T09', 300],
    ]);
  });

  it('rolls hour buckets up into day tables and emits byHourModel', () => {
    const files = {
      one: buildContributionFromRecords(
        { id: 's', status: 'active', archivedAt: null },
        [
          usageRecord('2026-09-03T08:10:00.000Z', 100, 10),
          usageRecord('2026-09-03T09:05:00.000Z', 200, 20),
        ],
      ),
    };
    const stats = mergeFileContributions(files, { enabled: false, pricing: {} });

    expect(Object.keys(stats.byDate)).toEqual(['2026-09-03']);
    expect(stats.byDate['2026-09-03']).toMatchObject({ input: 300, output: 30, requests: 2 });
    expect(Object.keys(stats.byDateModel)).toEqual(['2026-09-03']);
    expect(Object.keys(stats.byHourModel)).toEqual(['2026-09-03T08', '2026-09-03T09']);
    expect(stats.byHourModel['2026-09-03T08']['provider/model'])
      .toMatchObject({ input: 100, output: 10 });
  });

  it('keeps legacy day-precision buckets out of byHourModel', () => {
    const stats = mergeFileContributions(
      { legacy: contribution(100) },
      { enabled: false, pricing: {} },
    );

    expect(stats.byDate['2026-08-24']).toMatchObject({ input: 100 });
    expect(stats.byHourModel).toEqual({});
  });

  it('rolls hour buckets into viewer-timezone days', () => {
    const files = {
      one: buildContributionFromRecords(
        { id: 's', status: 'active', archivedAt: null },
        [
          // UTC 9/3 16:30 = UTC+8 的 9/4 00:30；UTC 9/3 15:30 = UTC+8 的 9/3 23:30
          usageRecord('2026-09-03T15:30:00.000Z', 100),
          usageRecord('2026-09-03T16:30:00.000Z', 200),
        ],
      ),
    };

    const utc = mergeFileContributions(files, { enabled: false, pricing: {} });
    expect(Object.keys(utc.byDate)).toEqual(['2026-09-03']);

    const plus8 = mergeFileContributions(files, { enabled: false, pricing: {} }, { tzOffsetMinutes: 480 });
    expect(Object.keys(plus8.byDate)).toEqual(['2026-09-03', '2026-09-04']);
    expect(plus8.byDate['2026-09-03']).toMatchObject({ input: 100 });
    expect(plus8.byDate['2026-09-04']).toMatchObject({ input: 200 });
    // 小时表保持 UTC 键不变，仅日级归日受时区影响
    expect(Object.keys(plus8.byHourModel)).toEqual(['2026-09-03T15', '2026-09-03T16']);

    const minus5 = mergeFileContributions(files, { enabled: false, pricing: {} }, { tzOffsetMinutes: -300 });
    expect(Object.keys(minus5.byDate)).toEqual(['2026-09-03']);
  });

  it('normalizes invalid timezone offsets back to UTC', () => {
    expect(normalizeTzOffsetMinutes(480)).toBe(480);
    expect(normalizeTzOffsetMinutes('480')).toBe(480);
    expect(normalizeTzOffsetMinutes(841)).toBe(0);
    expect(normalizeTzOffsetMinutes(-841)).toBe(0);
    expect(normalizeTzOffsetMinutes('abc')).toBe(0);
    expect(normalizeTzOffsetMinutes(undefined)).toBe(0);
  });
});
