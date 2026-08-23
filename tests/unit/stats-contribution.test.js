import { describe, expect, it } from 'vitest';
import { mergeFileContributions } from '../../stats-contribution.js';

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
