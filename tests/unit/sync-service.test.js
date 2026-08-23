import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../helpers/tmp-workspace.js';
import {
  syncToTarget,
  receiveSync,
  getSyncStatus,
  testSyncTarget,
  MAX_SYNC_SNAPSHOT_BYTES,
  SYNC_PROBE_ENVELOPE,
} from '../../sync-service.js';

const disposables = [];

afterEach(async () => {
  while (disposables.length) await disposables.pop()();
  vi.restoreAllMocks();
});

function senderConfig(overrides = {}) {
  return {
    version: 1,
    source: { id: 'mbp', label: 'MBP' },
    policy: { allowedSshTargets: { claw: { label: 'claw', sshAlias: 'claw' } } },
    settings: { enabled: true, targetId: 'claw', intervalMinutes: 60 },
    imports: { allowedSourceIds: [] },
    ...overrides,
  };
}

function receiverConfig(overrides = {}) {
  return {
    version: 1,
    source: { id: 'claw', label: 'claw' },
    policy: { allowedSshTargets: {} },
    settings: { enabled: false, targetId: null, intervalMinutes: 60 },
    imports: { allowedSourceIds: ['mbp'] },
    ...overrides,
  };
}

function snapshot() {
  return {
    version: 1,
    kind: 'openclaw-usage-source-contributions',
    scope: 'local-only',
    source: { id: 'mbp', label: 'MBP' },
    revision: 'revision-1',
    generatedAt: '2026-08-24T12:00:00.000Z',
    contributions: [],
  };
}

function fakeChild({ error = null } = {}) {
  const writes = [];
  const child = {
    stdin: {
      end(value) {
        writes.push(value);
      },
    },
    writes,
  };
  queueMicrotask(() => child._callback?.(error, '', 'raw credential stderr')); // eslint-disable-line no-underscore-dangle
  return child;
}

describe('sync transport', () => {
  it('rejects a target that is not in the local allowlist without spawning SSH', async () => {
    const config = senderConfig();
    const execFile = vi.fn();

    await expect(syncToTarget('../claw', {
      syncConfig: config,
      execFile,
      refreshStatsCache: async () => {},
      getLocalContributionCache: async () => ({ files: {}, revision: 1 }),
    })).rejects.toThrow(/allowlist|target/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('resolves the configured default target and sends a sanitized snapshot over stdin', async () => {
    const config = senderConfig();
    let child;
    const execFile = vi.fn((file, args, options, callback) => {
      child = fakeChild();
      child._callback = callback; // eslint-disable-line no-underscore-dangle
      return child;
    });

    const result = await syncToTarget(undefined, {
      syncConfig: config,
      execFile,
      refreshStatsCache: async () => {},
      getLocalContributionCache: async () => ({
        revision: 3,
        generatedAt: '2026-08-24T12:00:00.000Z',
        files: {
          'private.jsonl': {
            session: { id: 'session-1', status: 'active', archivedAt: null, filename: 'private.jsonl' },
            hasRecords: false,
            buckets: [],
          },
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, targetId: 'claw' });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0];
    expect(file).toBe('ssh');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', expect.stringMatching(/^ConnectTimeout=/), 'claw', 'openclaw-usage', 'receive-sync']);
    expect(options.timeout).toBeGreaterThan(0);
    expect(child.writes).toHaveLength(1);
    expect(child.writes[0]).toContain('openclaw-usage-source-contributions');
    expect(child.writes[0]).not.toContain('private.jsonl');
  });

  it('reports SSH timeout and nonzero exit without exposing stderr', async () => {
    const config = senderConfig();
    for (const error of [
      Object.assign(new Error('ssh leaked credential=secret'), { code: 'ETIMEDOUT', killed: true }),
      Object.assign(new Error('ssh leaked credential=secret'), { code: 7 }),
    ]) {
      const execFile = vi.fn((file, args, options, callback) => {
        const child = fakeChild({ error });
        child._callback = callback; // eslint-disable-line no-underscore-dangle
        return child;
      });
      await expect(syncToTarget('claw', {
        syncConfig: config,
        execFile,
        refreshStatsCache: async () => {},
        getLocalContributionCache: async () => ({ files: {}, revision: 1 }),
      })).rejects.toSatisfy((err) => {
        expect(err.message).not.toContain('secret');
        expect(err.message).not.toContain('raw credential stderr');
        return /SSH/i.test(err.message);
      });
    }
  });

  it('blocks outbound SSH when the refreshed local contribution cache is stale', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const statusPath = join(ws.configDir, 'run', 'openclaw-usage', 'sync-status.json');
    const execFile = vi.fn();
    await expect(syncToTarget('claw', {
      syncConfig: senderConfig(),
      statusPath,
      execFile,
      refreshStatsCache: async () => {},
      getLocalContributionCache: async () => ({ files: {}, revision: 4, cacheState: 'stale' }),
    })).rejects.toThrow(/fresh|stale/i);
    expect(execFile).not.toHaveBeenCalled();
    const status = await getSyncStatus({ statusPath, syncConfig: senderConfig() });
    expect(status.lastSuccess).toBeNull();
    expect(status.failureSince).toBeTruthy();
  });

  it('returns an explicit disabled/no-target error when config is absent', async () => {
    const execFile = vi.fn();
    await expect(syncToTarget(undefined, {
      syncConfig: {
        version: 1,
        source: { id: 'local', label: 'Local' },
        policy: { allowedSshTargets: {} },
        settings: { enabled: false, targetId: null, intervalMinutes: 60 },
        imports: { allowedSourceIds: [] },
      },
      execFile,
    })).rejects.toThrow(/disabled|no target/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('skips disabled scheduled syncs without SSH or a failure status', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const statusPath = join(ws.configDir, 'run', 'openclaw-usage', 'sync-status.json');
    const execFile = vi.fn();
    await expect(syncToTarget(undefined, {
      scheduled: true,
      syncConfig: senderConfig({
        settings: { enabled: false, targetId: 'claw', intervalMinutes: 60 },
      }),
      statusPath,
      execFile,
    })).resolves.toMatchObject({ ok: true, skipped: true, status: 'disabled' });
    expect(execFile).not.toHaveBeenCalled();
    const status = await getSyncStatus({ statusPath, syncConfig: senderConfig() });
    expect(status.lastAttempt).toBeNull();
    expect(status.failureSince).toBeNull();
  });
});

describe('receive-sync transport', () => {
  it('accepts the exact connection probe without creating an import snapshot', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const result = await receiveSync(JSON.stringify(SYNC_PROBE_ENVELOPE || {}), {
      syncConfig: receiverConfig(),
      importDir: join(ws.configDir, 'cache', 'openclaw-usage', 'imports'),
    });
    expect(result).toEqual({ ok: true, probe: true });
    expect(existsSync(join(ws.configDir, 'cache', 'openclaw-usage', 'imports'))).toBe(false);
  });

  it('rejects probe envelopes with extra or modified fields', async () => {
    await expect(receiveSync(JSON.stringify({ ...SYNC_PROBE_ENVELOPE, source: 'bad' }), {
      syncConfig: receiverConfig(),
    })).rejects.toThrow(/invalid|snapshot/i);
  });

  it('reads one bounded stdin snapshot and atomically stores it', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const result = await receiveSync(Readable.from([JSON.stringify(snapshot())]), {
      syncConfig: receiverConfig(),
      importDir: join(ws.configDir, 'cache', 'openclaw-usage', 'imports'),
    });
    expect(result).toMatchObject({ ok: true, sourceId: 'mbp' });
    expect(existsSync(join(ws.configDir, 'cache', 'openclaw-usage', 'imports', 'mbp.json'))).toBe(true);
  });

  it('rejects oversized or malformed stdin before replacing a valid snapshot', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const options = {
      syncConfig: receiverConfig(),
      importDir: join(ws.configDir, 'cache', 'openclaw-usage', 'imports'),
    };
    await receiveSync(JSON.stringify(snapshot()), options);
    const path = join(options.importDir, 'mbp.json');
    const before = readFileSync(path, 'utf8');
    await expect(receiveSync(`{"padding":"${'x'.repeat(MAX_SYNC_SNAPSHOT_BYTES)}"}`, options)).rejects.toThrow(/size/i);
    await expect(receiveSync('{not-json', options)).rejects.toThrow(/invalid|JSON/i);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('sync status', () => {
  it('persists sanitized failure state and exposes no raw process output', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const config = senderConfig();
    const statusPath = join(ws.configDir, 'run', 'openclaw-usage', 'sync-status.json');
    const execFile = vi.fn((file, args, options, callback) => {
      const child = fakeChild({ error: Object.assign(new Error('token=secret'), { code: 9 }) });
      child._callback = callback; // eslint-disable-line no-underscore-dangle
      return child;
    });
    await expect(syncToTarget('claw', {
      syncConfig: config,
      statusPath,
      execFile,
      refreshStatsCache: async () => {},
      getLocalContributionCache: async () => ({ files: {}, revision: 1 }),
    })).rejects.toThrow();
    const status = await getSyncStatus({ statusPath, syncConfig: config });
    expect(status.lastAttempt).toBeTruthy();
    expect(status.failureSince).toBeTruthy();
    expect(status.error).not.toContain('secret');
    expect(status.error).not.toContain('stderr');
  });

  it('preserves first failureSince and lastSuccess across failures, then clears failureSince on success', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const config = senderConfig();
    const statusPath = join(ws.configDir, 'run', 'openclaw-usage', 'sync-status.json');
    let fail = true;
    const execFile = vi.fn((file, args, options, callback) => {
      const child = fakeChild({ error: fail ? Object.assign(new Error('transport'), { code: 9 }) : null });
      child._callback = callback; // eslint-disable-line no-underscore-dangle
      return child;
    });
    const common = {
      syncConfig: config,
      statusPath,
      execFile,
      refreshStatsCache: async () => {},
      getLocalContributionCache: async () => ({ files: {}, revision: 1, cacheState: 'fresh' }),
    };
    await expect(syncToTarget('claw', common)).rejects.toThrow();
    const first = await getSyncStatus({ statusPath, syncConfig: config });
    await expect(syncToTarget('claw', common)).rejects.toThrow();
    const second = await getSyncStatus({ statusPath, syncConfig: config });
    expect(second.failureSince).toBe(first.failureSince);
    expect(second.lastSuccess).toBeNull();
    expect(execFile).toHaveBeenCalledTimes(2);

    fail = false;
    await expect(syncToTarget('claw', common)).resolves.toMatchObject({ ok: true });
    const recovered = await getSyncStatus({ statusPath, syncConfig: config });
    expect(recovered.failureSince).toBeNull();
    expect(recovered.lastSuccess).toBeTruthy();
    expect(execFile).toHaveBeenCalledTimes(3);
  });
});

describe('test target', () => {
  it('only resolves an allowlisted target and uses the fixed receiver command', async () => {
    const config = senderConfig();
    const execFile = vi.fn((file, args, options, callback) => {
      const child = fakeChild();
      child._callback = callback; // eslint-disable-line no-underscore-dangle
      return child;
    });
    await expect(testSyncTarget('claw', { syncConfig: config, execFile })).resolves.toMatchObject({ ok: true, targetId: 'claw' });
    expect(execFile.mock.calls[0][1]).toEqual(['-o', 'BatchMode=yes', '-o', expect.stringMatching(/^ConnectTimeout=/), 'claw', 'openclaw-usage', 'receive-sync']);
    expect(execFile.mock.results[0].value.writes[0]).toBe(JSON.stringify(SYNC_PROBE_ENVELOPE));
    await expect(testSyncTarget('unknown', { syncConfig: config, execFile })).rejects.toThrow(/allowlist|target/i);
  });
});
