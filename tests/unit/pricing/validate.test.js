import { describe, it, expect } from 'vitest';
import { defaultPricingConfigV2, validatePricingConfig } from '../../../pricing.js';

const base = (extra = {}) => ({
  ...defaultPricingConfigV2(),
  ...extra,
});

describe('validatePricingConfig', () => {
  it('accepts a minimally valid config', () => {
    expect(() => validatePricingConfig(base())).not.toThrow();
  });

  it('rejects non-object root', () => {
    expect(() => validatePricingConfig(null)).toThrow(/对象/);
  });

  it('rejects missing version', () => {
    expect(() => validatePricingConfig({ pricing: {} })).toThrow(/version/);
  });

  it('rejects non-boolean enabled', () => {
    expect(() => validatePricingConfig(base({ enabled: 'yes' }))).toThrow(/enabled/);
  });

  it('accepts canonical rule keys without provider prefix', () => {
    const cfg = base();
    cfg.rules['deepseek-v4-pro'] = { input: 1, output: 1, source: 'manual' };
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });

  it('rejects wildcard type without * or ?', () => {
    const cfg = base();
    cfg.patterns['openai/gpt-4o'] = { matchType: 'wildcard', input: 1, output: 1 };
    expect(() => validatePricingConfig(cfg)).toThrow(/wildcard/);
  });

  it('rejects negative price', () => {
    const cfg = base();
    cfg.rules['openai/gpt-4o'] = { input: -1, output: 1 };
    expect(() => validatePricingConfig(cfg)).toThrow(/非负/);
  });

  it('rejects invalid regex key', () => {
    const cfg = base();
    cfg.patterns['/(/'] = { matchType: 'regex', input: 1, output: 1 };
    expect(() => validatePricingConfig(cfg)).toThrow(/正则/);
  });

  it('accepts cacheRead/cacheWrite as null', () => {
    const cfg = base();
    cfg.rules['openai/gpt-4o'] = { input: 1, output: 1, cacheRead: null, cacheWrite: null };
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });
});

describe('validatePricingConfig v2', () => {
  const base = () => defaultPricingConfigV2();

  it('rejects rules entry with negative input', () => {
    const cfg = base();
    cfg.rules['m'] = { input: -1, output: 1 };
    expect(() => validatePricingConfig(cfg)).toThrow(/rules\.m/);
  });

  it('rejects invalid source value', () => {
    const cfg = base();
    cfg.rules['m'] = { input: 1, output: 1, source: 'upstream' };
    expect(() => validatePricingConfig(cfg)).toThrow(/source/);
  });

  it('rejects alias with empty target', () => {
    const cfg = base();
    cfg.aliases['cpa/agy/x'] = '';
    expect(() => validatePricingConfig(cfg)).toThrow(/aliases/);
  });

  it('rejects non-boolean matching.ignoreProvider', () => {
    const cfg = base();
    cfg.matching.ignoreProvider = 'yes';
    expect(() => validatePricingConfig(cfg)).toThrow(/ignoreProvider/);
  });

  it('accepts explicit zero cache prices (configured ≠ unset)', () => {
    const cfg = base();
    cfg.rules['m'] = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });

  it('still validates pattern entries (wildcard needs * or ?, regex must compile)', () => {
    const cfg = base();
    cfg.patterns['no-wildcard-here'] = { input: 1, output: 1, matchType: 'wildcard' };
    expect(() => validatePricingConfig(cfg)).toThrow(/wildcard/);
  });
});
