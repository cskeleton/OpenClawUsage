import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { dirname as pathDirname } from 'path';
import { join } from 'path';
import { spawn } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  getStats,
  getLocalContributionCache,
  invalidateStatsCache,
  refreshStatsCache,
  resetStatsServiceForTests,
  __getMemoryState,
  __forceReleaseLockForTests,
} from '../../../stats-service.js';
import {
  getCacheFilePath,
  getLegacyCacheFilePath,
  isCacheWritable,
  tryAcquireLock,
  releaseLock,
  writeDiskCacheAtomic,
  readDiskCache,
} from '../../../stats-cache-store.js';
import { STATS_SHAPE_VERSION } from '../../../stats-contribution.js';

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function usageEventJson({ seq = 1, provider = 'openai', model = 'gpt-4o', ts = '2026-04-17T12:00:00.000Z', input = 11, output = 7 } = {}) {
  return JSON.stringify({
    type: 'message',
    id: `evt-${seq}`,
    timestamp: ts,
    message: {
      role: 'assistant',
      provider,
      model,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
      },
    },
  });
}

/** 在工作区数据库中追加一条 usage 事件（请求数 +1） */
function appendUsageEvent(ws, { seq = 1 } = {}) {
  const db = new DatabaseSync(ws.dbPath);
  try {
    db.prepare(
      'INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)'
    ).run(SESSION_ID, seq, usageEventJson({ seq }), Date.parse('2026-04-17T12:00:00.000Z') + seq);
    db.prepare('UPDATE session_windows SET updated_at = updated_at + 1, transcript_updated_at = transcript_updated_at + 1 WHERE session_id = ?').run(SESSION_ID);
  } finally {
    db.close();
  }
}

/** 初始化一个带单会话两事件的数据库 */
function seedDb(ws) {
  ws.execSql(`
    INSERT INTO transcript_events VALUES
      ('${SESSION_ID}', 1, '${usageEventJson({ seq: 1 })}', 1782801600000),
      ('${SESSION_ID}', 2, '${usageEventJson({ seq: 2, input: 20, output: 5 })}', 1782801600100);
    INSERT INTO session_windows VALUES
      ('${SESSION_ID}', 'agent:main:main', 'done', 1782801600000, 1782801600100, 1782801600100);
  `);
}

const disposables = [];
/** 最近一个 setupWorkspace 的工作区引用（部分用例在 getStats 后再注入事件） */
let lastWs = null;

beforeEach(() => {
  resetStatsServiceForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  await __forceReleaseLockForTests();
  while (disposables.length) await disposables.pop()();
  lastWs = null;
  resetStatsServiceForTests();
});

async function setupWorkspace(pricingUpdated = '2026-04-20T00:00:00.000Z', withSessions = true) {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  lastWs = ws;
  if (withSessions) {
    seedDb(ws);
  }
  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: pricingUpdated,
    pricing: {},
  });
  return ws;
}

/** spy 在 sqlite-source 的贡献构建入口上 */
async function spyBuild() {
  const sqliteSource = await import('../../../sqlite-source.js');
  return vi.spyOn(sqliteSource, 'buildSqliteContributions');
}

describe('stats-service persistent cache (SQLite source)', () => {
  it('cold start builds and writes disk cache', async () => {
    const ws = await setupWorkspace();
    const data = await getStats();
    expect(data.summary.totalRequests).toBe(2);
    expect(data.cache.state).toBe('fresh');
    expect(existsSync(getCacheFilePath())).toBe(true);
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    expect(disk.schemaVersion).toBe(3);
    expect(disk.files).toBeDefined();
    expect(disk.manifest.sessions).toBeDefined();
    expect(disk.manifest.archives).toBeDefined();
    expect(Object.keys(disk.files)).toEqual([`sqlite:${SESSION_ID}`]);
  });

  it('refuses a local contribution export after an existing-cache refresh fails', async () => {
    await setupWorkspace();
    await expect(getLocalContributionCache()).resolves.toMatchObject({ cacheState: 'fresh' });
    appendUsageEvent(lastWs, { seq: 3 });
    const sqliteSource = await import('../../../sqlite-source.js');
    const spy = vi.spyOn(sqliteSource, 'buildSqliteContributions').mockRejectedValue(new Error('injected parse failure'));
    try {
      await expect(getLocalContributionCache()).rejects.toThrow(/not fresh/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('reuses disk cache after module reset without reparsing unchanged sessions', async () => {
    await setupWorkspace();
    await getStats();
    const spy = await spyBuild();

    resetStatsServiceForTests();
    const data = await getStats();
    expect(data.cache.state).toBe('fresh');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('incremental refresh only reparses changed session', async () => {
    const ws = await setupWorkspace();
    await getStats();

    appendUsageEvent(ws, { seq: 3 });
    resetStatsServiceForTests();

    const spy = await spyBuild();
    await refreshStatsCache();
    expect(spy.mock.calls.length).toBe(1);
    // 只重解析被变更的会话
    const [sessionDiff] = spy.mock.calls[0];
    expect(sessionDiff.added).toEqual([]);
    expect(sessionDiff.changed).toEqual([SESSION_ID]);
    spy.mockRestore();
  });

  it('pricing change re-prices without reparsing sessions', async () => {
    const ws = await setupWorkspace('2026-04-20T00:00:00.000Z');
    const before = await getStats();
    const costBefore = before.summary.totalCost;

    await ws.writePricingConfig({
      version: '1.0',
      enabled: true,
      updated: '2026-04-21T00:00:00.000Z',
      pricing: {
        'openai/gpt-4o': { input: 999, output: 999 },
        'anthropic/claude-*': { matchType: 'wildcard', input: 999, output: 999 },
      },
    });
    invalidateStatsCache();

    const spy = await spyBuild();
    const after = await getStats();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(after.summary.totalCost).not.toBe(costBefore);
    expect(after.cache.state).toBe('fresh');
  });

  it('returns stale and keeps old stats when database disappears', async () => {
    const ws = await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    unlinkSync(ws.dbPath);

    const data = await getStats();
    expect(data.cache.state).toBe('stale');
    expect(data.summary.totalRequests).toBe(2);
  });

  it('full refresh reparses sessions even when cache exists', async () => {
    await setupWorkspace();
    await getStats();

    const spy = await spyBuild();
    await refreshStatsCache({ full: true });
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it('ignores corrupted disk cache and rebuilds', async () => {
    await setupWorkspace();
    await getStats();
    writeFileSync(getCacheFilePath(), '{not-json');
    resetStatsServiceForTests();

    const data = await getStats();
    expect(data.cache.state).toBe('fresh');
    expect(data.summary.totalRequests).toBe(2);
  });

  it('deduplicates concurrent refresh in same process', async () => {
    await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    const spy = await spyBuild();
    appendUsageEvent(lastWs, { seq: 3 });

    const [a, b] = await Promise.all([refreshStatsCache(), refreshStatsCache()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });

  it('waitForRefresh returns fresh after background refresh completes', async () => {
    const ws = await setupWorkspace();
    await getStats();
    appendUsageEvent(ws, { seq: 3 });
    resetStatsServiceForTests();

    const stale = await getStats();
    expect(stale.cache.state).toBe('refreshing');

    const fresh = await getStats({ waitForRefresh: true });
    expect(fresh.cache.state).toBe('fresh');
    expect(fresh.summary.totalRequests).toBe(3);
  });

  it('full refresh is not swallowed by in-flight incremental', async () => {
    const ws = await setupWorkspace();
    await getStats();
    appendUsageEvent(ws, { seq: 3 });

    const sqliteSource = await import('../../../sqlite-source.js');
    const original = sqliteSource.buildSqliteContributions;
    let enteredBuild = false;
    let releaseBuild;
    const gate = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    const spy = vi.spyOn(sqliteSource, 'buildSqliteContributions').mockImplementation(async (...args) => {
      enteredBuild = true;
      await gate;
      return original(...args);
    });

    const incremental = refreshStatsCache({ full: false });
    await vi.waitFor(() => {
      expect(enteredBuild).toBe(true);
    });

    const full = refreshStatsCache({ full: true });
    releaseBuild();
    await Promise.all([incremental, full]);

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });

  it('waiter adopts disk cache without reparsing when lock is held', async () => {
    const ws = await setupWorkspace();
    await getStats();
    appendUsageEvent(ws, { seq: 3 });

    const diskBefore = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const spy = await spyBuild();
    const refreshPromise = refreshStatsCache({ full: false });

    // 模拟持锁进程已处理变更并写入后释放；若等待方误构建则会 parse
    await new Promise((r) => setTimeout(r, 50));
    const manifest = await import('../../../sqlite-source.js').then((m) => m.scanSqliteManifest());
    const bumped = {
      ...diskBefore,
      revision: (diskBefore.revision || 0) + 7,
      checkedAt: new Date().toISOString(),
      buildMode: 'incremental',
      manifest,
    };
    await writeDiskCacheAtomic(bumped);
    await releaseLock();

    const result = await refreshPromise;
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(__getMemoryState().revision).toBe(bumped.revision);
    spy.mockRestore();
  });

  it('waiter does not adopt stale disk snapshot when source advanced (full rebuild)', async () => {
    const ws = await setupWorkspace();
    const before = await getStats();
    const requestsBefore = before.summary.totalRequests;

    appendUsageEvent(ws, { seq: 3 });

    const diskStale = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));
    await writeDiskCacheAtomic({
      ...diskStale,
      revision: (diskStale.revision || 0) + 1,
      buildMode: 'incremental',
      checkedAt: new Date().toISOString(),
    });
    await releaseLock();

    const result = await refreshPromise;
    expect(result.ok).toBe(true);
    const after = await getStats();
    expect(after.summary.totalRequests).toBe(requestsBefore + 1);
  });

  it('waiter full rebuild is not satisfied by incremental disk snapshot', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const diskBefore = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const spy = await spyBuild();
    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));

    const manifest = await import('../../../sqlite-source.js').then((m) => m.scanSqliteManifest());
    await writeDiskCacheAtomic({
      ...diskBefore,
      revision: (diskBefore.revision || 0) + 3,
      buildMode: 'incremental',
      checkedAt: new Date().toISOString(),
      manifest,
    });
    await releaseLock();

    await refreshPromise;
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const diskAfter = await readDiskCache();
    expect(diskAfter.buildMode).toBe('full');
    spy.mockRestore();
  });

  it('waiter full rebuild is not satisfied by a pre-existing full snapshot', async () => {
    await setupWorkspace();
    await getStats();

    const diskBefore = await readDiskCache();
    expect(diskBefore.buildMode).toBe('full');
    resetStatsServiceForTests();

    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const spy = await spyBuild();
    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));

    await releaseLock();
    await refreshPromise;

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const diskAfter = await readDiskCache();
    expect(diskAfter.buildMode).toBe('full');
    expect(diskAfter.revision).toBeGreaterThan(diskBefore.revision);
    spy.mockRestore();
  });

  it('waiter full rebuild adopts a newly published full snapshot', async () => {
    await setupWorkspace();
    await getStats();

    const diskBefore = await readDiskCache();
    resetStatsServiceForTests();

    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const spy = await spyBuild();
    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));

    const published = {
      ...diskBefore,
      revision: diskBefore.revision + 1,
      buildMode: 'full',
      checkedAt: new Date().toISOString(),
    };
    await writeDiskCacheAtomic(published);
    await releaseLock();

    await refreshPromise;
    expect(spy).not.toHaveBeenCalled();
    expect(__getMemoryState().revision).toBe(published.revision);
    spy.mockRestore();
  });

  it('cold-start incremental refresh uses disk manifest baseline (no full reparse)', async () => {
    await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    expect(Object.keys(__getMemoryState().manifest)).toHaveLength(0);

    const spy = await spyBuild();
    await refreshStatsCache({ full: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('disk cache hit reuses stats without remerge when pricing unchanged', async () => {
    await setupWorkspace();
    await getStats();
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const generatedAt = disk.stats.generatedAt;
    const revision = disk.revision;

    resetStatsServiceForTests();
    const data = await getStats();
    expect(data.generatedAt).toBe(generatedAt);
    expect(data.cache.revision).toBe(revision);
    expect(data.cache.state).toBe('fresh');
  });

  it('forceFresh triggers refresh even when cache is already fresh', async () => {
    await setupWorkspace();
    const first = await getStats();
    expect(first.cache.state).toBe('fresh');
    const revisionBefore = first.cache.revision;

    const second = await getStats({ forceFresh: true });
    expect(second.cache.state).toBe('fresh');
    expect(second.cache.revision).toBeGreaterThan(revisionBefore);
  });

  it('records statsShapeVersion in disk snapshot', async () => {
    await setupWorkspace();
    await getStats();
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    expect(disk.statsShapeVersion).toBe(STATS_SHAPE_VERSION);
  });

  it('sessions carry byDateModel cross table', async () => {
    await setupWorkspace();
    const data = await getStats();

    const session = data.sessions[0];
    expect(session.byDateModel).toBeDefined();

    for (const [date, keyMap] of Object.entries(session.byDateModel)) {
      const summed = Object.values(keyMap).reduce(
        (acc, b) => ({
          totalTokens: acc.totalTokens + b.totalTokens,
          requests: acc.requests + b.requests,
        }),
        { totalTokens: 0, requests: 0 }
      );
      expect(summed.totalTokens).toBe(session.byDate[date].totalTokens);
      expect(summed.requests).toBe(session.byDate[date].requests);
    }
  });

  it('remerges stale-shaped disk stats without reparsing sessions', async () => {
    await setupWorkspace();
    await getStats();

    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    disk.statsShapeVersion = STATS_SHAPE_VERSION - 1;
    for (const session of disk.stats.sessions) delete session.byDateModel;
    await writeDiskCacheAtomic(disk);

    resetStatsServiceForTests();
    const spy = await spyBuild();
    const data = await getStats();

    expect(spy).not.toHaveBeenCalled();
    expect(data.sessions[0].byDateModel).toBeDefined();
    spy.mockRestore();
  });

  it('remerges disk stats when statsShapeVersion field is absent', async () => {
    await setupWorkspace();
    await getStats();

    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    delete disk.statsShapeVersion;
    for (const session of disk.stats.sessions) delete session.byDateModel;
    await writeDiskCacheAtomic(disk);

    resetStatsServiceForTests();
    const spy = await spyBuild();
    const data = await getStats();

    expect(spy).not.toHaveBeenCalled();
    expect(data.sessions[0].byDateModel).toBeDefined();
    spy.mockRestore();
  });
});

describe('v1 → v2 frozen history migration', () => {
  it('freezes recorded v1 contributions as legacy:* keys without double counting', async () => {
    const ws = await setupWorkspace();
    // 额外准备 v1 缓存：一个有记录的 JSONL 时代会话 + 一个 0 记录文件 + 一个与 SQLite 重合的会话
    const v1 = {
      schemaVersion: 1,
      sourceId: 'old-source',
      pricingFingerprint: null,
      manifest: {},
      files: {
        '11111111-1111-1111-1111-111111111111.jsonl.reset.2026-08-01T00-00-00.000Z': {
          session: { id: '11111111-1111-1111-1111-111111111111', status: 'reset', archivedAt: '2026-08-01T00:00:00.000Z' },
          buckets: [{
            date: '2026-07-31', provider: 'openai', model: 'gpt-4o',
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
            openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            requests: 1,
          }],
          hasRecords: true,
          firstTimestamp: '2026-07-31T10:00:00.000Z',
          lastTimestamp: '2026-07-31T10:00:00.000Z',
        },
        '22222222-2222-2222-2222-222222222222.jsonl': {
          session: { id: '22222222-2222-2222-2222-222222222222', status: 'active', archivedAt: null },
          buckets: [],
          hasRecords: false,
          firstTimestamp: null,
          lastTimestamp: null,
        },
        [`${SESSION_ID}.jsonl`]: {
          // 与 SQLite 活跃会话同 id：必须被排除，防止双计
          session: { id: SESSION_ID, status: 'active', archivedAt: null },
          buckets: [{
            date: '2026-04-17', provider: 'openai', model: 'gpt-4o',
            usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998 },
            openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            requests: 5,
          }],
          hasRecords: true,
          firstTimestamp: '2026-04-17T00:00:00.000Z',
          lastTimestamp: '2026-04-17T12:00:00.000Z',
        },
      },
      stats: null,
      revision: 260,
      buildMode: 'incremental',
      generatedAt: '2026-09-03T06:28:52.914Z',
      checkedAt: '2026-09-03T06:28:52.914Z',
    };
    mkdirSync(pathDirname(getLegacyCacheFilePath()), { recursive: true });
    writeFileSync(getLegacyCacheFilePath(), JSON.stringify(v1));

    const data = await getStats();
    // 2 条 SQLite 事件 + 1 条冻结历史；同 id 的 v1 贡献被排除
    expect(data.summary.totalRequests).toBe(3);
    expect(data.summary.totalSessions).toBe(2);

    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const legacyKeys = Object.keys(disk.files).filter((k) => k.startsWith('legacy:'));
    expect(legacyKeys).toHaveLength(1);
    expect(disk.files[legacyKeys[0]].identity).toEqual({ frozen: true });

    // 增量刷新不触碰冻结贡献
    appendUsageEvent(ws, { seq: 3 });
    resetStatsServiceForTests();
    const spy = await spyBuild();
    await refreshStatsCache();
    const disk2 = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    expect(Object.keys(disk2.files).filter((k) => k.startsWith('legacy:'))).toHaveLength(1);
    expect(disk2.summary ? disk2.summary : disk2.stats.summary.totalRequests).toBeTruthy();
    spy.mockRestore();
  });

  it('skips migration when no v1 cache exists', async () => {
    await setupWorkspace();
    const data = await getStats();
    expect(data.summary.totalRequests).toBe(2);
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    expect(Object.keys(disk.files).filter((k) => k.startsWith('legacy:'))).toHaveLength(0);
  });
});

describe('stats-cache-store writability probe', () => {
  it('concurrent isCacheWritable probes stay true on a writable directory', async () => {
    const ws = await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => isCacheWritable())
    );
    expect(results.every((ok) => ok === true)).toBe(true);
    expect(ws.configDir).toBeTruthy();
  });
});

describe('stats-service cross-process lock', () => {
  it('second process reads disk after lock holder finishes', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const child = spawn(process.execPath, [
      '-e',
      `
        process.env.OPENCLAW_CONFIG_DIR = '${ws.configDir}';
        process.env.OPENCLAW_DIR = '${ws.workspaceDir}';
        const { refreshStatsCache } = await import('./stats-service.js');
        await refreshStatsCache();
        console.log('child-done');
      `,
    ], { cwd: join(import.meta.dirname, '../../..'), stdio: 'pipe' });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))));
    });

    resetStatsServiceForTests();
    const data = await getStats();
    expect(data.cache.state).toBe('fresh');
  }, 30_000);
});
