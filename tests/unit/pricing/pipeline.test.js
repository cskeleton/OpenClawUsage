import { describe, it, expect } from 'vitest';
import { resolvePricingRule, calculateCostFromUsage } from '../../../pricing.js';

const baseConfig = () => ({
  version: '2.0',
  enabled: true,
  updated: 'T',
  revision: 1,
  matching: { ignoreProvider: true, noiseSuffixes: ['-high', '-thinking'] },
  rules: {},
  aliases: {},
  patterns: {},
});

const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, totalTokens: 3e6, cost: { total: 99, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

describe('resolvePricingRule priority chain', () => {
  it('alias wins over everything', () => {
    const cfg = baseConfig();
    cfg.aliases['cpa/agy/gemini-3.8-flash-high'] = 'gemini-3.8-flash';
    cfg.rules['gemini-3.8-flash'] = { input: 0.5, output: 3, source: 'manual' };
    cfg.rules['agy/gemini-3.8-flash-high'] = { input: 9, output: 9, source: 'manual' };
    const r = resolvePricingRule('cpa', 'agy/gemini-3.8-flash-high', cfg);
    expect(r).toMatchObject({ via: 'alias', canonical: 'gemini-3.8-flash' });
    expect(r.rule.input).toBe(0.5);
  });

  it('raw exact key hit preserves v1 semantics regardless of ignoreProvider', () => {
    const cfg = baseConfig();
    cfg.rules['openai/gpt-5.5'] = { input: 5, output: 30, source: 'manual' };
    const r = resolvePricingRule('openai', 'gpt-5.5', cfg);
    expect(r).toMatchObject({ via: 'exact', matchedKey: 'openai/gpt-5.5' });
  });

  it('normalized candidate hits canonical rule across messy prefixes/suffixes', () => {
    const cfg = baseConfig();
    cfg.rules['deepseek-v4-flash'] = { input: 0.14, output: 0.28, source: 'models.dev' };
    for (const [p, m] of [
      ['cpa', 'agy/deepseek-v4-flash'],
      ['nvidia', 'deepseek-ai/deepseek-v4-flash'],
      ['bohe', 'deepseek-v4-flash'],
    ]) {
      const r = resolvePricingRule(p, m, cfg);
      expect(r, `${p}/${m}`).toMatchObject({ via: 'normalized', canonical: 'deepseek-v4-flash' });
    }
  });

  it('mimo-v2.5 rule does NOT match mimo-v2.5-pro', () => {
    const cfg = baseConfig();
    cfg.rules['mimo-v2.5'] = { input: 0.14, output: 0.28, source: 'manual' };
    expect(resolvePricingRule('cpa', 'mimo-v2.5-pro', cfg)).toBeNull();
    expect(resolvePricingRule('cpa', 'mimo-v2.5', cfg)).toMatchObject({ via: 'normalized' });
  });

  it('ignoreProvider=false prefers provider-qualified rule, then bare canonical', () => {
    const cfg = baseConfig();
    cfg.matching.ignoreProvider = false;
    cfg.rules['deepseek-v4-pro'] = { input: 0.435, output: 0.87, source: 'manual' };
    cfg.rules['fireworks/deepseek-v4-pro'] = { input: 3, output: 9, source: 'manual' };
    expect(resolvePricingRule('fireworks', 'deepseek-v4-pro', cfg).rule.input).toBe(3);
    expect(resolvePricingRule('deepseek', 'deepseek-v4-pro', cfg).rule.input).toBe(0.435);
  });

  it('ignoreProvider=true skips provider-qualified rules entirely', () => {
    const cfg = baseConfig();
    cfg.rules['fireworks/deepseek-v4-pro'] = { input: 3, output: 9, source: 'manual' };
    cfg.rules['deepseek-v4-pro'] = { input: 0.435, output: 0.87, source: 'manual' };
    expect(resolvePricingRule('fireworks', 'deepseek-v4-pro', cfg).rule.input).toBe(0.435);
  });

  it('disabled entries are skipped and search continues', () => {
    const cfg = baseConfig();
    cfg.rules['gpt-5.5'] = { input: 5, output: 30, enabled: false, source: 'manual' };
    cfg.patterns['*gpt-5.5*'] = { input: 1, output: 2, matchType: 'wildcard' };
    const r = resolvePricingRule('openai', 'gpt-5.5', cfg);
    expect(r).toMatchObject({ via: 'pattern' });
    expect(r.rule.input).toBe(1);
  });

  it('falls back to patterns then null', () => {
    const cfg = baseConfig();
    cfg.patterns['*gpt-5.4*'] = { input: 2.5, output: 15, matchType: 'wildcard' };
    expect(resolvePricingRule('anyrouter', 'claude-fable-5', cfg)).toBeNull();
    expect(resolvePricingRule('x', 'gpt-5.4-mini', cfg)).toMatchObject({ via: 'pattern' });
  });
});

describe('calculateCostFromUsage source labeling', () => {
  it('returns source models.dev for synced rules', () => {
    const cfg = baseConfig();
    cfg.rules['deepseek-v4-flash'] = { input: 0.14, output: 0.28, source: 'models.dev' };
    const r = calculateCostFromUsage(usage, 'bohe', 'deepseek-v4-flash', cfg);
    expect(r.source).toBe('models.dev');
    expect(r.canonical).toBe('deepseek-v4-flash');
    expect(r.input).toBeCloseTo(0.14);
    expect(r.cacheRead).toBeCloseTo(0.14); // cacheRead null → input 原价
  });

  it('returns source pattern for legacy wildcard hits', () => {
    const cfg = baseConfig();
    cfg.patterns['*luna*'] = { input: 0.2, output: 1.2, matchType: 'wildcard' };
    expect(calculateCostFromUsage(usage, 'openai', 'gpt-5.6-luna', cfg).source).toBe('pattern');
  });

  it('returns source openclaw when nothing matches', () => {
    const r = calculateCostFromUsage(usage, 'qwen', 'qwen3.8-max-preview', baseConfig());
    expect(r.source).toBe('openclaw');
    expect(r.total).toBe(99);
  });

  it('returns source openclaw when globally disabled', () => {
    const cfg = baseConfig();
    cfg.enabled = false;
    cfg.rules['qwen3.8-max-preview'] = { input: 1, output: 1 };
    expect(calculateCostFromUsage(usage, 'qwen', 'qwen3.8-max-preview', cfg).source).toBe('openclaw');
  });
});
