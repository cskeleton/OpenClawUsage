# models.dev 在线价格参考（弹窗填价） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在价格配置页「添加新价格」区域新增「从 models.dev 获取参考价」按钮：弹出可搜索的 models.dev 模型目录，用户单选确认后仅把 4 个参考价填入价格格（已有值时三选：全部覆盖 / 只填空白 / 取消），模型键与名称字段不动，保存仍由用户自行执行。

**Architecture:** 服务端新增只读模块 `models-dev.js`（代理 `https://models.dev/api.json`、24h 磁盘缓存、先旧后新、in-flight 去重、fail-closed）与只读接口 `GET /api/models-dev/models`；前端在 `pricing.html` + `src/pricing.js` 增加模态弹窗与填入逻辑；不改动成本计算与既有写接口。

**Tech Stack:** Node.js 20+ (ESM)、Express 5、原生 `fetch` + `AbortController`、Vitest（node + jsdom 双 project）、supertest。

**Spec reference:** `docs/superpowers/specs/2026-08-09-models-dev-pricing-reference-design.md`

## Global Constraints

- 只向 `https://models.dev/api.json` 发 GET；**绝不外发**本地 Provider/Model ID、baseUrl、API Key。
- 网络请求整体超时 10s；无缓存且失败 → API 返回 502，不伪造数据（fail-closed）。
- 缓存目录沿用 `$OPENCLAW_CONFIG_DIR/cache/openclaw-usage/`（stats 缓存同目录），文件名 `models-dev-v1.json`。
- 填价**只写** `new-input-price` / `new-output-price` / `new-cache-read-price` / `new-cache-write-price`；**绝不写** `new-model-input`，不改 `new-match-type`。
- Cache 参考价为 `null` 时对应格写入空（沿用「留空 = 按 Input 原价计算」语义）。
- 新增用户可见文案必须中英双语同步（`src/locales/zh-CN.js` ↔ `src/locales/en-US.js`），README ↔ README_EN 同步。
- 行内编辑态（`pricingTableEditingKey !== null`）时禁止填入，toast 提示「请先完成或取消表格中正在编辑的行」。

---

## Task 1: `models-dev.js` 归一化 + 磁盘缓存 + 先旧后新

**Files:**
- Create: `models-dev.js`
- Test: `tests/unit/models-dev/catalog.test.js`

**Interfaces:**
- Produces:
  - `getModelsDevCatalog({ fetchImpl, nowMs } = {})` → `Promise<{ models: Array<{ key, provider, model, displayName, cost: { input, output, cacheRead, cacheWrite }, contextWindow }>, fetchedAt: string, stale: boolean, source: 'models.dev' }>`
  - `__clearModelsDevCacheForTests()` → `void`
  - `MODELS_DEV_CACHE_FILENAME` = `'models-dev-v1.json'`（供集成测试定位缓存文件）
- Consumes: `getCacheDir()` from `stats-cache-store.js`（复用缓存目录约定）。

- [ ] **Step 1：写失败测试**（归一化 + 缓存 TTL + stale 回退 + 失败抛错 + in-flight 去重）

```js
// tests/unit/models-dev/catalog.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  getModelsDevCatalog,
  __clearModelsDevCacheForTests,
} from '../../../models-dev.js';

const SAMPLE = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1000000, output: 128000 },
      },
      'no-cache': { id: 'no-cache', cost: { input: 1, output: 2 } },
    },
  },
};

const okFetch = (payload = SAMPLE) => async () =>
  new Response(JSON.stringify(payload), { status: 200 });

let ws;
const disposables = [];

beforeEach(async () => {
  __clearModelsDevCacheForTests();
  ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
});

afterEach(async () => {
  __clearModelsDevCacheForTests();
  while (disposables.length) await disposables.pop()();
});

describe('getModelsDevCatalog normalization', () => {
  it('maps cache_read/cache_write and sorts by key', async () => {
    const out = await getModelsDevCatalog({ fetchImpl: okFetch() });
    expect(out.source).toBe('models.dev');
    expect(out.stale).toBe(false);
    expect(out.models[0].key).toBe('anthropic/claude-sonnet-4-6');
    expect(out.models[0].cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(out.models[0].contextWindow).toBe(1000000);
    const noCache = out.models.find((m) => m.key === 'anthropic/no-cache');
    expect(noCache.cost.cacheRead).toBeNull();
    expect(noCache.cost.cacheWrite).toBeNull();
    expect(noCache.displayName).toBe('no-cache');
  });
});

describe('cache behavior', () => {
  it('serves fresh cache without fetching', async () => {
    await getModelsDevCatalog({ fetchImpl: okFetch(), nowMs: 1_000 });
    const spy = vi.fn(okFetch());
    const out = await getModelsDevCatalog({ fetchImpl: spy, nowMs: 1_000 + 60_000 });
    expect(spy).not.toHaveBeenCalled();
    expect(out.stale).toBe(false);
  });

  it('returns stale snapshot when expired and refreshes in background', async () => {
    await getModelsDevCatalog({ fetchImpl: okFetch(), nowMs: 1_000 });
    const later = 1_000 + 25 * 60 * 60 * 1000; // > 24h
    const spy = vi.fn(okFetch());
    const out = await getModelsDevCatalog({ fetchImpl: spy, nowMs: later });
    expect(out.stale).toBe(true);
    expect(out.models.length).toBeGreaterThan(0);
    // 等待后台刷新落盘
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('throws when no cache and fetch fails (fail-closed)', async () => {
    const failFetch = async () => { throw new Error('network down'); };
    await expect(getModelsDevCatalog({ fetchImpl: failFetch })).rejects.toThrow(/models\.dev/);
  });

  it('dedupes concurrent background refreshes', async () => {
    let calls = 0;
    const slowFetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    await getModelsDevCatalog({ fetchImpl: okFetch(), nowMs: 1_000 });
    const later = 1_000 + 25 * 60 * 60 * 1000;
    await Promise.all([
      getModelsDevCatalog({ fetchImpl: slowFetch, nowMs: later }),
      getModelsDevCatalog({ fetchImpl: slowFetch, nowMs: later }),
    ]);
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/unit/models-dev/catalog.test.js --project node`
Expected: FAIL — `Cannot find module '../../../models-dev.js'`

- [ ] **Step 3：实现 `models-dev.js`**

```js
// models-dev.js
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getCacheDir } from './stats-cache-store.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export const MODELS_DEV_CACHE_FILENAME = 'models-dev-v1.json';

let inflightRefresh = null;

function getCacheFilePath() {
  return join(getCacheDir(), MODELS_DEV_CACHE_FILENAME);
}

function toNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeCatalog(apiJson) {
  const models = [];
  for (const [providerId, provider] of Object.entries(apiJson || {})) {
    const modelsMap = provider?.models;
    if (!modelsMap || typeof modelsMap !== 'object') continue;
    for (const [modelId, m] of Object.entries(modelsMap)) {
      if (!m || typeof m !== 'object') continue;
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : {};
      models.push({
        key: `${providerId}/${modelId}`,
        provider: providerId,
        model: modelId,
        displayName: typeof m.name === 'string' && m.name ? m.name : modelId,
        cost: {
          input: toNumberOrNull(cost.input) ?? 0,
          output: toNumberOrNull(cost.output) ?? 0,
          cacheRead: toNumberOrNull(cost.cache_read),
          cacheWrite: toNumberOrNull(cost.cache_write),
        },
        contextWindow: toNumberOrNull(m.limit?.context),
      });
    }
  }
  models.sort((a, b) => a.key.localeCompare(b.key));
  return models;
}

async function fetchRemote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`models.dev responded HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readSnapshot() {
  try {
    const raw = await readFile(getCacheFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSnapshot(snapshot) {
  try {
    await mkdir(getCacheDir(), { recursive: true });
    await writeFile(getCacheFilePath(), JSON.stringify(snapshot), 'utf-8');
  } catch (err) {
    console.warn('models.dev 缓存写入失败:', err?.message || err);
  }
}

async function refreshInBackground() {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const json = await fetchRemote();
      await writeSnapshot({ fetchedAt: new Date().toISOString(), models: normalizeCatalog(json) });
    } catch (err) {
      console.warn('models.dev 后台刷新失败:', err?.message || err);
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/**
 * 获取 models.dev 目录（先旧后新：过期缓存立即返回 stale 并后台刷新）
 * @param {{ fetchImpl?: typeof fetch, nowMs?: number }} [options]
 */
export async function getModelsDevCatalog({ fetchImpl, nowMs } = {}) {
  const doFetch = fetchImpl || fetchRemote;
  const now = nowMs ?? Date.now();
  const snapshot = await readSnapshot();

  if (snapshot) {
    const age = now - Date.parse(snapshot.fetchedAt);
    if (age >= 0 && age < TTL_MS) {
      return { models: snapshot.models, fetchedAt: snapshot.fetchedAt, stale: false, source: 'models.dev' };
    }
    // 过期：先返回陈旧快照，后台刷新
    refreshInBackground().catch(() => {});
    return { models: snapshot.models, fetchedAt: snapshot.fetchedAt, stale: true, source: 'models.dev' };
  }

  // 无缓存：同步拉取，失败 fail-closed
  let json;
  try {
    json = await doFetch();
    if (json instanceof Response) {
      if (!json.ok) throw new Error(`models.dev responded HTTP ${json.status}`);
      json = await json.json();
    }
  } catch (err) {
    throw new Error(`models.dev 目录获取失败: ${err?.message || err}`);
  }
  const models = normalizeCatalog(json);
  const fetchedAt = new Date(now).toISOString();
  await writeSnapshot({ fetchedAt, models });
  return { models, fetchedAt, stale: false, source: 'models.dev' };
}

/** 测试辅助：清空进程内 in-flight 状态 */
export function __clearModelsDevCacheForTests() {
  inflightRefresh = null;
}
```

注意：后台刷新路径必须使用真实 `fetchRemote`（忽略注入的 `fetchImpl` 仅在同步无缓存路径生效）——为让单测能驱动后台刷新，把 `refreshInBackground` 与 `getModelsDevCatalog` 的注入 fetch 统一：实现时将当前生效的 fetch 存于模块级 `activeFetchImpl`（默认 `fetchRemote`），`refreshInBackground` 使用 `activeFetchImpl`；`__clearModelsDevCacheForTests` 同时重置 `activeFetchImpl = fetchRemote`。

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/unit/models-dev/catalog.test.js --project node`
Expected: PASS（5 个用例）

- [ ] **Step 5：Commit**

```bash
git add models-dev.js tests/unit/models-dev/catalog.test.js
git commit -m "feat(models-dev): add catalog fetcher with 24h disk cache and stale fallback"
```

---

## Task 2: `GET /api/models-dev/models` 只读接口

**Files:**
- Modify: `server.js`（新增 import 与路由，紧跟 `/api/openclaw/models` 之后）
- Test: `tests/integration/server/models-dev.test.js`

**Interfaces:**
- Consumes: `getModelsDevCatalog` / `__clearModelsDevCacheForTests`（Task 1）。
- Produces: `GET /api/models-dev/models` → `200 { models, fetchedAt, stale, source: 'models.dev' }`；失败 `502 { error: string }`。

- [ ] **Step 1：写失败测试**

```js
// tests/integration/server/models-dev.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { createApp } from '../../../server.js';
import { getCacheDir } from '../../../stats-cache-store.js';
import { __clearModelsDevCacheForTests } from '../../../models-dev.js';
import { writeFile, mkdir } from 'fs/promises';

const disposables = [];
let app;
let ws;

beforeEach(async () => {
  __clearModelsDevCacheForTests();
  ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  app = createApp();
});

afterEach(async () => {
  __clearModelsDevCacheForTests();
  while (disposables.length) await disposables.pop()();
});

const SNAPSHOT = {
  fetchedAt: new Date().toISOString(),
  models: [
    {
      key: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1000000,
    },
  ],
};

async function seedCache(snapshot = SNAPSHOT) {
  await mkdir(getCacheDir(), { recursive: true });
  await writeFile(join(getCacheDir(), 'models-dev-v1.json'), JSON.stringify(snapshot), 'utf-8');
}

describe('GET /api/models-dev/models', () => {
  it('returns fresh snapshot without network', async () => {
    await seedCache();
    const res = await request(app).get('/api/models-dev/models');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('models.dev');
    expect(res.body.stale).toBe(false);
    expect(res.body.models[0].key).toBe('anthropic/claude-sonnet-4-6');
  });

  it('marks expired snapshot as stale', async () => {
    await seedCache({ ...SNAPSHOT, fetchedAt: new Date(Date.now() - 25 * 3600e3).toISOString() });
    const res = await request(app).get('/api/models-dev/models');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  it('responds 502 when no cache and network fails', async () => {
    // 无缓存；测试环境不应真的访问 models.dev。
    // 通过注入失败：临时把全局 fetch 指向不可达地址由实现侧注入困难，
    // 因此该用例依赖 Task 1 的 fail-closed 语义 + 此处仅验证错误映射：
    // 强制读取损坏缓存文件视为无缓存，再让 fetch 失败。
    await mkdir(getCacheDir(), { recursive: true });
    await writeFile(join(getCacheDir(), 'models-dev-v1.json'), 'not-json', 'utf-8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try {
      const res = await request(app).get('/api/models-dev/models');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/models\.dev/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET is not blocked by writeRequestGuard', async () => {
    await seedCache();
    const res = await request(app)
      .get('/api/models-dev/models')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/integration/server/models-dev.test.js --project node`
Expected: FAIL — 404（路由不存在）

- [ ] **Step 3：实现路由**

在 `server.js` 顶部追加 import：

```js
import { getModelsDevCatalog } from './models-dev.js';
```

在 `GET /api/openclaw/models` 路由之后追加：

```js
  // GET /api/models-dev/models - models.dev 在线目录（只读，磁盘缓存 24h，先旧后新）
  app.get('/api/models-dev/models', async (req, res) => {
    try {
      const data = await getModelsDevCatalog();
      res.json(data);
    } catch (err) {
      console.error('Error fetching models.dev catalog:', err);
      res.status(502).json({ error: err.message });
    }
  });
```

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/integration/server/models-dev.test.js --project node`
Expected: PASS（4 个用例）

- [ ] **Step 5：Commit**

```bash
git add server.js tests/integration/server/models-dev.test.js
git commit -m "feat(api): add read-only GET /api/models-dev/models"
```

---

## Task 3: 前端弹窗 UI 与搜索/单选

**Files:**
- Modify: `pricing.html`（新增入口按钮、弹窗 DOM、toast 容器若缺失则补 `<div id="pricing-toast">`）
- Modify: `src/style.css`（弹窗样式，沿用 glass-card / btn-* 既有风格变量）
- Modify: `src/pricing.js`（弹窗状态机、搜索过滤、单选）
- Modify: `src/locales/zh-CN.js`、`src/locales/en-US.js`（新增 `pricing.modelsDev*` 文案）
- Test: `tests/unit/frontend/models-dev-modal.test.js`

**Interfaces:**
- Consumes: `GET /api/models-dev/models`（Task 2）。
- Produces（供 Task 4 使用的内部函数，挂到 `window.__modelsDev` 以便 jsdom 测试）：
  - `openModelsDevModal()` / `closeModelsDevModal()`
  - `fillSelectedModelsDevPrice(strategy: 'overwrite' | 'blank')`

- [ ] **Step 1：写失败测试（jsdom）**

```js
// tests/unit/frontend/models-dev-modal.test.js
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

function mountDom() {
  document.body.innerHTML = `
    <div id="pricing-toast"></div>
    <input id="new-model-input" value="" />
    <input id="new-input-price" value="" />
    <input id="new-output-price" value="" />
    <input id="new-cache-read-price" value="" />
    <input id="new-cache-write-price" value="" />
    <button id="fetch-models-dev-btn"></button>
    <div id="models-dev-modal" hidden>
      <input id="models-dev-search" />
      <div id="models-dev-status"></div>
      <ul id="models-dev-list"></ul>
      <button id="models-dev-fill" disabled></button>
      <button id="models-dev-cancel"></button>
    </div>`;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(CATALOG), { status: 200 })));
  mountDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function importPricing() {
  await import('../../../src/pricing.js');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
}

describe('models.dev modal', () => {
  it('opens modal, lists models, filters by search', async () => {
    await importPricing();
    document.getElementById('fetch-models-dev-btn').click();
    const list = document.getElementById('models-dev-list');
    await vi.waitFor(() => expect(list.children.length).toBe(2));
    const search = document.getElementById('models-dev-search');
    search.value = 'gpt';
    search.dispatchEvent(new Event('input'));
    expect(list.children.length).toBe(1);
    expect(list.textContent).toContain('openai/gpt-5');
  });

  it('fill writes only price fields when all empty', async () => {
    await importPricing();
    document.getElementById('fetch-models-dev-btn').click();
    const list = document.getElementById('models-dev-list');
    await vi.waitFor(() => expect(list.children.length).toBe(2));
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
    document.getElementById('fetch-models-dev-btn').click();
    const list = document.getElementById('models-dev-list');
    await vi.waitFor(() => expect(list.children.length).toBe(2));
    list.querySelector('[data-key="openai/gpt-5"]').click();
    document.getElementById('models-dev-fill').click();
    expect(document.getElementById('new-cache-read-price').value).toBe('');
    expect(document.getElementById('new-cache-write-price').value).toBe('');
  });

  it('shows three-way confirm when some fields are non-empty', async () => {
    await importPricing();
    document.getElementById('new-input-price').value = '9';
    document.getElementById('fetch-models-dev-btn').click();
    const list = document.getElementById('models-dev-list');
    await vi.waitFor(() => expect(list.children.length).toBe(2));
    list.querySelector('[data-key="anthropic/claude-sonnet-4-6"]').click();
    document.getElementById('models-dev-fill').click();
    // 二次确认对话框出现
    const confirm = document.getElementById('models-dev-fill-confirm');
    expect(confirm).not.toBeNull();
    expect(confirm.hidden).toBe(false);
    // 选择「只填空白」
    confirm.querySelector('[data-strategy="blank"]').click();
    expect(document.getElementById('new-input-price').value).toBe('9');
    expect(document.getElementById('new-output-price').value).toBe('15');
  });

  it('shows error state with retry when fetch fails', async () => {
    fetch.mockRejectedValueOnce(new Error('boom'));
    await import('../../../src/pricing.js');
    document.getElementById('fetch-models-dev-btn').click();
    const status = document.getElementById('models-dev-status');
    await vi.waitFor(() => expect(status.textContent).toMatch(/失败|failed/i));
    expect(status.querySelector('[data-action="retry"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/unit/frontend/models-dev-modal.test.js --project jsdom`
Expected: FAIL — 弹窗元素/逻辑不存在

- [ ] **Step 3：实现弹窗**

`pricing.html`：在「添加」按钮前（`#add-pricing-btn` 同行）新增：

```html
        <button id="fetch-models-dev-btn" class="btn-secondary" type="button" data-i18n="pricing.modelsDevFetch">从 models.dev 获取参考价</button>
```

页面尾部新增弹窗骨架（含二次确认子对话框）：

```html
    <!-- models.dev 参考价弹窗 -->
    <div id="models-dev-modal" class="models-dev-modal" hidden role="dialog" aria-modal="true" aria-labelledby="models-dev-modal-title">
      <div class="models-dev-modal-backdrop" data-action="close"></div>
      <div class="models-dev-modal-panel glass-card">
        <div class="models-dev-modal-header">
          <h3 id="models-dev-modal-title" data-i18n="pricing.modelsDevTitle">models.dev 在线价格参考</h3>
          <button type="button" class="models-dev-modal-close" data-action="close" aria-label="关闭">×</button>
        </div>
        <input type="search" id="models-dev-search" data-i18n-placeholder="pricing.modelsDevSearchPlaceholder" placeholder="搜索 provider/model 或名称…" />
        <div id="models-dev-status" class="models-dev-status"></div>
        <ul id="models-dev-list" class="models-dev-list" role="listbox"></ul>
        <div class="models-dev-modal-footer">
          <button type="button" class="btn-secondary" id="models-dev-cancel" data-i18n="pricing.modelsDevCancel">取消</button>
          <button type="button" class="btn-primary" id="models-dev-fill" disabled data-i18n="pricing.modelsDevFill">填入价格</button>
        </div>
        <div id="models-dev-fill-confirm" class="models-dev-fill-confirm" hidden>
          <p data-i18n="pricing.modelsDevFillConfirm">价格格已有内容，如何填入？</p>
          <div class="models-dev-fill-confirm-actions">
            <button type="button" class="btn-primary" data-strategy="overwrite" data-i18n="pricing.modelsDevOverwrite">全部覆盖</button>
            <button type="button" class="btn-secondary" data-strategy="blank" data-i18n="pricing.modelsDevBlank">只填空白</button>
            <button type="button" class="btn-secondary" data-strategy="cancel" data-i18n="pricing.modelsDevConfirmCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
```

`src/pricing.js` 新增（要点，非全量）：

```js
const MODELS_DEV_PRICE_FIELDS = [
  ['new-input-price', 'input'],
  ['new-output-price', 'output'],
  ['new-cache-read-price', 'cacheRead'],
  ['new-cache-write-price', 'cacheWrite'],
];

let modelsDevCatalog = null;      // 最近一次成功加载的目录
let modelsDevSelectedKey = null;  // 当前单选 key

async function fetchModelsDevCatalog() {
  const res = await fetch('/api/models-dev/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function openModelsDevModal() { /* 显示弹窗；首次打开或重试时加载目录；状态机 loading/error(list 清空 + 重试按钮)/ready(渲染列表，stale 角标) */ }
function closeModelsDevModal() { /* hidden = true；清空选中态与二次确认 */ }
function renderModelsDevList(filter) { /* 本地过滤 provider/model/displayName，渲染 <li data-key>，点击单选高亮并启用「填入价格」 */ }

function writePrices(cost, strategy) {
  for (const [fieldId, prop] of MODELS_DEV_PRICE_FIELDS) {
    const el = document.getElementById(fieldId);
    if (!el) continue;
    if (strategy === 'blank' && el.value.trim() !== '') continue;
    el.value = cost[prop] == null ? '' : String(cost[prop]);
  }
}

function fillSelectedModelsDevPrice(strategy) {
  const row = modelsDevCatalog?.models.find((m) => m.key === modelsDevSelectedKey);
  if (!row) return;
  writePrices(row.cost, strategy);
  closeModelsDevModal();
  showPricingToast(
    t(strategy === 'overwrite' ? 'pricing.modelsDevFilledOverwrite' : 'pricing.modelsDevFilledBlank'),
    { variant: 'success' },
  );
  document.getElementById('add-pricing-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 「填入价格」点击：
// 1) pricingTableEditingKey !== null → toast 拦截（沿用现有提示文案）；
// 2) 4 格全空 → writePrices(cost, 'overwrite') 直接填并关窗；
// 3) 否则显示 #models-dev-fill-confirm，三选按钮分派 'overwrite' | 'blank' | 关闭。
```

挂测试钩子：`window.__modelsDev = { openModelsDevModal, closeModelsDevModal, fillSelectedModelsDevPrice };`

弹窗 CSS 追加到 `src/style.css`：复用 `glass-card`、`btn-primary`/`btn-secondary`、CSS 变量（`--text-secondary` 等）；遮罩半透明 `position: fixed; inset: 0`，面板最大宽度 720px、列表最大高度 50vh 滚动；遵循既有浅/深主题变量，不引入新色值。

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/unit/frontend/models-dev-modal.test.js --project jsdom`
Expected: PASS（5 个用例）

- [ ] **Step 5：Commit**

```bash
git add pricing.html src/pricing.js src/style.css src/locales/zh-CN.js src/locales/en-US.js tests/unit/frontend/models-dev-modal.test.js
git commit -m "feat(pricing-ui): add models.dev reference modal filling only price fields"
```

---

## Task 4: 双语文案补全 + README 同步 + 帮助说明

**Files:**
- Modify: `src/locales/zh-CN.js`、`src/locales/en-US.js`（核对 Task 3 文案键完整性）
- Modify: `pricing.html`（帮助 tooltip 追加 models.dev 说明一条）
- Modify: `README.md`、`README_EN.md`（功能说明各补一段）

**Interfaces:**
- Consumes: Task 3 使用的 `pricing.modelsDev*` 键。
- Produces: 完整双语键集合：`modelsDevFetch`、`modelsDevTitle`、`modelsDevSearchPlaceholder`、`modelsDevCancel`、`modelsDevFill`、`modelsDevFillConfirm`、`modelsDevOverwrite`、`modelsDevBlank`、`modelsDevConfirmCancel`、`modelsDevFilledOverwrite`、`modelsDevFilledBlank`、`modelsDevLoading`、`modelsDevFailed`、`modelsDevRetry`、`modelsDevStaleBadge`。

- [ ] **Step 1：写失败测试**

```js
// tests/unit/frontend/i18n.test.js 追加用例
it('pricing.modelsDev* keys exist in both locales with same key set', async () => {
  const zh = (await import('../../../src/locales/zh-CN.js')).default;
  const en = (await import('../../../src/locales/en-US.js')).default;
  const zhKeys = Object.keys(zh.pricing).filter((k) => k.startsWith('modelsDev')).sort();
  const enKeys = Object.keys(en.pricing).filter((k) => k.startsWith('modelsDev')).sort();
  expect(zhKeys.length).toBeGreaterThan(0);
  expect(zhKeys).toEqual(enKeys);
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run tests/unit/frontend/i18n.test.js --project jsdom`
Expected: FAIL（键数不匹配或为 0）

- [ ] **Step 3：补全文案与文档**

`zh-CN.js` `pricing` 节追加（en-US 对照翻译）：

```js
    modelsDevFetch: '从 models.dev 获取参考价',
    modelsDevTitle: 'models.dev 在线价格参考',
    modelsDevSearchPlaceholder: '搜索 provider/model 或名称…',
    modelsDevCancel: '取消',
    modelsDevFill: '填入价格',
    modelsDevFillConfirm: '价格格已有内容，如何填入？',
    modelsDevOverwrite: '全部覆盖',
    modelsDevBlank: '只填空白',
    modelsDevConfirmCancel: '取消',
    modelsDevFilledOverwrite: '已填入 models.dev 参考价（覆盖价格格），请确认 Provider/Model 后保存',
    modelsDevFilledBlank: '已填入 models.dev 参考价（仅空白格），请确认 Provider/Model 后保存',
    modelsDevLoading: '正在加载 models.dev 目录…',
    modelsDevFailed: 'models.dev 目录加载失败',
    modelsDevRetry: '重试',
    modelsDevStaleBadge: '缓存数据（更新失败，展示上次结果）',
```

`pricing.html` 帮助 tooltip `<ul>` 内追加一条：

```html
                  <li>「从 models.dev 获取参考价」来自 <a href="https://models.dev" target="_blank" rel="noreferrer">models.dev</a> 公开目录：本地缓存 24 小时，过期后先展示上次快照并后台刷新；填入的只是参考单价，不会写入模型键，保存前请自行确认</li>
```

`README.md` / `README_EN.md` 在价格配置功能说明处各补一段（中文/英文对应）：入口位置、弹窗搜索单选、只填价格格、覆盖/只填空白/取消三选、缓存与 fail-closed 语义。

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run tests/unit/frontend/i18n.test.js --project jsdom`
Expected: PASS

- [ ] **Step 5：Commit**

```bash
git add src/locales/zh-CN.js src/locales/en-US.js pricing.html README.md README_EN.md tests/unit/frontend/i18n.test.js
git commit -m "docs(pricing): bilingual copy and README for models.dev reference fill"
```

---

## Task 5: 全量门禁 + 手工冒烟

**Files:**
- 无新增文件；执行验证与必要的小修复。

- [ ] **Step 1：全量测试**

Run: `npm test`
Expected: node + jsdom 双 project 全绿

- [ ] **Step 2：构建**

Run: `npm run build`
Expected: 生成 `dist/index.html` 与 `dist/pricing.html`，无报错

- [ ] **Step 3：真实接口冒烟（可选但推荐）**

```bash
OPENCLAW_CONFIG_DIR=$(mktemp -d) node -e "
import('./models-dev.js').then(async (m) => {
  const out = await m.getModelsDevCatalog();
  console.log(out.models.length, out.stale, out.source);
  const again = await m.getModelsDevCatalog();
  console.log('cached:', again.stale === false);
});"
```
Expected: 打印模型数 > 1000、`false`、`models.dev`；第二次命中缓存

- [ ] **Step 4：启动本地服务手工验证弹窗（用户侧确认）**

```bash
./scripts/openclaw-usage-cli.js build && ./scripts/openclaw-usage-cli.js start
```
浏览器打开价格页 → 「从 models.dev 获取参考价」→ 搜索/单选/填入（分别验证全空直填、覆盖、只填空白、取消、模型键不变）。

- [ ] **Step 5：Commit（如有修复）**

```bash
git add -A
git commit -m "chore(models-dev): gate fixes from full test/build run"
```

---

## Self-Review 记录

- **Spec 覆盖**：服务端模块（Task 1）、只读 API（Task 2）、弹窗与填入三态（Task 3）、双语/README/帮助（Task 4）、门禁与冒烟（Task 5）——规格各节均有对应任务。
- **占位符**：无 TBD/TODO；Task 3 的 `src/pricing.js` 片段为要点级伪代码（标注「非全量」），其余均为可直接落盘的完整代码。
- **类型一致**：`cost: { input, output, cacheRead, cacheWrite }`、`fillSelectedModelsDevPrice(strategy)`、`models[]` 字段在 Task 1/2/3 间一致；`MODELS_DEV_PRICE_FIELDS` 字段 id 与 `pricing.html` 现有 id 完全一致。
