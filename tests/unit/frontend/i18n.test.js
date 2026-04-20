import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLocale,
  setLocale,
  t,
  translateStaticElements,
} from '../../../src/i18n.js';

function installLocalStoragePolyfill() {
  const store = new Map();
  const mock = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(String(k), String(v));
    },
    removeItem: (k) => {
      store.delete(String(k));
    },
    clear: () => {
      store.clear();
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mock,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: mock,
    });
  }
}

describe('i18n', () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
    localStorage.clear();
    document.body.innerHTML = '';
    setLocale('zh-CN');
  });

  it('starts at zh-CN after reset', () => {
    expect(getLocale()).toBe('zh-CN');
  });

  it('setLocale normalizes unsupported values to default', () => {
    setLocale('fr-FR');
    expect(getLocale()).toBe('zh-CN');
  });

  it('setLocale persists supported locale to localStorage', () => {
    setLocale('en-US');
    expect(getLocale()).toBe('en-US');
    expect(localStorage.getItem('openclaw-locale')).toBe('en-US');
  });

  it('t returns the key itself when missing from both dictionaries', () => {
    expect(t('totally.bogus.key')).toBe('totally.bogus.key');
  });

  it('t interpolates {param} templates', () => {
    setLocale('zh-CN');
    const result = t('dashboard.summaryRequests', { count: '3' });
    expect(result).toContain('3');
  });

  it('t falls back to default locale when key missing in current', () => {
    setLocale('en-US');
    const val = t('dashboard.summaryTotalTokens');
    expect(typeof val).toBe('string');
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe('dashboard.summaryTotalTokens');
  });

  it('translateStaticElements applies data-i18n text to elements', () => {
    setLocale('zh-CN');
    document.body.innerHTML = '<span data-i18n="dashboard.summaryTotalTokens"></span>';
    translateStaticElements(document);
    const span = document.querySelector('span');
    expect(span.textContent.length).toBeGreaterThan(0);
    expect(span.textContent).not.toBe('dashboard.summaryTotalTokens');
  });

  it('translateStaticElements applies data-i18n-attr to the specified attributes', () => {
    setLocale('zh-CN');
    document.body.innerHTML =
      '<button data-i18n-attr="title:dashboard.summaryTotalTokens"></button>';
    translateStaticElements(document);
    const button = document.querySelector('button');
    const titleAttr = button.getAttribute('title');
    expect(typeof titleAttr).toBe('string');
    expect(titleAttr.length).toBeGreaterThan(0);
  });

  it('setLocale dispatches openclaw-localechange event', () => {
    let captured = null;
    window.addEventListener(
      'openclaw-localechange',
      (e) => {
        captured = e.detail;
      },
      { once: true }
    );

    setLocale('en-US');
    expect(captured).toEqual({ locale: 'en-US' });
  });
});
