import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const CATALOG = {
  models: [
    {
      key: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1000000,
    },
    {
      key: 'openai/gpt-5',
      provider: 'openai',
      model: 'gpt-5',
      displayName: 'GPT-5',
      cost: { input: 1.25, output: 10, cacheRead: null, cacheWrite: null },
      contextWindow: 400000,
    },
  ],
  fetchedAt: '2026-08-09T00:00:00.000Z',
  stale: false,
  source: 'models.dev',
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
    <input id="custom-pricing-enabled" type="checkbox" />
    <div id="pricing-config-stack"></div>
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

function stubFetch() {
  return vi.fn(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/models-dev/models')) return jsonResponse(CATALOG);
    if (path.startsWith('/api/openclaw/models')) return jsonResponse({ models: [], unpricedModels: [] });
    if (path.startsWith('/api/pricing/models')) return jsonResponse({ models: [] });
    if (path.startsWith('/api/pricing')) return jsonResponse({ enabled: true, pricing: {}, updated: 'x' });
    return jsonResponse({}, 404);
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', stubFetch());
  mountDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function importPricing() {
  await import('../../../src/pricing.js');
  await vi.waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/pricing'))).toBe(true),
  );
}

async function openModal() {
  document.getElementById('fetch-models-dev-btn').click();
  const list = document.getElementById('models-dev-list');
  await vi.waitFor(() => expect(list.children.length).toBe(2));
  return list;
}

describe('models.dev modal', () => {
  it('opens modal, lists models, filters by search', async () => {
    await importPricing();
    const list = await openModal();
    const search = document.getElementById('models-dev-search');
    search.value = 'gpt';
    search.dispatchEvent(new Event('input'));
    expect(list.children.length).toBe(1);
    expect(list.textContent).toContain('openai/gpt-5');
  });

  it('fill writes only price fields when all empty', async () => {
    await importPricing();
    const list = await openModal();
    list.querySelector('[data-key="anthropic/claude-sonnet-4-6"]').click();
    const fillBtn = document.getElementById('models-dev-fill');
    expect(fillBtn.disabled).toBe(false);
    fillBtn.click();
    expect(document.getElementById('new-input-price').value).toBe('3');
    expect(document.getElementById('new-output-price').value).toBe('15');
    expect(document.getElementById('new-cache-read-price').value).toBe('0.3');
    expect(document.getElementById('new-cache-write-price').value).toBe('3.75');
    expect(document.getElementById('new-model-input').value).toBe('');
    expect(document.getElementById('models-dev-modal').hidden).toBe(true);
  });

  it('null cache prices fill as empty strings', async () => {
    await importPricing();
    const list = await openModal();
    list.querySelector('[data-key="openai/gpt-5"]').click();
    document.getElementById('models-dev-fill').click();
    expect(document.getElementById('new-cache-read-price').value).toBe('');
    expect(document.getElementById('new-cache-write-price').value).toBe('');
  });

  it('shows three-way confirm when some fields are non-empty', async () => {
    await importPricing();
    document.getElementById('new-input-price').value = '9';
    const list = await openModal();
    list.querySelector('[data-key="anthropic/claude-sonnet-4-6"]').click();
    document.getElementById('models-dev-fill').click();
    const confirm = document.getElementById('models-dev-fill-confirm');
    expect(confirm).not.toBeNull();
    expect(confirm.hidden).toBe(false);
    confirm.querySelector('[data-strategy="blank"]').click();
    expect(document.getElementById('new-input-price').value).toBe('9');
    expect(document.getElementById('new-output-price').value).toBe('15');
  });

  it('shows error state with retry when fetch fails', async () => {
    fetch.mockImplementation((url) => {
      const path = String(url);
      if (path.startsWith('/api/models-dev/models')) return Promise.reject(new Error('boom'));
      if (path.startsWith('/api/openclaw/models')) return Promise.resolve(jsonResponse({ models: [], unpricedModels: [] }));
      if (path.startsWith('/api/pricing/models')) return Promise.resolve(jsonResponse({ models: [] }));
      if (path.startsWith('/api/pricing')) return Promise.resolve(jsonResponse({ enabled: true, pricing: {}, updated: 'x' }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    await import('../../../src/pricing.js');
    document.getElementById('fetch-models-dev-btn').click();
    const status = document.getElementById('models-dev-status');
    await vi.waitFor(() => expect(status.textContent).toMatch(/失败|failed/i));
    expect(status.querySelector('[data-action="retry"]')).not.toBeNull();
  });

  it('leaves fields empty for null prices (no zero filling)', async () => {
    fetch.mockImplementation((url) => {
      const path = String(url);
      if (path.startsWith('/api/models-dev/models')) {
        return Promise.resolve(jsonResponse({
          models: [{
            key: 'test/free', provider: 'test', model: 'free', displayName: 'Free',
            cost: { input: null, output: null, cacheRead: null, cacheWrite: null },
            contextWindow: null,
          }],
          fetchedAt: '2026-08-09T00:00:00.000Z', stale: false, source: 'models.dev',
        }));
      }
      if (path.startsWith('/api/openclaw/models')) return Promise.resolve(jsonResponse({ models: [], unpricedModels: [] }));
      if (path.startsWith('/api/pricing/models')) return Promise.resolve(jsonResponse({ models: [] }));
      if (path.startsWith('/api/pricing')) return Promise.resolve(jsonResponse({ enabled: true, pricing: {}, updated: 'x' }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    await import('../../../src/pricing.js');
    document.getElementById('fetch-models-dev-btn').click();
    const list = document.getElementById('models-dev-list');
    await vi.waitFor(() => expect(list.children.length).toBe(1));
    list.querySelector('[data-key="test/free"]').click();
    document.getElementById('models-dev-fill').click();
    expect(document.getElementById('new-input-price').value).toBe('');
    expect(document.getElementById('new-output-price').value).toBe('');
    expect(document.getElementById('new-cache-read-price').value).toBe('');
    expect(document.getElementById('new-cache-write-price').value).toBe('');
  });

  it('lists cache prices alongside input/output', async () => {
    await importPricing();
    const list = await openModal();
    const first = list.querySelector('[data-key="anthropic/claude-sonnet-4-6"]');
    expect(first.textContent).toContain('0.3');
    expect(first.textContent).toContain('3.75');
  });
});
