import { describe, it, expect } from 'vitest';
import { wildcardToRegex, parseRegexEntry } from '../../../pricing.js';

describe('wildcardToRegex', () => {
  it('matches simple prefix with *', () => {
    const re = wildcardToRegex('anthropic/claude-*');
    expect(re.test('anthropic/claude-sonnet-4')).toBe(true);
    expect(re.test('anthropic/claude-')).toBe(true);
    expect(re.test('openai/gpt-4o')).toBe(false);
  });

  it('? matches exactly one character', () => {
    const re = wildcardToRegex('openai/gpt-?');
    expect(re.test('openai/gpt-4')).toBe(true);
    expect(re.test('openai/gpt-40')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    const re = wildcardToRegex('ns/a+b.c');
    expect(re.test('ns/a+b.c')).toBe(true);
    expect(re.test('ns/axbxc')).toBe(false);
  });

  it('throws TypeError on non-string input', () => {
    expect(() => wildcardToRegex(42)).toThrow(TypeError);
  });
});

describe('parseRegexEntry', () => {
  it('parses /pattern/flags form', () => {
    const re = parseRegexEntry('/^minimax\\/.*$/i');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('MINIMAX/abc')).toBe(true);
  });

  it('returns null when not starting with slash', () => {
    expect(parseRegexEntry('plain')).toBeNull();
  });

  it('returns null for malformed regex', () => {
    expect(parseRegexEntry('/(/')).toBeNull();
  });
});
