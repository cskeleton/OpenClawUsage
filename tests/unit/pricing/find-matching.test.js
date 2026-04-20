import { describe, it, expect } from 'vitest';
import { findMatchingPricing } from '../../../pricing.js';

const entry = (input, output, extra = {}) => ({ input, output, ...extra });

describe('findMatchingPricing priority', () => {
  it('returns exact match first', () => {
    const map = {
      'openai/gpt-4o': entry(2.5, 10),
      'openai/*': { ...entry(99, 99), matchType: 'wildcard' },
    };
    expect(findMatchingPricing('openai/gpt-4o', map).input).toBe(2.5);
  });

  it('falls back to wildcard when exact missing', () => {
    const map = {
      'anthropic/claude-*': { ...entry(3, 15), matchType: 'wildcard' },
    };
    const hit = findMatchingPricing('anthropic/claude-sonnet-4', map);
    expect(hit.input).toBe(3);
  });

  it('uses regex when wildcard and exact both miss', () => {
    const map = {
      '/^minimax\\/.*$/': { ...entry(1, 1), matchType: 'regex' },
    };
    const hit = findMatchingPricing('minimax/abab6-chat', map);
    expect(hit.input).toBe(1);
  });

  it('skips disabled entries even if they match', () => {
    const map = {
      'openai/gpt-4o': { ...entry(99, 99), enabled: false },
      'openai/*': { ...entry(2.5, 10), matchType: 'wildcard' },
    };
    expect(findMatchingPricing('openai/gpt-4o', map).input).toBe(2.5);
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingPricing('weird/model', { 'a/b': entry(1, 1) })).toBeNull();
  });

  it('returns null for empty or missing map', () => {
    expect(findMatchingPricing('x/y', {})).toBeNull();
    expect(findMatchingPricing('x/y', null)).toBeNull();
  });
});
