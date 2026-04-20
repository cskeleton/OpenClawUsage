import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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

function stubMatchMedia(dark) {
  const impl = (query) => ({
    matches: dark && query.includes('dark'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: impl,
  });
}

function resetDom() {
  document.documentElement.className = '';
  delete document.documentElement.dataset.themeMode;
  delete document.documentElement.dataset.themeResolved;
  document.documentElement.style.colorScheme = '';
  document.body.innerHTML = '';
  delete window.OpenClawTheme;
}

async function loadThemeFresh() {
  // 通过查询串制造新的模块身份，迫使 IIFE 重新执行以读取最新的 localStorage / matchMedia
  // @vite-ignore 用于绕过 Vite 对变量化动态 import 的静态分析限制
  const url = `../../../src/theme.js?t=${Date.now()}-${Math.random()}`;
  await import(/* @vite-ignore */ url);
  return window.OpenClawTheme;
}

describe('theme.js', () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
    resetDom();
    stubMatchMedia(false);
  });

  afterEach(() => {
    resetDom();
  });

  it('defaults to system mode resolved to light when prefers-color-scheme is light', async () => {
    const api = await loadThemeFresh();
    expect(api.getMode()).toBe('system');
    expect(api.getResolved()).toBe('light');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(document.documentElement.dataset.themeMode).toBe('system');
    expect(document.documentElement.dataset.themeResolved).toBe('light');
  });

  it('system mode tracks matchMedia dark preference', async () => {
    stubMatchMedia(true);
    const api = await loadThemeFresh();
    expect(api.getResolved()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });

  it('setTheme("dark") persists and applies theme-dark class', async () => {
    const api = await loadThemeFresh();
    api.setTheme('dark');
    expect(api.getMode()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(localStorage.getItem('openclaw-theme')).toBe('dark');
  });

  it('setTheme("light") overrides system preference', async () => {
    stubMatchMedia(true);
    const api = await loadThemeFresh();
    api.setTheme('light');
    expect(api.getResolved()).toBe('light');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
  });

  it('setTheme ignores invalid mode', async () => {
    const api = await loadThemeFresh();
    const before = api.getMode();
    api.setTheme('fuchsia');
    expect(api.getMode()).toBe(before);
  });

  it('loads persisted mode from localStorage on init', async () => {
    localStorage.setItem('openclaw-theme', 'dark');
    const api = await loadThemeFresh();
    expect(api.getMode()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });

  it('setTheme dispatches openclaw-themechange event with mode and resolved', async () => {
    const api = await loadThemeFresh();
    let captured = null;
    window.addEventListener(
      'openclaw-themechange',
      (e) => {
        captured = e.detail;
      },
      { once: true }
    );
    api.setTheme('dark');
    expect(captured).toEqual({ mode: 'dark', resolved: 'dark' });
  });
});
