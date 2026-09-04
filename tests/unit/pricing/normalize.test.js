import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NOISE_SUFFIXES,
  generateModelKeyCandidates,
  splitModelKey,
} from '../../../pricing-normalize.js';

describe('splitModelKey', () => {
  it('splits on the first slash only', () => {
    expect(splitModelKey('cpa/agy/gemini-3.8-flash-high'))
      .toEqual({ provider: 'cpa', model: 'agy/gemini-3.8-flash-high' });
    expect(splitModelKey('deepseek/deepseek-v4-pro'))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });
});

describe('generateModelKeyCandidates', () => {
  it('strips channel prefix segments and noise suffixes', () => {
    const c = generateModelKeyCandidates('cpa', 'agy/gemini-3.8-flash-high');
    expect(c[0]).toBe('agy/gemini-3.8-flash-high');
    expect(c).toContain('gemini-3.8-flash-high');
    expect(c).toContain('gemini-3.8-flash');
  });

  it('strips nested catalog-style prefixes', () => {
    expect(generateModelKeyCandidates('nvidia', 'deepseek-ai/deepseek-v4-flash'))
      .toContain('deepseek-v4-flash');
  });

  it('lowercases variants', () => {
    expect(generateModelKeyCandidates('minimax-portal', 'MiniMax-M3'))
      .toContain('minimax-m3');
  });

  it('does NOT strip distinctive suffixes (-pro is not noise)', () => {
    const c = generateModelKeyCandidates('cpa', 'mimo-v2.5-pro');
    expect(c).not.toContain('mimo-v2.5');
  });

  it('does NOT strip model-family suffixes like -luna/-sol/-terra', () => {
    const c = generateModelKeyCandidates('openai', 'gpt-5.6-luna');
    expect(c).not.toContain('gpt-5.6');
  });

  it('strips -thinking but keeps the base model', () => {
    expect(generateModelKeyCandidates('cpa', 'justwoker/claude-opus-5-thinking'))
      .toContain('claude-opus-5');
  });

  it('respects custom noiseSuffixes', () => {
    const c = generateModelKeyCandidates('cpa', 'x/y-0731', ['-0731']);
    expect(c).toContain('y');
  });
});
