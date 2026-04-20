import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { aggregateStats } from '../../../aggregator.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

function copyRealSessions(ws) {
  const src = fixturePath('sessions-real');
  for (const name of readdirSync(src)) copyFileSync(join(src, name), join(ws.sessionsDir, name));
}

function copySynthSession(ws, destName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl') {
  copyFileSync(fixturePath('sessions-synth', 'edge-matrix.jsonl'), join(ws.sessionsDir, destName));
}

const NO_CUSTOM_PRICING = { version: '1.0', enabled: false, pricing: {} };

describe('aggregateStats', () => {
  it('returns empty aggregate when sessions dir is empty', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const data = await aggregateStats(NO_CUSTOM_PRICING);

    expect(data.summary.totalSessions).toBe(0);
    expect(data.summary.totalRequests).toBe(0);
    expect(data.byProvider).toEqual({});
    expect(data.byDateProvider).toEqual({});
    expect(data.sessions).toEqual([]);
  });

  it('parses synthetic edge-matrix correctly', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copySynthSession(ws);

    const data = await aggregateStats(NO_CUSTOM_PRICING);

    expect(data.summary.totalRequests).toBe(3);
    expect(data.summary.totalSessions).toBe(1);
    expect(Object.keys(data.byProvider).sort()).toEqual(['anthropic', 'openai']);
    expect(data.byDateProvider['2026-04-15']).toBeDefined();
    expect(data.byDateProvider['2026-04-16']).toBeDefined();
  });

  it('skips checkpoint files while real sessions still aggregate', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyRealSessions(ws);

    const data = await aggregateStats(NO_CUSTOM_PRICING);

    const allFiles = readdirSync(ws.sessionsDir);
    const checkpointCount = allFiles.filter((n) => n.includes('.checkpoint.')).length;
    expect(checkpointCount).toBeGreaterThan(0);
    expect(data.summary.totalSessions).toBeLessThanOrEqual(allFiles.length - checkpointCount);
    expect(data.summary.totalRequests).toBeGreaterThan(0);
  });

  it('applies custom pricing when pricingConfig supplied', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copySynthSession(ws);

    const bigCustom = {
      version: '1.0',
      enabled: true,
      pricing: {
        'openai/gpt-4o': { input: 100, output: 100, cacheRead: null, cacheWrite: null },
        'anthropic/claude-*': { matchType: 'wildcard', input: 100, output: 100 },
      },
    };

    const dataCustom = await aggregateStats(bigCustom);
    const dataOriginal = await aggregateStats(NO_CUSTOM_PRICING);

    expect(dataCustom.summary.totalCost).toBeGreaterThan(dataOriginal.summary.totalCost);
  });

  it('produces byDate keyed by ISO date', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copySynthSession(ws);

    const data = await aggregateStats(NO_CUSTOM_PRICING);

    expect(data.byDate['2026-04-15']).toBeDefined();
    expect(data.byDate['2026-04-16']).toBeDefined();
    expect(data.byDate['2026-04-15'].requests + data.byDate['2026-04-16'].requests).toBe(3);
  });
});
