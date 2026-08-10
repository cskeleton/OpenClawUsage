import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLocale,
  setLocale,
  t,
  translateStaticElements,
} from '../../../src/i18n.js';
import { zhCNMessages } from '../../../src/locales/zh-CN.js';
import { enUSMessages } from '../../../src/locales/en-US.js';

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

  it('pricing.modelsDev* keys exist in both locales with same key set', async () => {
    const zhKeys = Object.keys(zhCNMessages.pricing).filter((k) => k.startsWith('modelsDev')).sort();
    const enKeys = Object.keys(enUSMessages.pricing).filter((k) => k.startsWith('modelsDev')).sort();
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(zhKeys).toEqual(enKeys);
  });

  it('keeps dashboard chart controls and heading emoji contract synchronized', () => {
    const dashboardHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const pricingHtml = fs.readFileSync(path.join(process.cwd(), 'pricing.html'), 'utf8');
    const dashboardDoc = new DOMParser().parseFromString(dashboardHtml, 'text/html');
    const pricingDoc = new DOMParser().parseFromString(pricingHtml, 'text/html');

    const controls = dashboardDoc.querySelector('.model-chart-controls');
    expect(controls?.querySelector('#model-merge-checkpoints')?.checked).toBe(true);
    expect(controls?.querySelector('#model-log-scale')).not.toBeNull();
    expect(dashboardDoc.querySelector('[data-i18n="dashboard.chartTimeline"]')?.textContent).toBe('用量趋势（按日）');
    expect(dashboardDoc.querySelector('[data-i18n="dashboard.chartProvider"]')?.textContent).toBe('Provider 费用分布');
    expect(dashboardDoc.querySelector('[data-i18n="dashboard.chartModel"]')?.textContent).toBe('Model 用量对比');
    expect(dashboardDoc.querySelector('[data-i18n="dashboard.breakdownTitle"]')?.textContent).toBe('Provider / Model 消耗明细');
    expect(dashboardDoc.querySelector('[data-i18n="dashboard.sessionDetails"]')?.textContent).toBe('Session 明细');
    expect(zhCNMessages.dashboard.chartTimeline).toBe('用量趋势（按日）');
    expect(zhCNMessages.dashboard.chartProvider).toBe('Provider 费用分布');
    expect(zhCNMessages.dashboard.chartModel).toBe('Model 用量对比');
    expect(zhCNMessages.dashboard.breakdownTitle).toBe('Provider / Model 消耗明细');
    expect(zhCNMessages.dashboard.sessionDetails).toBe('Session 明细');
    expect(enUSMessages.dashboard.chartModel).toBe('Model usage comparison');
    expect(pricingDoc.querySelector('.pricing-title-text')?.textContent).toContain('💰');
    expect(dashboardDoc.querySelector('.logo')?.textContent).toBe('🦞');
  });

  it('keeps narrow dashboard controls inside the viewport', () => {
    const dashboardCss = fs.readFileSync(path.join(process.cwd(), 'src/style.css'), 'utf8');
    const narrowRules = dashboardCss.match(/@media \(max-width: 500px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(narrowRules).toMatch(/\.time-custom\s*\{[^}]*width:\s*100%/);
    expect(narrowRules).toMatch(/\.time-custom \.date-input\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%/);
    expect(narrowRules).toMatch(/\.dimension-fields,\s*\.dimension-field\s*\{[^}]*width:\s*100%/);
    expect(narrowRules).toMatch(/\.pagination-controls,\s*\.page-buttons\s*\{[^}]*width:\s*100%[^}]*flex-wrap:\s*wrap/);
  });

  it('keeps dashboard chart locale keys synchronized between Chinese and English', () => {
    expect(Object.keys(zhCNMessages.dashboard).sort()).toEqual(Object.keys(enUSMessages.dashboard).sort());
  });
});
