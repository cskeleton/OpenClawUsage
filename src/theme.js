/**
 * 全局主题：浅色 / 深色 / 跟随系统
 * 在 <html> 上设置 .theme-light | .theme-dark，并持久化到 localStorage。
 * 非 ES module，可在 <head> 中同步加载以避免 FOUC。
 */
(function initOpenClawTheme(global) {
  /** @type {string} */
  const STORAGE_KEY = 'openclaw-theme';

  /** @returns {'light'|'dark'|'system'} */
  function getStoredMode() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch (_) {
      /* ignore */
    }
    return 'system';
  }

  /**
   * @param {'light'|'dark'|'system'} mode
   * @returns {'light'|'dark'}
   */
  function resolveEffective(mode) {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    try {
      return global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  /**
   * 将当前存储模式与解析后的明暗写入 DOM，并广播事件供图表等刷新。
   */
  function applyTheme() {
    const stored = getStoredMode();
    const effective = resolveEffective(stored);
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(effective === 'dark' ? 'theme-dark' : 'theme-light');
    root.dataset.themeMode = stored;
    root.dataset.themeResolved = effective;
    root.style.colorScheme = effective === 'dark' ? 'dark' : 'light';

    try {
      global.dispatchEvent(
        new CustomEvent('openclaw-themechange', {
          detail: { mode: stored, resolved: effective },
        })
      );
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * @param {'light'|'dark'|'system'} mode
   */
  function setTheme(mode) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (_) {
      /* ignore */
    }
    applyTheme();
    syncThemeControls();
  }

  /** 同步页面上所有 [data-theme] 按钮的激活态 */
  function syncThemeControls() {
    const stored = getStoredMode();
    document.querySelectorAll('[data-theme-control]').forEach((el) => {
      const mode = el.getAttribute('data-theme-control');
      const active = mode === stored;
      el.classList.toggle('theme-control-active', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function onSystemPreferenceChange() {
    if (getStoredMode() === 'system') {
      applyTheme();
      syncThemeControls();
    }
  }

  /** 绑定主题切换控件（仪表盘与价格页共用） */
  function wireThemeControls() {
    document.querySelectorAll('[data-theme-control]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-theme-control');
        if (mode === 'light' || mode === 'dark' || mode === 'system') {
          setTheme(mode);
        }
      });
    });
    syncThemeControls();
  }

  let mediaQuery = null;
  function watchSystemTheme() {
    try {
      mediaQuery = global.matchMedia('(prefers-color-scheme: dark)');
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', onSystemPreferenceChange);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(onSystemPreferenceChange);
      }
    } catch (_) {
      /* ignore */
    }
  }

  // 首次加载立即应用（同步脚本在 <head> 中执行时，document.documentElement 已存在）
  applyTheme();
  watchSystemTheme();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireThemeControls);
  } else {
    wireThemeControls();
  }

  const api = {
    getMode: getStoredMode,
    getResolved: () => resolveEffective(getStoredMode()),
    setTheme,
    refresh: applyTheme,
  };
  global.OpenClawTheme = api;
})(typeof window !== 'undefined' ? window : globalThis);
