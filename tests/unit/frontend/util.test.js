import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escapeHtml, escapeAttr, showToast } from '../../../src/util.js';

describe('escapeHtml', () => {
  it('escapes < > & via textContent', () => {
    const out = escapeHtml('<b>"a"&b</b>');
    // jsdom 的 textContent → innerHTML 会转义 <、>、& 但不会转义双引号
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('&amp;');
  });

  it('handles null and undefined as empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
  });
});

describe('escapeAttr', () => {
  it('escapes double quotes, &, <, and >', () => {
    expect(escapeAttr('a "b" <c>&d')).toBe('a &quot;b&quot; &lt;c&gt;&amp;d');
  });

  it('handles null and undefined as empty string', () => {
    expect(escapeAttr(null)).toBe('');
    expect(escapeAttr(undefined)).toBe('');
  });
});

describe('showToast', () => {
  let el;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    el.id = 'pricing-toast';
    el.hidden = true;
    document.body.appendChild(el);
  });

  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it('shows message and auto-hides after duration', () => {
    showToast('hi', { duration: 500 });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('hi');
    expect(el.classList.contains('pricing-toast--visible')).toBe(true);

    vi.advanceTimersByTime(500);
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('pricing-toast--visible')).toBe(false);
  });

  it('applies variant class for error', () => {
    showToast('err', { variant: 'error' });
    expect(el.classList.contains('pricing-toast--error')).toBe(true);
  });

  it('applies variant class for success', () => {
    showToast('ok', { variant: 'success' });
    expect(el.classList.contains('pricing-toast--success')).toBe(true);
  });

  it('clears previous variant when called again', () => {
    showToast('err', { variant: 'error' });
    expect(el.classList.contains('pricing-toast--error')).toBe(true);
    showToast('info');
    expect(el.classList.contains('pricing-toast--error')).toBe(false);
    expect(el.classList.contains('pricing-toast--success')).toBe(false);
  });

  it('silently returns when toast element is absent', () => {
    el.remove();
    expect(() => showToast('noop')).not.toThrow();
  });
});
