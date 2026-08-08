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

  it('keeps missing input/output as null instead of 0', async () => {
    const payload = {
      test: {
        id: 'test',
        models: {
          'no-cost': { id: 'no-cost', name: 'No Cost' },
          partial: { id: 'partial', cost: { input: 2 } },
        },
      },
    };
    const out = await getModelsDevCatalog({ fetchImpl: okFetch(payload) });
    const noCost = out.models.find((m) => m.key === 'test/no-cost');
    expect(noCost.cost).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null });
    const partial = out.models.find((m) => m.key === 'test/partial');
    expect(partial.cost.input).toBe(2);
    expect(partial.cost.output).toBeNull();
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
