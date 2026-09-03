import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../helpers/tmp-workspace.js';
import {
  buildSourceSnapshot,
  validateSourceSnapshot,
  storeImportedSnapshot,
  loadImportedSnapshots,
  __readBoundedSnapshotFileForTests,
  MAX_SNAPSHOT_BYTES,
  MAX_CONTRIBUTIONS,
  MAX_SAFE_SNAPSHOT_VALUE,
} from '../../sync-snapshot.js';

const disposables = [];

afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

function syncConfig(overrides = {}) {
  return {
    version: 1,
    source: { id: 'mbp', label: 'MBP' },
    policy: { allowedSshTargets: {} },
    settings: { enabled: true, targetId: null, intervalMinutes: 60 },
    imports: { allowedSourceIds: [] },
    ...overrides,
  };
}

function cacheSnapshot() {
  return {
    revision: 7,
    generatedAt: '2026-08-24T12:00:00.000Z',
    manifest: { 'secret-session.jsonl': { size: 900, mtimeMs: 123 } },
    files: {
      'secret-session.jsonl': {
        session: {
          id: 'session-1',
          status: 'active',
          archivedAt: null,
          filename: 'secret-session.jsonl',
        },
        identity: { size: 900, mtimeMs: 123 },
        firstTimestamp: '2026-08-24T11:00:00.000Z',
        lastTimestamp: '2026-08-24T11:30:00.000Z',
        hasRecords: true,
        buckets: [
          {
            date: '2026-08-24',
            provider: 'openai',
            model: 'gpt-5',
            usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37 },
            openclawCost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
            requests: 1,
            totalCost: 99,
          },
        ],
        content: 'do not export this',
      },
    },
    pricingFingerprint: { pricing: { secret: 'do not export' } },
  };
}

function validImportedSnapshot(config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } })) {
  const snapshot = buildSourceSnapshot(cacheSnapshot(), syncConfig());
  snapshot.source = { id: 'mbp', label: 'MBP' };
  return snapshot;
}

describe('source contribution snapshots', () => {
  it('exports an exact allowlist with opaque stable contribution IDs', () => {
    const config = syncConfig();
    const first = buildSourceSnapshot(cacheSnapshot(), config);
    const second = buildSourceSnapshot(cacheSnapshot(), config);

    expect(first.version).toBe(1);
    expect(first.kind).toBe('openclaw-usage-source-contributions');
    expect(first.scope).toBe('local-only');
    expect(first.source).toEqual({ id: 'mbp', label: 'MBP' });
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contributions).toHaveLength(1);
    expect(first.contributions[0]).toEqual({
      contributionId: first.contributions[0].contributionId,
      session: { id: 'session-1', status: 'active', archivedAt: null },
      firstTimestamp: '2026-08-24T11:00:00.000Z',
      lastTimestamp: '2026-08-24T11:30:00.000Z',
      buckets: [
        {
          date: '2026-08-24',
          provider: 'openai',
          model: 'gpt-5',
          usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37 },
          openclawCost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
          requests: 1,
        },
      ],
      hasRecords: true,
    });
    expect(first.contributions[0].contributionId).not.toContain('secret-session.jsonl');
    expect(first.contributions[0].contributionId).toBe(second.contributions[0].contributionId);
    const serialized = JSON.stringify(first);
    for (const forbidden of ['filename', 'identity', 'manifest', 'pricing', 'content', 'totalCost', 'secret-session.jsonl']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('normalizes legacy cache timestamps into receiver-valid wire timestamps', () => {
    const senderConfig = syncConfig();
    const receiverConfig = syncConfig({
      source: { id: 'claw', label: 'claw' },
      imports: { allowedSourceIds: ['mbp'] },
    });
    const cache = cacheSnapshot();
    cache.files['secret-session.jsonl'].session.archivedAt = String(Date.parse('2026-08-24T12:34:56.789Z'));
    cache.files['secret-session.jsonl'].firstTimestamp = String(Date.parse('2026-08-24T11:00:00.000Z'));
    cache.files['secret-session.jsonl'].lastTimestamp = 'legacy timestamp that cannot be converted';

    const snapshot = buildSourceSnapshot(cache, senderConfig);
    const contribution = snapshot.contributions[0];
    expect(contribution.session.archivedAt).toBe('2026-08-24T12:34:56.789Z');
    expect(contribution.firstTimestamp).toBe('2026-08-24T11:00:00.000Z');
    expect(contribution.lastTimestamp).toBeNull();
    expect(validateSourceSnapshot(snapshot, receiverConfig)).toBe(true);
  });

  it('accepts mixed sqlite/archive/legacy contributions with done and deleted statuses', () => {
    const receiverConfig = syncConfig({
      source: { id: 'claw', label: 'claw' },
      imports: { allowedSourceIds: ['mbp'] },
    });
    const cache = cacheSnapshot();
    const base = cache.files['secret-session.jsonl'];
    cache.files = {
      'sqlite:sess-a': { ...structuredClone(base), session: { id: 'sess-a', status: 'done', archivedAt: null } },
      'sqlite-archive:sess-b@deadbeef': {
        ...structuredClone(base),
        session: { id: 'sess-b', status: 'deleted', archivedAt: '2026-08-24T11:30:00.000Z' },
      },
      'legacy:old-session.jsonl': {
        ...structuredClone(base),
        session: { id: 'old-1', status: 'done', archivedAt: '2026-08-20T00:00:00.000Z' },
      },
    };

    const snapshot = buildSourceSnapshot(cache, syncConfig());
    snapshot.source = { id: 'mbp', label: 'MBP' };
    expect(snapshot.contributions).toHaveLength(3);
    expect(snapshot.contributions.map((c) => c.session.status).sort()).toEqual(['deleted', 'done', 'done']);
    expect(validateSourceSnapshot(snapshot, receiverConfig)).toBe(true);
  });

  it('rejects unauthorized sources, unknown fields, and invalid counters', () => {
    const config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } });
    const snapshot = validImportedSnapshot(config);
    expect(validateSourceSnapshot(snapshot, config)).toBe(true);

    expect(() => validateSourceSnapshot({ ...snapshot, source: { id: 'other', label: 'Other' } }, config)).toThrow(/unauthorized/i);
    expect(() => validateSourceSnapshot({ ...snapshot, unexpected: true }, config)).toThrow(/unknown/i);
    const bad = structuredClone(snapshot);
    bad.contributions[0].buckets[0].usage.input = -1;
    expect(() => validateSourceSnapshot(bad, config)).toThrow(/non-negative/i);
    const infinite = structuredClone(snapshot);
    infinite.contributions[0].buckets[0].openclawCost.total = Infinity;
    expect(() => validateSourceSnapshot(infinite, config)).toThrow(/finite/i);

    const unsafe = structuredClone(snapshot);
    unsafe.contributions[0].buckets[0].usage.input = 1e308;
    expect(() => validateSourceSnapshot(unsafe, config)).toThrow(/safe|aggregate|counter/i);
  });

  it('rejects oversized snapshots and contribution arrays before storage', () => {
    const config = syncConfig();
    const snapshot = buildSourceSnapshot(cacheSnapshot(), config);
    const tooMany = structuredClone(snapshot);
    tooMany.contributions = Array.from({ length: MAX_CONTRIBUTIONS + 1 }, () => snapshot.contributions[0]);
    expect(() => validateSourceSnapshot(tooMany, config)).toThrow(/contributions/i);

    const tooLarge = structuredClone(snapshot);
    tooLarge.revision = 'x'.repeat(MAX_SNAPSHOT_BYTES);
    expect(() => validateSourceSnapshot(tooLarge, config)).toThrow(/size/i);
  });

  it('accepts the documented numeric boundary while keeping values finite', () => {
    const senderConfig = syncConfig();
    const config = syncConfig({
      source: { id: 'claw', label: 'claw' },
      imports: { allowedSourceIds: ['mbp'] },
    });
    const bounded = buildSourceSnapshot(cacheSnapshot(), senderConfig);
    const bucket = bounded.contributions[0].buckets[0];
    bucket.usage = Object.fromEntries(Object.keys(bucket.usage).map((key) => [key, MAX_SAFE_SNAPSHOT_VALUE]));
    bucket.openclawCost = Object.fromEntries(Object.keys(bucket.openclawCost).map((key) => [key, MAX_SAFE_SNAPSHOT_VALUE]));
    bucket.requests = MAX_SAFE_SNAPSHOT_VALUE;
    expect(validateSourceSnapshot(bounded, config)).toBe(true);
  });

  it('atomically stores mode-0600 imports and ignores corrupt files without replacing valid data', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } });
    const snapshot = validImportedSnapshot(config);

    await expect(storeImportedSnapshot(snapshot, { syncConfig: config })).resolves.toMatchObject({
      ok: true,
      sourceId: 'mbp',
    });
    const importDir = join(ws.configDir, 'cache', 'openclaw-usage', 'imports');
    const importPath = join(importDir, 'mbp.json');
    expect(statSync(importDir).mode & 0o777).toBe(0o700);
    expect(statSync(importPath).mode & 0o777).toBe(0o600);
    const before = readFileSync(importPath, 'utf8');
    expect(before).toBe(JSON.stringify(snapshot));
    await expect(loadImportedSnapshots({ syncConfig: config })).resolves.toEqual([snapshot]);

    await expect(storeImportedSnapshot({ ...snapshot, version: 2 }, { syncConfig: config })).rejects.toThrow(/version/i);
    expect(readFileSync(importPath, 'utf8')).toBe(before);

    const unsafe = structuredClone(snapshot);
    unsafe.contributions[0].buckets[0].usage.input = 1e308;
    await expect(storeImportedSnapshot(unsafe, { syncConfig: config })).rejects.toThrow(/safe|aggregate|counter/i);
    expect(readFileSync(importPath, 'utf8')).toBe(before);

    writeFileSync(join(importDir, 'corrupt.json'), '{not-json', { mode: 0o600 });
    await expect(loadImportedSnapshots({ syncConfig: config })).resolves.toEqual([snapshot]);
  });

  it('fails closed when the import directory cannot be read', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const notADirectory = join(ws.configDir, 'not-a-directory');
    writeFileSync(notADirectory, 'not a directory');
    const config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } });

    await expect(loadImportedSnapshots({ importDir: notADirectory, syncConfig: config })).rejects.toThrow(
      /unable to read imported snapshots/i
    );
  });

  it('rejects oversized valid JSON before JSON parsing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const importDir = join(ws.configDir, 'cache', 'openclaw-usage', 'imports');
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, 'mbp.json'), JSON.stringify({ padding: 'x'.repeat(MAX_SNAPSHOT_BYTES) }));
    const config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } });

    const parseSpy = vi.spyOn(JSON, 'parse');
    await expect(loadImportedSnapshots({ syncConfig: config })).resolves.toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('reads a valid snapshot across short FileHandle reads until EOF', async () => {
    const snapshot = validImportedSnapshot();
    const raw = JSON.stringify(snapshot);
    let cursor = 0;
    const shortReadOpen = async () => ({
      async read(buffer, offset) {
        if (cursor >= raw.length) return { bytesRead: 0 };
        const chunk = Buffer.from(raw.slice(cursor, cursor + 7));
        chunk.copy(buffer, offset);
        cursor += chunk.length;
        return { bytesRead: chunk.length };
      },
      async close() {},
    });

    await expect(
      __readBoundedSnapshotFileForTests('ignored-by-test', Buffer.byteLength(raw), shortReadOpen)
    ).resolves.toBe(raw);
  });

  it('does not follow symlinks in the import directory', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const config = syncConfig({ source: { id: 'claw', label: 'claw' }, imports: { allowedSourceIds: ['mbp'] } });
    const externalPath = join(ws.root, 'outside.json');
    const snapshot = validImportedSnapshot(config);
    writeFileSync(externalPath, JSON.stringify(snapshot));
    const importDir = join(ws.configDir, 'cache', 'openclaw-usage', 'imports');
    mkdirSync(importDir, { recursive: true });
    symlinkSync(externalPath, join(importDir, 'mbp.json'));

    await expect(loadImportedSnapshots({ syncConfig: config })).resolves.toEqual([]);
  });
});
