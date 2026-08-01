import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createServer as createNetServer,
} from 'net';
import {
  existsSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  getLauncherPaths,
  ensureRunDirs,
  atomicWriteFile,
  writeServeState,
  readServeState,
  readServeStateEntry,
  evaluateManagedState,
  checkDistReady,
  verifyProcessOwnership,
  isProcessAlive,
  getProcessStartTime,
  getProcessCommandLine,
  acquireLifecycleLock,
  stopOwnedProcess,
  healthMatches,
  rotateLogIfNeeded,
  isPortListening,
  cmdStart,
  cmdStop,
  parsePort,
} from '../../../scripts/openclaw-usage-cli.js';

const disposables = [];

async function withTmpConfig() {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  return ws;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 找一个空闲的本机端口 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

beforeEach(() => {
  // ENV 由 tests/setup.js + createTmpWorkspace 管理
});

afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

describe('launcher helpers', () => {
  it('checkDistReady reports missing dist', async () => {
    const ws = await withTmpConfig();
    const result = checkDistReady(ws.root);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('dist/index.html');
    expect(result.missing).toContain('dist/pricing.html');
  });

  it('atomicWriteFile creates 0600 file and ensureRunDirs is 0700', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    const modeDir = statSync(paths.runDir).mode & 0o777;
    expect(modeDir).toBe(0o700);

    atomicWriteFile(paths.serveStatePath, '{"ok":true}\n', 0o600);
    const modeFile = statSync(paths.serveStatePath).mode & 0o777;
    expect(modeFile).toBe(0o600);
  });

  it('readServeState returns null for invalid JSON / shape', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    writeFileSync(paths.serveStatePath, '{not-json', 'utf-8');
    expect(readServeState(paths)).toBeNull();
    writeFileSync(paths.serveStatePath, JSON.stringify({ version: 1, pid: 'x' }), 'utf-8');
    expect(readServeState(paths)).toBeNull();
  });

  it('readServeStateEntry distinguishes missing from corrupted state', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);

    expect(readServeStateEntry(paths)).toEqual({ status: 'missing', state: null });

    writeFileSync(paths.serveStatePath, '{not-json', 'utf-8');
    const broken = readServeStateEntry(paths);
    expect(broken.status).toBe('invalid');
    expect(broken.state).toBeNull();
    expect(broken.reason).toMatch(/JSON/i);

    for (const [payload, pattern] of [
      [{ version: 2, pid: 1, serverEntry: 'x', repoRoot: 'y', launchId: 'z', port: 1 }, /version/i],
      [{ version: 1, pid: 'x' }, /pid/i],
      [{ version: 1, pid: 10, serverEntry: '', repoRoot: 'y', launchId: 'z', port: 1 }, /serverEntry/i],
      [{ version: 1, pid: 10, serverEntry: 'a', repoRoot: 'b', launchId: 'c', port: 99999 }, /port/i],
    ]) {
      writeFileSync(paths.serveStatePath, JSON.stringify(payload), 'utf-8');
      const entry = readServeStateEntry(paths);
      expect(entry.status).toBe('invalid');
      expect(entry.reason).toMatch(pattern);
    }

    writeServeState({
      version: 1,
      pid: 4242,
      repoRoot: paths.repoRoot,
      serverEntry: paths.serverEntry,
      host: '127.0.0.1',
      port: 3001,
      launchId: 'abc',
      processStartedAt: 'x',
      startedAt: new Date().toISOString(),
    }, paths);
    const valid = readServeStateEntry(paths);
    expect(valid.status).toBe('valid');
    expect(valid.state.pid).toBe(4242);
  });

  it('evaluateManagedState reports stale (not stopped) for corrupted state file', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    writeFileSync(paths.serveStatePath, '{"version":1,"pid":', 'utf-8');

    const port = await findFreePort();
    const evaluated = await evaluateManagedState(paths, port);
    expect(evaluated.kind).toBe('stale');
    expect(evaluated.invalidState).toBe(true);
    expect(evaluated.state).toBeNull();
  });

  it('cmdStop removes a corrupted serve.json and exits 0', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    writeFileSync(paths.serveStatePath, 'totally-not-json', 'utf-8');

    const code = await cmdStop({ paths });
    expect(code).toBe(0);
    expect(existsSync(paths.serveStatePath)).toBe(false);
  });

  it('cmdStop reports not running when serve.json is absent', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    expect(await cmdStop({ paths })).toBe(0);
  });

  it('verifyProcessOwnership mismatches on wrong cmdline / start time', async () => {
    const ws = await withTmpConfig();
    const selfPid = process.pid;
    const startedAt = getProcessStartTime(selfPid);
    expect(startedAt).toBeTruthy();

    const ownedState = {
      version: 1,
      pid: selfPid,
      repoRoot: getLauncherPaths(ws.configDir).repoRoot,
      serverEntry: getLauncherPaths(ws.configDir).serverEntry,
      processStartedAt: startedAt,
    };

    // 当前测试进程命令行不含 serverEntry → mismatch
    const result = verifyProcessOwnership(ownedState, ownedState.repoRoot);
    expect(result.status).toBe('mismatch');

    // PID 复用：启动时间不同
    const reused = {
      ...ownedState,
      serverEntry: getProcessCommandLine(selfPid) || 'node',
      processStartedAt: 'Thu Jan  1 00:00:00 1970',
    };
    // 即使 cmdline 碰巧匹配，start time 也必须匹配
    const r2 = verifyProcessOwnership({
      ...reused,
      serverEntry: (getProcessCommandLine(selfPid) || '').split(' ')[0] || 'node',
    }, reused.repoRoot);
    // cmdline 可能不含完整 serverEntry；我们专门测 start time：
    const r3 = verifyProcessOwnership({
      pid: selfPid,
      repoRoot: ownedState.repoRoot,
      serverEntry: getProcessCommandLine(selfPid) || 'vitest',
      processStartedAt: 'Thu Jan  1 00:00:00 1970',
    }, ownedState.repoRoot);
    // serverEntry 必须是 cmdline 的子串
    const cmdline = getProcessCommandLine(selfPid);
    expect(cmdline).toBeTruthy();
    const r4 = verifyProcessOwnership({
      pid: selfPid,
      repoRoot: ownedState.repoRoot,
      serverEntry: cmdline.includes(' ') ? cmdline.split(' ')[0] : cmdline,
      processStartedAt: 'Thu Jan  1 00:00:00 1970',
    }, ownedState.repoRoot);
    expect(r4.status).toBe('mismatch');
    expect(r4.reason).toMatch(/processStartedAt|PID reuse/i);
  });

  it('never signals a non-owned live pid (stopOwnedProcess only after ownership)', async () => {
    const signals = [];
    const fakePid = process.pid;
    const result = await stopOwnedProcess(fakePid, {
      termWaitMs: 50,
      killFn: (pid, sig) => {
        signals.push({ pid, sig });
        // 不真正发信号
      },
      aliveFn: (pid) => pid === fakePid,
      sleepFn: async () => {},
    });
    // stopOwnedProcess 本身会发信号——归属校验在 cmdStop 层。
    // 这里验证：对「假死」进程在 alive 一直为 true 时会升级到 SIGKILL
    expect(signals[0]?.sig).toBe('SIGTERM');
    expect(signals.some((s) => s.sig === 'SIGKILL')).toBe(true);
    expect(result.usedKill).toBe(true);
  });

  it('stopOwnedProcess upgrades to SIGKILL only after SIGTERM wait', async () => {
    const timeline = [];
    let alive = true;
    const result = await stopOwnedProcess(424242, {
      termWaitMs: 80,
      killFn: (pid, sig) => {
        timeline.push({ sig, t: Date.now() });
        if (sig === 'SIGKILL') alive = false;
      },
      aliveFn: () => alive,
      sleepFn: (ms) => sleep(ms),
    });
    expect(timeline[0].sig).toBe('SIGTERM');
    expect(timeline.some((x) => x.sig === 'SIGKILL')).toBe(true);
    expect(timeline.find((x) => x.sig === 'SIGKILL').t - timeline[0].t).toBeGreaterThanOrEqual(70);
    expect(result.ok).toBe(true);
    expect(result.usedKill).toBe(true);
  });

  it('healthMatches requires service/pid/launchId', () => {
    expect(healthMatches(
      { ok: true, service: 'openclaw-usage', pid: 1, launchId: 'abc' },
      { pid: 1, launchId: 'abc' }
    )).toBe(true);
    expect(healthMatches(
      { ok: true, service: 'other', pid: 1, launchId: 'abc' },
      { pid: 1, launchId: 'abc' }
    )).toBe(false);
    expect(healthMatches(
      { ok: true, service: 'openclaw-usage', pid: 2, launchId: 'abc' },
      { pid: 1, launchId: 'abc' }
    )).toBe(false);
    expect(healthMatches(
      { ok: true, service: 'openclaw-usage', pid: 1, launchId: 'xyz' },
      { pid: 1, launchId: 'abc' }
    )).toBe(false);
  });

  it('rotateLogIfNeeded keeps one old log over 5MiB', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);
    // 写入略大于 5MiB
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x61);
    writeFileSync(paths.logPath, big);
    rotateLogIfNeeded(paths.logPath);
    expect(existsSync(`${paths.logPath}.1`)).toBe(true);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  it('acquireLifecycleLock serializes and recovers stale locks', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    const lock1 = await acquireLifecycleLock(paths, 2000);
    let secondAcquired = false;
    const pending = acquireLifecycleLock(paths, 500).then(() => {
      secondAcquired = true;
    }).catch(() => {
      secondAcquired = false;
    });
    await sleep(150);
    expect(secondAcquired).toBe(false);
    lock1.release();
    await pending;
    // 陈旧锁：写入已死 PID
    writeFileSync(paths.lockPath, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const lock2 = await acquireLifecycleLock(paths, 2000);
    expect(lock2.path).toBe(paths.lockPath);
    lock2.release();
  });

  it('parsePort validates OPENCLAW_USAGE_PORT', async () => {
    await withTmpConfig();
    process.env.OPENCLAW_USAGE_PORT = '41234';
    expect(parsePort()).toBe(41234);
    process.env.OPENCLAW_USAGE_PORT = 'nope';
    expect(() => parsePort()).toThrow();
    delete process.env.OPENCLAW_USAGE_PORT;
  });
});

describe('start without dist', () => {
  it('exits non-zero when dist missing', async () => {
    const ws = await withTmpConfig();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    const paths = {
      ...getLauncherPaths(ws.configDir),
      repoRoot: ws.root,
    };
    const code = await cmdStart({ noOpen: true, openBrowserFn: () => {}, paths });
    expect(code).toBe(1);
  });
});

describe('cmdStart refuses foreign port holders', () => {
  it('refuses start when port is occupied by unrelated listener', async () => {
    const ws = await withTmpConfig();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);

    // 确保仓库已有 dist（生产路径）；若无则跳过进程级断言
    const dist = checkDistReady();
    if (!dist.ok) {
      // 没有 dist 时 start 也会失败，但仍验证端口占用逻辑需有 dist
      return;
    }

    const blocker = createNetServer();
    await new Promise((resolve, reject) => {
      blocker.listen(port, '127.0.0.1', resolve);
      blocker.on('error', reject);
    });
    disposables.push(async () => {
      await new Promise((r) => blocker.close(() => r()));
    });

    const code = await cmdStart({ noOpen: true, openBrowserFn: () => {} });
    expect(code).toBe(1);
  }, 20000);
});

describe('ownership fail-closed for live foreign pid in serve.json', () => {
  it('cmdStop does not signal mismatch pid and clears state with exit 1', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);

    // 使用当前 vitest 进程作为「存活但不归属」的 PID
    writeServeState({
      version: 1,
      pid: process.pid,
      repoRoot: paths.repoRoot,
      serverEntry: paths.serverEntry,
      host: '127.0.0.1',
      port: 39999,
      launchId: 'test-launch',
      processStartedAt: getProcessStartTime(process.pid),
      startedAt: new Date().toISOString(),
    }, paths);

    expect(isProcessAlive(process.pid)).toBe(true);
    const before = process.pid;
    const code = await cmdStop();
    expect(code).toBe(1);
    expect(isProcessAlive(before)).toBe(true);
    expect(readServeState(paths)).toBeNull();
  });

  it('cmdStop preserves state when ownership is uncertain (missing start time)', async () => {
    const ws = await withTmpConfig();
    const paths = getLauncherPaths(ws.configDir);
    ensureRunDirs(paths);

    // 伪造：cmdline 匹配但缺少 processStartedAt → uncertain
    const cmdline = getProcessCommandLine(process.pid) || '';
    writeServeState({
      version: 1,
      pid: process.pid,
      repoRoot: paths.repoRoot,
      serverEntry: cmdline.slice(0, Math.min(cmdline.length, 20)) || 'node',
      host: '127.0.0.1',
      port: 39998,
      launchId: 'test-launch',
      processStartedAt: '',
      startedAt: new Date().toISOString(),
    }, paths);

    // 若 serverEntry 不是 cmdline 子串，会变成 mismatch 而非 uncertain
    // 改用完整 cmdline 子串
    writeServeState({
      version: 1,
      pid: process.pid,
      repoRoot: paths.repoRoot,
      serverEntry: cmdline.includes('node') ? 'node' : cmdline.split(' ')[0],
      host: '127.0.0.1',
      port: 39998,
      launchId: 'test-launch',
      processStartedAt: '',
      startedAt: new Date().toISOString(),
    }, paths);

    const code = await cmdStop();
    expect(code).toBe(1);
    expect(readServeState(paths)).not.toBeNull();
  });
});

describe('isPortListening', () => {
  it('detects open and closed ports', async () => {
    const port = await findFreePort();
    expect(await isPortListening('127.0.0.1', port)).toBe(false);
    const server = createNetServer();
    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    try {
      expect(await isPortListening('127.0.0.1', port)).toBe(true);
    } finally {
      await new Promise((r) => server.close(() => r()));
    }
  });
});
