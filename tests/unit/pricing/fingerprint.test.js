import { describe, it, expect } from 'vitest';
import { buildPricingFingerprint, fingerprintsEqual } from '../../../stats-cache-store.js';

describe('buildPricingFingerprint', () => {
  it('is key-order insensitive (revision/updated capture content)', () => {
    const a = { version: '2.0', enabled: true, updated: 'T1', revision: 3, rules: { a: { input: 1 }, b: { input: 2 } } };
    const b = { revision: 3, updated: 'T1', enabled: true, version: '2.0', rules: { b: { input: 2 }, a: { input: 1 } } };
    expect(fingerprintsEqual(buildPricingFingerprint(a), buildPricingFingerprint(b))).toBe(true);
  });

  it('differs when revision or updated differ', () => {
    const a = buildPricingFingerprint({ version: '2.0', updated: 'T1', revision: 1 });
    const b = buildPricingFingerprint({ version: '2.0', updated: 'T2', revision: 2 });
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
});
