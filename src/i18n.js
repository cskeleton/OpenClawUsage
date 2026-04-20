import { zhCNMessages } from './locales/zh-CN.js';
import { enUSMessages } from './locales/en-US.js';

const STORAGE_KEY = 'openclaw-locale';
const DEFAULT_LOCALE = 'zh-CN';
const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];

const dictionaries = {
  'zh-CN': zhCNMessages,
  'en-US': enUSMessages,
};

let currentLocale = DEFAULT_LOCALE;

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    return value == null ? '' : String(value);
  });
}

function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

function detectInitialLocale() {
  try {
    const fromStorage = localStorage.getItem(STORAGE_KEY);
    if (fromStorage) return normalizeLocale(fromStorage);
  } catch (_) {
    // localStorage 不可用时回退默认语言
  }
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale) {
  currentLocale = normalizeLocale(locale);
  try {
    localStorage.setItem(STORAGE_KEY, currentLocale);
  } catch (_) {
    // localStorage 不可用时忽略持久化异常
  }
  applyI18nDocument();
  translateStaticElements(document);
  updateLocaleControls();
  window.dispatchEvent(
    new CustomEvent('openclaw-localechange', {
      detail: { locale: currentLocale },
    })
  );
}

export function t(key, params) {
  const exact = getByPath(dictionaries[currentLocale], key);
  if (typeof exact === 'string') return interpolate(exact, params);
  const fallback = getByPath(dictionaries[DEFAULT_LOCALE], key);
  if (typeof fallback === 'string') return interpolate(fallback, params);
  return key;
}

export function applyI18nDocument() {
  document.documentElement.lang = currentLocale;
  const titleKey = document.body?.dataset.i18nTitleKey;
  if (titleKey) {
    document.title = t(titleKey);
  }
}

export function translateStaticElements(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (!key) return;
    node.textContent = t(key);
  });

  root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const attrMap = node.getAttribute('data-i18n-attr');
    if (!attrMap) return;
    attrMap.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) return;
      node.setAttribute(attr, t(key));
    });
  });
}

export function updateLocaleControls() {
  const active = getLocale();
  document.querySelectorAll('[data-locale-control]').forEach((button) => {
    const locale = button.getAttribute('data-locale-control');
    const isActive = locale === active;
    button.classList.toggle('locale-control-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

export function initLocaleControls() {
  currentLocale = detectInitialLocale();
  applyI18nDocument();
  translateStaticElements(document);
  updateLocaleControls();

  document.querySelectorAll('[data-locale-control]').forEach((button) => {
    button.addEventListener('click', () => {
      const locale = button.getAttribute('data-locale-control');
      if (!locale || locale === getLocale()) return;
      setLocale(locale);
    });
  });
}
