import { describe, it, expect } from 'vitest';
import { buildCatalogIndex, matchObservedKey } from '../../../pricing-catalog-matcher.js';

const catalogModels = [
  { key: 'deepseek/deepseek-v4-flash', provider: 'deepseek', model: 'deepseek-v4-flash', cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null } },
  { key: 'fireworks/deepseek-v4-flash', provider: 'fireworks', model: 'deepseek-v4-flash', cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: null } },
  { key: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { key: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: null } },
];
const index = buildCatalogIndex(catalogModels);

describe('matchObservedKey', () => {
  it('unique: messy key normalizes to catalog model id; official entry preferred when ignoreProvider=true', () => {
    const r = matchObservedKey('cpa', 'agy/deepseek-v4-flash', { index, ignoreProvider: true });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('deepseek'); // 官方条目（provider token 出现在模型 id）
    expect(r.match.prices.input).toBe(0.14);
  });

  it('ignoreProvider=false prefers the observed provider entry when present in catalog', () => {
    const r = matchObservedKey('fireworks', 'deepseek-v4-flash', { index, ignoreProvider: false });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('fireworks');
    expect(r.match.prices.input).toBe(0.5);
  });

  it('ignoreProvider=false falls back to official entry when provider not in catalog', () => {
    const r = matchObservedKey('bohe', 'deepseek-v4-flash', { index, ignoreProvider: false });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('deepseek');
  });

  it('exact multi-provider without official heuristic → ambiguous', () => {
    // catalog 中同一 model id 两个 provider 且都不满足官方启发式
    const idx2 = buildCatalogIndex([
      { key: 'a/foo-9', provider: 'a', model: 'foo-9', cost: { input: 1, output: 1, cacheRead: null, cacheWrite: null } },
      { key: 'b/foo-9', provider: 'b', model: 'foo-9', cost: { input: 2, output: 2, cacheRead: null, cacheWrite: null } },
    ]);
    const r = matchObservedKey('x', 'foo-9', { index: idx2, ignoreProvider: true });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].reason).toBe('exact-multi-provider');
  });

  it('fuzzy: -thinking suffix strips to a unique catalog entry', () => {
    const r = matchObservedKey('cpa', 'justwoker/claude-opus-5-thinking', { index, ignoreProvider: true });
    expect(r.status).toBe('unique');
    expect(r.match.model).toBe('claude-opus-5');
  });

  it('none: nothing above weak threshold', () => {
    const r = matchObservedKey('x', 'totally-unknown-model-zzz', { index, ignoreProvider: true });
    expect(r.status).toBe('none');
  });

  it('fuzzy ambiguity queues top candidates with scores and reasons', () => {
    const idx3 = buildCatalogIndex([
      { key: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', cost: { input: 2, output: 12, cacheRead: null, cacheWrite: null } },
      { key: 'openai/gpt-5.6-codex', provider: 'openai', model: 'gpt-5.6-codex', cost: { input: 2, output: 12, cacheRead: null, cacheWrite: null } },
    ]);
    const r = matchObservedKey('cpa', 'gpt-5.6-codex-mini', { index: idx3, ignoreProvider: true });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBeLessThanOrEqual(8);
    expect(r.candidates[0].score).toBeGreaterThanOrEqual(0.34);
    expect(r.candidates[0]).toHaveProperty('reason');
  });
});
