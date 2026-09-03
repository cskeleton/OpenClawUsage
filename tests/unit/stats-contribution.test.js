import { describe, expect, it } from 'vitest';
import { buildContributionFromRecords, mergeFileContributions } from '../../stats-contribution.js';

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
});
