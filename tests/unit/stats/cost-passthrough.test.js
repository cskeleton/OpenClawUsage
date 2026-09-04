import { describe, it, expect } from 'vitest';
import { mergeFileContributions, STATS_SHAPE_VERSION } from '../../../stats-contribution.js';

const config = {
  version: '2.0', enabled: true, updated: 'T', revision: 1,
  matching: { ignoreProvider: true, noiseSuffixes: ['-high', '-thinking'] },
  rules: { 'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null, source: 'models.dev' } },
  aliases: {},
  patterns: { '*gpt-5.4*': { input: 2.5, output: 15, matchType: 'wildcard' } },
};

function contributionOf(provider, model, usage) {
  return {
    session: { id: 's1', status: 'done', archivedAt: null },
    buckets: [{
      date: '2026-09-03T10', provider, model,
      usage: { totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, ...usage },
      openclawCost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      requests: 1,
    }],
    hasRecords: true,
    firstTimestamp: '2026-09-03T10:00:00Z',
    lastTimestamp: '2026-09-03T10:05:00Z',
  };
}

describe('merge passthrough', () => {
  it('byModel rows carry canonical/costSource/costBreakdown', () => {
    const stats = mergeFileContributions({
      a: contributionOf('nvidia', 'deepseek-ai/deepseek-v4-flash', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }),
      b: contributionOf('x', 'gpt-5.4-mini', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
      c: contributionOf('qwen', 'qwen3.8-max-preview', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }, config);
    const flash = stats.byModel['nvidia/deepseek-ai/deepseek-v4-flash'];
    expect(flash.canonical).toBe('deepseek-v4-flash');
    expect(flash.costSource).toBe('models.dev');
    expect(flash.costBreakdown.input).toBeCloseTo(0.14);
    expect(flash.costBreakdown.cacheRead).toBeCloseTo(0.0028);
    expect(stats.byModel['x/gpt-5.4-mini'].costSource).toBe('pattern');
    const miss = stats.byModel['qwen/qwen3.8-max-preview'];
    expect(miss.costSource).toBe('openclaw');
    expect(miss.totalCost).toBe(10); // 账面价
  });

  it('summary carries costBySource totals', () => {
    const stats = mergeFileContributions({
      a: contributionOf('bohe', 'deepseek-v4-flash', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
      c: contributionOf('qwen', 'qwen3.8-max-preview', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }, config);
    expect(stats.summary.costBySource['models.dev']).toBeCloseTo(0.14);
    expect(stats.summary.costBySource.openclaw).toBe(10);
  });

  it('shape version bumped to 4', () => {
    expect(STATS_SHAPE_VERSION).toBe(4);
  });
});
