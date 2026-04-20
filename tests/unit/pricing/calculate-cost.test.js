import { describe, it, expect } from 'vitest';
import { calculateCostFromUsage } from '../../../pricing.js';

const usage = {
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 1_000_000,
  totalTokens: 4_000_000,
  cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
};

describe('calculateCostFromUsage', () => {
  it('falls back to OpenClaw cost when pricingConfig is null', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', null);
    expect(r.total).toBe(100);
    expect(r.source).toBe('openclaw');
  });

  it('falls back when enabled=false', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      enabled: false,
      pricing: { 'openai/gpt-4o': { input: 1, output: 1 } },
    });
    expect(r.source).toBe('openclaw');
  });

  it('falls back when pricing map is empty', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0', pricing: {},
    });
    expect(r.source).toBe('openclaw');
  });

  it('falls back when model not configured', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'other/m': { input: 1, output: 1 } },
    });
    expect(r.source).toBe('openclaw');
  });

  it('falls back when matched entry is disabled', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 1, output: 1, enabled: false } },
    });
    expect(r.source).toBe('openclaw');
  });

  it('applies $/M rates when configured', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 5 } },
    });
    expect(r.input).toBeCloseTo(2);
    expect(r.output).toBeCloseTo(4);
    expect(r.cacheRead).toBeCloseTo(0.5);
    expect(r.cacheWrite).toBeCloseTo(5);
    expect(r.total).toBeCloseTo(11.5);
    expect(r.source).toBe('custom');
  });

  it('falls back cache price to input when null', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 2, output: 4, cacheRead: null, cacheWrite: null } },
    });
    expect(r.cacheRead).toBeCloseTo(2);
    expect(r.cacheWrite).toBeCloseTo(2);
  });

  it('cache fallback also works when cacheRead/cacheWrite keys are absent and uses input', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 2, output: 4 } },
    });
    expect(r.cacheRead).toBeCloseTo(2);
    expect(r.cacheWrite).toBeCloseTo(2);
  });
});
