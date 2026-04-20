import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { getStats, invalidateStatsCache } from '../../../stats-service.js';

const disposables = [];

beforeEach(() => {
  invalidateStatsCache();
});

afterEach(async () => {
  vi.useRealTimers();
  while (disposables.length) await disposables.pop()();
  invalidateStatsCache();
});

async function setupWorkspace(pricingUpdated = '2026-04-20T00:00:00.000Z') {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: pricingUpdated,
    pricing: {},
  });
  return ws;
}

describe('stats-service cache', () => {
  it('returns cached value within TTL', async () => {
    await setupWorkspace();

    const a = await getStats();
    const b = await getStats();
    expect(a).toBe(b);
  });

  it('rebuilds when pricing.updated changes', async () => {
    const ws = await setupWorkspace('2026-04-20T00:00:00.000Z');

    const a = await getStats();
    expect(a.pricingUpdated).toBe('2026-04-20T00:00:00.000Z');

    await ws.writePricingConfig({
      version: '1.0',
      enabled: true,
      updated: '2026-04-21T00:00:00.000Z',
      pricing: {},
    });

    const b = await getStats();
    expect(b).not.toBe(a);
    expect(b.pricingUpdated).toBe('2026-04-21T00:00:00.000Z');
  });

  it('rebuilds after TTL elapses', async () => {
    vi.useFakeTimers();
    await setupWorkspace();

    const a = await getStats();
    vi.advanceTimersByTime(31_000);
    const b = await getStats();
    expect(b).not.toBe(a);
  });

  it('forceFresh bypasses cache', async () => {
    await setupWorkspace();

    const a = await getStats();
    const b = await getStats({ forceFresh: true });
    expect(b).not.toBe(a);
  });

  it('returns same object reference within TTL and same pricing.updated', async () => {
    await setupWorkspace();

    const first = await getStats();
    const second = await getStats();
    const third = await getStats();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
