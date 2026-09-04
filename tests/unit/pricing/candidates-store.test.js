import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  loadCandidates,
  saveCandidates,
  upsertCandidateEntry,
  withCandidatesLock,
} from '../../../pricing-candidates-store.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

describe('candidates store', () => {
  it('returns empty state when file missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    expect(await loadCandidates()).toEqual({ candidates: [] });
  });

  it('returns empty state on corrupt file (machine artifact, rebuildable)', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    writeFileSync(join(ws.configDir, 'openclaw-usage-pricing-candidates.json'), '{broken', 'utf-8');
    expect(await loadCandidates()).toEqual({ candidates: [] });
  });

  it('upsert dedupes by observedKey and refreshes lastSeenAt', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const state = { candidates: [] };
    upsertCandidateEntry(state, { observedKey: 'cpa/x', candidates: [], lastSeenAt: 'T1', dismissed: false });
    upsertCandidateEntry(state, { observedKey: 'cpa/x', candidates: [{ catalogKey: 'a/b' }], lastSeenAt: 'T2', dismissed: false });
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0].lastSeenAt).toBe('T2');
  });

  it('save/load round-trip', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await saveCandidates({ candidates: [{ observedKey: 'cpa/x', candidates: [], lastSeenAt: 'T', dismissed: false }] });
    expect((await loadCandidates()).candidates).toHaveLength(1);
  });

  it('withCandidatesLock serializes read-modify-write sections', async () => {
    const order = [];
    await Promise.all([
      withCandidatesLock(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('slow'); }),
      withCandidatesLock(async () => { order.push('fast'); }),
    ]);
    // 无锁时 fast 会先完成；串行化后必须等 slow 释放
    expect(order).toEqual(['slow', 'fast']);
  });

  it('withCandidatesLock keeps the chain alive after a failing section', async () => {
    await expect(withCandidatesLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withCandidatesLock(async () => 'ok')).resolves.toBe('ok');
  });
});
