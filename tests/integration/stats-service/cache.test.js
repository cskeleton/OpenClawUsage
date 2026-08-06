import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import {
  getStats,
  invalidateStatsCache,
  refreshStatsCache,
  resetStatsServiceForTests,
  __getMemoryState,
  __forceReleaseLockForTests,
} from '../../../stats-service.js';
import {
  getCacheFilePath,
  isCacheWritable,
  tryAcquireLock,
  releaseLock,
  writeDiskCacheAtomic,
  readDiskCache,
} from '../../../stats-cache-store.js';
import { parseSessionJsonlRaw } from '../../../aggregator.js';
import { STATS_SHAPE_VERSION } from '../../../stats-contribution.js';

/** 追加一条有效 usage 消息，使请求数 +1 */
function appendUsageLine(sessionPath) {
  appendFileSync(
    sessionPath,
    '\n' +
      JSON.stringify({
        type: 'message',
        timestamp: '2026-04-17T12:00:00.000Z',
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-4o',
          usage: {
            input: 11,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 18,
            cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
          },
        },
      })
  );
}

const disposables = [];

beforeEach(() => {
  resetStatsServiceForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  await __forceReleaseLockForTests();
  while (disposables.length) await disposables.pop()();
  resetStatsServiceForTests();
});

async function setupWorkspace(pricingUpdated = '2026-04-20T00:00:00.000Z', withSessions = true) {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  if (withSessions) {
    copyFileSync(
      fixturePath('sessions-synth', 'edge-matrix.jsonl'),
      join(ws.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
    );
  }
  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: pricingUpdated,
    pricing: {},
  });
  return ws;
}

describe('stats-service persistent cache', () => {
  it('cold start builds and writes disk cache', async () => {
    const ws = await setupWorkspace();
    const data = await getStats();
    expect(data.summary.totalRequests).toBeGreaterThan(0);
    expect(data.cache.state).toBe('fresh');
    expect(existsSync(getCacheFilePath())).toBe(true);
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    expect(disk.schemaVersion).toBe(1);
    expect(disk.files).toBeDefined();
    expect(disk.manifest).toBeDefined();
  });

  it('reuses disk cache after module reset without reparsing unchanged files', async () => {
    const ws = await setupWorkspace();
    await getStats();
    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');

    resetStatsServiceForTests();
    const data = await getStats();
    expect(data.cache.state).toBe('fresh');
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('incremental refresh only reparses changed file', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const sessionName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl';
    const path = join(ws.sessionsDir, sessionName);
    const original = readFileSync(path);
    writeFileSync(path, original + '\n');

    resetStatsServiceForTests();
    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');

    await refreshStatsCache();
    expect(parseSpy.mock.calls.length).toBe(1);
    parseSpy.mockRestore();
  });

  it('pricing change re-prices without reparsing files', async () => {
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

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const after = await getStats();
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    expect(after.summary.totalCost).not.toBe(costBefore);
    expect(after.cache.state).toBe('fresh');
  });

  it('returns stale and keeps old stats when session dir disappears', async () => {
    const ws = await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    const { rmSync } = await import('fs');
    rmSync(ws.sessionsDir, { recursive: true, force: true });

    const data = await getStats();
    expect(data.cache.state).toBe('stale');
    expect(data.summary.totalRequests).toBeGreaterThan(0);
  });

  it('full refresh reparses session file even when cache exists', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    await refreshStatsCache({ full: true });
    expect(parseSpy.mock.calls.length).toBe(1);
    parseSpy.mockRestore();
  });

  it('ignores corrupted disk cache and rebuilds', async () => {
    const ws = await setupWorkspace();
    await getStats();
    writeFileSync(getCacheFilePath(), '{not-json');
    resetStatsServiceForTests();

    const data = await getStats();
    expect(data.cache.state).toBe('fresh');
    expect(data.summary.totalRequests).toBeGreaterThan(0);
  });

  it('deduplicates concurrent refresh in same process', async () => {
    await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const sessionPath = join(process.env.OPENCLAW_CONFIG_DIR, 'agents/main/sessions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    writeFileSync(sessionPath, readFileSync(sessionPath) + '\n');

    const [a, b] = await Promise.all([refreshStatsCache(), refreshStatsCache()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(parseSpy.mock.calls.length).toBeLessThanOrEqual(2);
    parseSpy.mockRestore();
  });

  it('waitForRefresh returns fresh after background refresh completes', async () => {
    const ws = await setupWorkspace();
    await getStats();
    writeFileSync(
      join(ws.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      readFileSync(join(ws.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')) + '\n'
    );
    resetStatsServiceForTests();

    const stale = await getStats();
    expect(stale.cache.state).toBe('refreshing');

    const fresh = await getStats({ waitForRefresh: true });
    expect(fresh.cache.state).toBe('fresh');
  });

  it('full refresh is not swallowed by in-flight incremental', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const sessionName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl';
    const sessionPath = join(ws.sessionsDir, sessionName);
    writeFileSync(sessionPath, readFileSync(sessionPath) + '\n');

    const agg = await import('../../../aggregator.js');
    const original = agg.parseSessionJsonlRaw;
    let enteredParse = false;
    let releaseParse;
    const parseGate = new Promise((resolve) => {
      releaseParse = resolve;
    });
    const parseSpy = vi.spyOn(agg, 'parseSessionJsonlRaw').mockImplementation(async (...args) => {
      enteredParse = true;
      await parseGate;
      return original(...args);
    });

    const incremental = refreshStatsCache({ full: false });
    await vi.waitFor(() => {
      expect(enteredParse).toBe(true);
    });

    const full = refreshStatsCache({ full: true });
    releaseParse();
    await Promise.all([incremental, full]);

    // 增量解析变化文件 + 随后全量再解析 → 至少 2 次
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    parseSpy.mockRestore();
  });

  it('waiter adopts disk cache without reparsing when lock is held', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const sessionName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl';
    const sessionPath = join(ws.sessionsDir, sessionName);
    writeFileSync(sessionPath, readFileSync(sessionPath) + '\n');
    const diskBefore = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));

    const { statSync } = await import('fs');
    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const refreshPromise = refreshStatsCache({ full: false });

    // 模拟持锁进程已处理变更并写入后释放；若等待方误构建则会 parse
    await new Promise((r) => setTimeout(r, 50));
    const st = statSync(sessionPath);
    const bumped = {
      ...diskBefore,
      revision: (diskBefore.revision || 0) + 7,
      checkedAt: new Date().toISOString(),
      buildMode: 'incremental',
      manifest: {
        ...diskBefore.manifest,
        [sessionName]: { size: st.size, mtimeMs: st.mtimeMs },
      },
    };
    await writeDiskCacheAtomic(bumped);
    await releaseLock();

    const result = await refreshPromise;
    expect(result.ok).toBe(true);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(__getMemoryState().revision).toBe(bumped.revision);
    parseSpy.mockRestore();
  });

  it('waiter does not adopt stale disk snapshot when source advanced (full rebuild)', async () => {
    const ws = await setupWorkspace();
    const before = await getStats();
    const requestsBefore = before.summary.totalRequests;

    const sessionName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl';
    const sessionPath = join(ws.sessionsDir, sessionName);
    appendUsageLine(sessionPath);

    const diskStale = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    // 持锁方只回写「旧/不完整」快照：manifest 与统计仍落后于最新源
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
    expect(after.summary.totalRequests).toBeGreaterThan(requestsBefore);
  });

  it('waiter full rebuild is not satisfied by incremental disk snapshot', async () => {
    const ws = await setupWorkspace();
    await getStats();

    const sessionName = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl';
    const sessionPath = join(ws.sessionsDir, sessionName);
    const { statSync } = await import('fs');

    const diskBefore = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));

    // 磁盘已是「对齐当前 manifest」的增量结果，但对 full 请求不等价
    const st = statSync(sessionPath);
    await writeDiskCacheAtomic({
      ...diskBefore,
      revision: (diskBefore.revision || 0) + 3,
      buildMode: 'incremental',
      checkedAt: new Date().toISOString(),
      manifest: {
        ...diskBefore.manifest,
        [sessionName]: { size: st.size, mtimeMs: st.mtimeMs },
      },
    });
    await releaseLock();

    await refreshPromise;
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const diskAfter = await readDiskCache();
    expect(diskAfter.buildMode).toBe('full');
    parseSpy.mockRestore();
  });

  it('waiter full rebuild is not satisfied by a pre-existing full snapshot', async () => {
    await setupWorkspace();
    await getStats();

    const diskBefore = await readDiskCache();
    expect(diskBefore.buildMode).toBe('full');
    resetStatsServiceForTests();

    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const refreshPromise = refreshStatsCache({ full: true });
    await new Promise((r) => setTimeout(r, 50));

    // 模拟持锁进程失败或退出：释放锁，但没有发布本轮新快照。
    await releaseLock();
    await refreshPromise;

    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const diskAfter = await readDiskCache();
    expect(diskAfter.buildMode).toBe('full');
    expect(diskAfter.revision).toBeGreaterThan(diskBefore.revision);
    parseSpy.mockRestore();
  });

  it('waiter full rebuild adopts a newly published full snapshot', async () => {
    await setupWorkspace();
    await getStats();

    const diskBefore = await readDiskCache();
    resetStatsServiceForTests();

    const acquired = await tryAcquireLock();
    expect(acquired).toBe(true);

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
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
    expect(parseSpy).not.toHaveBeenCalled();
    expect(__getMemoryState().revision).toBe(published.revision);
    parseSpy.mockRestore();
  });

  it('cold-start incremental refresh uses disk manifest baseline (no full reparse)', async () => {
    await setupWorkspace();
    await getStats();
    resetStatsServiceForTests();

    // memory.manifest 为空对象，不得挡住磁盘 manifest 成为基线
    expect(Object.keys(__getMemoryState().manifest)).toHaveLength(0);

    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    await refreshStatsCache({ full: false });
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('disk cache hit reuses stats without remmerge when pricing unchanged', async () => {
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
    // 强制刷新路径应发布新 revision，即使源文件未变化
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

    // byDate 必须是 byDateModel 在模型维度上的边缘和
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

  it('remerges stale-shaped disk stats without reparsing JSONL', async () => {
    await setupWorkspace();
    await getStats();

    // 模拟旧版本快照：stats 缺少 session.byDateModel，且形状版本落后
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    disk.statsShapeVersion = STATS_SHAPE_VERSION - 1;
    for (const session of disk.stats.sessions) delete session.byDateModel;
    await writeDiskCacheAtomic(disk);

    resetStatsServiceForTests();
    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const data = await getStats();

    // 逐文件贡献未变，只需重新合并，不得重新解析 JSONL
    expect(parseSpy).not.toHaveBeenCalled();
    expect(data.sessions[0].byDateModel).toBeDefined();
    parseSpy.mockRestore();
  });

  it('remerges disk stats when statsShapeVersion field is absent', async () => {
    await setupWorkspace();
    await getStats();

    // 本次改动之前写入的快照根本没有 statsShapeVersion 字段
    const disk = JSON.parse(readFileSync(getCacheFilePath(), 'utf-8'));
    delete disk.statsShapeVersion;
    for (const session of disk.stats.sessions) delete session.byDateModel;
    await writeDiskCacheAtomic(disk);

    resetStatsServiceForTests();
    const parseSpy = vi.spyOn(await import('../../../aggregator.js'), 'parseSessionJsonlRaw');
    const data = await getStats();

    expect(parseSpy).not.toHaveBeenCalled();
    expect(data.sessions[0].byDateModel).toBeDefined();
    parseSpy.mockRestore();
  });
});

describe('stats-cache-store writability probe', () => {
  it('concurrent isCacheWritable probes stay true on a writable directory', async () => {
    const ws = await setupWorkspace();
    // 确保缓存目录已创建
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
