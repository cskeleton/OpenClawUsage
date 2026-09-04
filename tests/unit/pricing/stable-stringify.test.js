import { describe, it, expect } from 'vitest';
import { stablePricingStringify } from '../../../pricing.js';

describe('stablePricingStringify', () => {
  it('is insensitive to top-level key order', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(stablePricingStringify(a)).toBe(stablePricingStringify(b));
  });

  it('is insensitive to nested object key order', () => {
    const a = { rules: { m: { input: 1, output: 2 } }, meta: { deep: { p: 1, q: 2 } } };
    const b = { meta: { deep: { q: 2, p: 1 } }, rules: { m: { output: 2, input: 1 } } };
    expect(stablePricingStringify(a)).toBe(stablePricingStringify(b));
  });

  it('treats arrays as order-sensitive', () => {
    const a = { noiseSuffixes: ['-high', '-low'] };
    const b = { noiseSuffixes: ['-low', '-high'] };
    expect(stablePricingStringify(a)).not.toBe(stablePricingStringify(b));
  });

  it('serializes scalars and undefined safely', () => {
    expect(stablePricingStringify(undefined)).toBe('null');
    expect(stablePricingStringify({ a: undefined })).toBe('{"a":null}');
    expect(stablePricingStringify('s')).toBe('"s"');
  });
});
