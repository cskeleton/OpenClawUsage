import { describe, it, expect } from 'vitest';
import {
  migratePricingConfigV1toV2,
  defaultPricingConfigV2,
  validatePricingConfig,
} from '../../../pricing.js';

describe('migratePricingConfigV1toV2', () => {
  it('moves exact entries to rules with source manual, patterns to patterns', () => {
    const v2 = migratePricingConfigV1toV2({
      version: '1.0',
      enabled: true,
      updated: '2026-09-01T00:00:00.000Z',
      pricing: {
        'openai/gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null },
        '*deepseek-v4-pro*': { input: 0.435, output: 0.87, matchType: 'wildcard', enabled: true },
        '/gpt-5\\.6.*/i': { input: 2, output: 12, matchType: 'regex' },
      },
    });
    expect(v2.version).toBe('2.0');
    expect(v2.revision).toBe(1);
    expect(v2.rules['openai/gpt-5.5']).toMatchObject({ input: 5, output: 30, source: 'manual' });
    expect(v2.rules['openai/gpt-5.5'].matchType).toBeUndefined();
    expect(v2.patterns['*deepseek-v4-pro*']).toMatchObject({ matchType: 'wildcard' });
    expect(v2.patterns['/gpt-5\\.6.*/i']).toMatchObject({ matchType: 'regex' });
    expect(v2.aliases).toEqual({});
    expect(v2.matching.ignoreProvider).toBe(true);
    expect(v2.matching.noiseSuffixes).toContain('-thinking');
    expect(v2.updated).toBe('2026-09-01T00:00:00.000Z'); // 保留旧时间戳
    expect(() => validatePricingConfig(v2)).not.toThrow();
  });

  it('preserves enabled=false and empty pricing', () => {
    const v2 = migratePricingConfigV1toV2({ version: '1.0', enabled: false, pricing: {} });
    expect(v2.enabled).toBe(false);
    expect(v2.rules).toEqual({});
  });
});

describe('defaultPricingConfigV2', () => {
  it('is valid and stable', () => {
    const cfg = defaultPricingConfigV2();
    expect(cfg.updated).toBe('0001-01-01T00:00:00.000Z');
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });
});
