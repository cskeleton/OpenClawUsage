import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const V2_CONFIG = {
  version: '2.0',
  enabled: true,
  updated: '2026-09-04T00:00:00.000Z',
  revision: 7,
  matching: { ignoreProvider: true, noiseSuffixes: ['-thinking'] },
  rules: {
    'claude-sonnet-4-6': {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      enabled: true,
      source: 'manual',
    },
  },
  aliases: {},
  patterns: {},
};

const CANDIDATES = {
  candidates: [
    {
      observedKey: 'aaa/multi-model',
      candidates: [
        { catalogKey: 'openai/gpt-5', provider: 'openai', model: 'gpt-5', score: 0.71, reason: 'shared-model-tokens', prices: { input: 1.25, output: 10, cacheRead: null, cacheWrite: null } },
        { catalogKey: 'azure/gpt-5', provider: 'azure', model: 'gpt-5', score: 0.66, reason: 'shared-model-tokens', prices: { input: 1.5, output: 12, cacheRead: null, cacheWrite: null } },
      ],
      lastSeenAt: '2026-09-04T00:00:00.000Z',
      dismissed: false,
    },
    {
      observedKey: 'zzz/model-b',
      candidates: [
        { catalogKey: 'deepseek/deepseek-v4-pro', provider: 'deepseek', model: 'deepseek-v4-pro', score: 0.83, reason: 'exact-official', prices: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: null } },
      ],
      lastSeenAt: '2026-09-04T00:00:00.000Z',
      dismissed: false,
    },
    {
      observedKey: 'yyy/model-c',
      candidates: [
        { catalogKey: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', score: 0.9, reason: 'exact-single', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
      ],
      lastSeenAt: '2026-09-04T00:00:00.000Z',
      dismissed: false,
    },
    {
      observedKey: 'mmm/dismissed-model',
      candidates: [
        { catalogKey: 'openai/gpt-5-mini', provider: 'openai', model: 'gpt-5-mini', score: 0.6, reason: 'weak-recall', prices: { input: 0.25, output: 2, cacheRead: null, cacheWrite: null } },
      ],
      lastSeenAt: '2026-09-04T00:00:00.000Z',
      dismissed: true,
    },
  ],
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mountDom() {
  document.body.innerHTML = `
    <div id="pricing-toast"></div>
    <div id="pricing-validation-banner" hidden></div>
    <input id="custom-pricing-enabled" type="checkbox" />
    <input id="ignore-provider-toggle" type="checkbox" />
    <button id="btn-noise-suffixes"></button>
    <div id="pricing-config-stack">
      <div id="candidates-section" hidden>
        <button id="btn-accept-all-unique"></button>
        <button id="btn-dismiss-all"></button>
        <button id="btn-rematch"></button>
        <div id="candidates-list"></div>
      </div>
      <div id="add-pricing-section">
        <input id="new-model-input" value="" />
        <select id="new-match-type"></select>
        <input id="new-input-price" value="" />
        <input id="new-output-price" value="" />
        <input id="new-cache-read-price" value="" />
        <input id="new-cache-write-price" value="" />
        <button id="new-model-clear" hidden></button>
        <datalist id="new-model-datalist"></datalist>
        <p id="new-pattern-hint" hidden></p>
        <p id="new-pattern-error" hidden></p>
        <button id="fetch-models-dev-btn"></button>
        <button id="add-pricing-btn"></button>
      </div>
      <button id="reset-pricing-btn"></button>
      <table><tbody id="pricing-tbody"></tbody></table>
      <table><tbody id="openclaw-ref-tbody"></tbody></table>
      <table><tbody id="unpriced-models-tbody"></tbody></table>
    </div>
    <div id="models-dev-modal" hidden>
      <div class="models-dev-modal-backdrop" data-action="close"></div>
      <button type="button" class="models-dev-modal-close" data-action="close">×</button>
      <input id="models-dev-search" />
      <div id="models-dev-status"></div>
      <ul id="models-dev-list"></ul>
      <button id="models-dev-cancel"></button>
      <button id="models-dev-fill" disabled></button>
      <div id="models-dev-fill-confirm" hidden>
        <button type="button" data-strategy="overwrite"></button>
        <button type="button" data-strategy="blank"></button>
        <button type="button" data-strategy="cancel"></button>
      </div>
    </div>`;
}

function stubFetch({ pricingGet, pricingPut, candidates } = {}) {
  const getPayload = pricingGet ?? V2_CONFIG;
  const putResponse = pricingPut ?? { ok: true, revision: 8, updated: '2026-09-04T01:00:00.000Z' };
  const candidatesPayload = candidates ?? { candidates: [] };
  return vi.fn(async (url, options = {}) => {
    const path = String(url);
    const method = options.method || 'GET';
    if (path.startsWith('/api/pricing/candidates/resolve')) {
      return jsonResponse({ ok: true, applied: 1, failed: [] });
    }
    if (path.startsWith('/api/pricing/candidates')) return jsonResponse(candidatesPayload);
    if (path.startsWith('/api/pricing/rematch')) {
      return jsonResponse({ ok: true, scanned: 0, matched: 0, queued: 0 });
    }
    if (path.startsWith('/api/pricing/models')) return jsonResponse({ models: [] });
    if (path === '/api/pricing' || path.startsWith('/api/pricing?')) {
      if (method === 'PUT') {
        return putResponse instanceof Response ? putResponse : jsonResponse(putResponse);
      }
      return jsonResponse(getPayload);
    }
    if (path.startsWith('/api/openclaw/models')) return jsonResponse({ models: [], unpricedModels: [] });
    if (path.startsWith('/api/models-dev/models')) return jsonResponse({ models: [] });
    return jsonResponse({}, 404);
  });
}

function putCalls() {
  return fetch.mock.calls.filter(
    ([url, options]) => String(url) === '/api/pricing' && options?.method === 'PUT',
  );
}

function getCalls() {
  return fetch.mock.calls.filter(
    ([url, options]) => String(url) === '/api/pricing' && (!options?.method || options.method === 'GET'),
  );
}

function resolveCalls() {
  return fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/pricing/candidates/resolve'));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('alert', vi.fn());
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  }
  // jsdom 无 CSS.escape；选择器场景的最小实现
  vi.stubGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
  vi.stubGlobal('fetch', stubFetch());
  mountDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function importPricing() {
  await import('../../../src/pricing.js');
  await vi.waitFor(() => expect(getCalls().length).toBeGreaterThan(0));
}

describe('pricing v2 UI', () => {
  it('PUT sends envelope with baseRevision from last GET', async () => {
    await importPricing();
    const tbody = document.getElementById('pricing-tbody');
    await vi.waitFor(() => expect(tbody.querySelector('.btn-row-edit')).not.toBeNull());

    tbody.querySelector('.btn-row-edit').click();
    const doneBtn = tbody.querySelector('.btn-row-done');
    expect(doneBtn).not.toBeNull();
    doneBtn.click();

    await vi.waitFor(() => expect(putCalls().length).toBe(1));
    const body = JSON.parse(putCalls()[0][1].body);
    expect(body.baseRevision).toBe(7);
    expect(body.config).toBeTypeOf('object');
    expect(body.config.rules['claude-sonnet-4-6']).toMatchObject({ input: 3, output: 15 });
    // 等待保存后的补充表刷新完成，避免测试结束后异步续跑
    await vi.waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/openclaw/models')).length).toBeGreaterThan(1),
    );
  });

  it('409 conflict alerts and reloads', async () => {
    vi.stubGlobal('fetch', stubFetch({ pricingPut: jsonResponse({ code: 'PRICING_REVISION_CONFLICT', error: 'conflict' }, 409) }));
    await importPricing();
    expect(getCalls().length).toBe(1);

    const toggle = document.getElementById('custom-pricing-enabled');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(putCalls().length).toBe(1));
    await vi.waitFor(() => expect(getCalls().length).toBeGreaterThan(1));
    expect(alert).toHaveBeenCalledWith('配置已被其他入口修改，已重新加载');
  });

  it('renders confirmation queue sorted and supports batch accept-unique', async () => {
    vi.stubGlobal('fetch', stubFetch({ candidates: CANDIDATES }));
    await importPricing();

    const section = document.getElementById('candidates-section');
    const list = document.getElementById('candidates-list');
    await vi.waitFor(() => expect(section.hidden).toBe(false));

    const entries = [...list.querySelectorAll('.candidate-entry')];
    expect(entries.length).toBe(3);
    // dismissed 条目不显示
    expect(list.textContent).not.toContain('mmm/dismissed-model');
    // 排序：单候选条目优先（yyy/model-c、zzz/model-b），多候选（aaa/multi-model）在后
    expect(entries.map((el) => el.dataset.observedKey)).toEqual([
      'yyy/model-c',
      'zzz/model-b',
      'aaa/multi-model',
    ]);

    document.getElementById('btn-accept-all-unique').click();
    await vi.waitFor(() => expect(resolveCalls().length).toBe(1));
    const body = JSON.parse(resolveCalls()[0][1].body);
    expect(body.resolutions.length).toBe(2);
    expect(body.resolutions).toEqual(
      expect.arrayContaining([
        { observedKey: 'yyy/model-c', action: 'accept', catalogId: 'anthropic/claude-opus-5' },
        { observedKey: 'zzz/model-b', action: 'accept', catalogId: 'deepseek/deepseek-v4-pro' },
      ]),
    );
    // 等待 resolve 后的整页重载完成，避免测试结束后异步续跑
    await vi.waitFor(() => expect(getCalls().length).toBeGreaterThan(1));
  });

  it('ignoreProvider toggle persists matching.ignoreProvider', async () => {
    await importPricing();
    const toggle = document.getElementById('ignore-provider-toggle');
    await vi.waitFor(() => expect(toggle.checked).toBe(true));

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(putCalls().length).toBe(1));
    const body = JSON.parse(putCalls()[0][1].body);
    expect(body.config.matching.ignoreProvider).toBe(false);
    expect(body.baseRevision).toBe(7);
  });

  it('rule rows show source badge (models.dev / 高级规则)', async () => {
    vi.stubGlobal('fetch', stubFetch({
      pricingGet: {
        ...V2_CONFIG,
        rules: {
          'claude-sonnet-4-6': {
            input: 3,
            output: 15,
            cacheRead: null,
            cacheWrite: null,
            enabled: true,
            source: 'models.dev',
            syncedAt: '2026-09-03T00:00:00.000Z',
          },
        },
        patterns: {
          '*/gpt-5*': { input: 2, output: 10, cacheRead: null, cacheWrite: null, enabled: true, matchType: 'wildcard' },
        },
      },
    }));
    await importPricing();

    const tbody = document.getElementById('pricing-tbody');
    await vi.waitFor(() => expect(tbody.querySelectorAll('tr[data-model]').length).toBe(2));
    expect(tbody.textContent).toContain('models.dev');
    expect(tbody.textContent).toContain('高级规则');
  });
});
