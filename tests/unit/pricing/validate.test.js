import { describe, it, expect } from 'vitest';
import { validatePricingConfig } from '../../../pricing.js';

const base = (extra = {}) => ({
  version: '1.0',
  updated: '2026-04-20T00:00:00.000Z',
  pricing: {},
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

  it('requires exact key to contain "/"', () => {
    const cfg = base({
      pricing: { 'openaignpt-4o': { input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/provider\/model/);
  });

  it('rejects wildcard type without * or ?', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { matchType: 'wildcard', input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/wildcard/);
  });

  it('rejects negative price', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { input: -1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/非负/);
  });

  it('rejects invalid regex key', () => {
    const cfg = base({
      pricing: { '/(/': { matchType: 'regex', input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/正则/);
  });

  it('accepts cacheRead/cacheWrite as null', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { input: 1, output: 1, cacheRead: null, cacheWrite: null } },
    });
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });
});
