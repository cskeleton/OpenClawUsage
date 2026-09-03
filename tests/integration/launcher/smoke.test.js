import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createServer as createNetServer } from 'net';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import {
  getLauncherPaths,
  cmdStart,
  cmdStop,
  readServeState,
  isProcessAlive,
  isPortListening,
  checkDistReady,
} from '../../../scripts/openclaw-usage-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const CLI = join(REPO_ROOT, 'scripts/openclaw-usage-cli.js');

const disposables = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function prepareFixtureWorkspace() {
  const ws = await createTmpWorkspace();
  disposables.push(async () => {
    // 先尽量停掉可能残留的受管进程
    try {
      process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
      await cmdStop();
    } catch {
      // ignore
    }
    await ws.cleanup();
  });

  ws.copyFixtureDb(fixturePath('db', 'openclaw-agent.sqlite'));
  ws.writeModelsJson(JSON.parse(readFileSync(fixturePath('models', 'models.real.json'), 'utf-8')));
  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: new Date().toISOString(),
    pricing: {},
  });
  return ws;
}

beforeAll(() => {
  // 确保双页面 dist 存在
  if (!checkDistReady(REPO_ROOT).ok) {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }
  expect(checkDistReady(REPO_ROOT).ok).toBe(true);
  expect(existsSync(join(REPO_ROOT, 'dist', 'index.html'))).toBe(true);
  expect(existsSync(join(REPO_ROOT, 'dist', 'pricing.html'))).toBe(true);
});

afterEach(async () => {
  while (disposables.length) await disposables.pop()();
  delete process.env.OPENCLAW_USAGE_PORT;
});

describe('launcher smoke (real child process)', () => {
  it('start → pages/api → stop → restart reuses stats cache', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
    process.env.OPENCLAW_DIR = ws.workspaceDir;

    const paths = getLauncherPaths(ws.configDir);

    const startCode = await cmdStart({ noOpen: true, openBrowserFn: () => {} });
    expect(startCode).toBe(0);

    const state = readServeState(paths);
    expect(state).toBeTruthy();
    expect(isProcessAlive(state.pid)).toBe(true);

    // CLI 返回后后台进程仍存活
    await sleep(200);
    expect(isProcessAlive(state.pid)).toBe(true);

    const base = `http://127.0.0.1:${port}`;

    const dash = await fetch(`${base}/`);
    expect(dash.status).toBe(200);
    const dashHtml = await dash.text();
    expect(dashHtml).toMatch(/html/i);
    expect(dashHtml).not.toContain('/src/main.js');

    const pricing = await fetch(`${base}/pricing.html`);
    expect(pricing.status).toBe(200);
    expect(await pricing.text()).toMatch(/html/i);

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const healthJson = await health.json();
    expect(healthJson.service).toBe('openclaw-usage');
    expect(healthJson.pid).toBe(state.pid);
    expect(healthJson.launchId).toBe(state.launchId);

    // 禁止暴露源码路径
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/server.js`)).status).toBe(404);

    const stats1 = await (await fetch(`${base}/api/stats?fresh=1`)).json();
    expect(stats1.summary).toBeDefined();
    expect(stats1.cache).toBeDefined();
    const revision1 = stats1.cache.revision;
    const generatedAt1 = stats1.generatedAt;
    expect(typeof revision1).toBe('number');
    expect(typeof generatedAt1).toBe('string');
    expect(existsSync(paths.statsCachePath)).toBe(true);

    const stopCode = await cmdStop();
    expect(stopCode).toBe(0);
    expect(isProcessAlive(state.pid)).toBe(false);
    expect(await isPortListening('127.0.0.1', port)).toBe(false);
    expect(readServeState(paths)).toBeNull();
    // stop 不得删除统计缓存
    expect(existsSync(paths.statsCachePath)).toBe(true);

    const start2 = await cmdStart({ noOpen: true, openBrowserFn: () => {} });
    expect(start2).toBe(0);
    const state2 = readServeState(paths);
    expect(state2.pid).not.toBe(state.pid);

    const stats2 = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    // Session/定价未变：应命中磁盘快照，不强制重建
    expect(stats2.cache.revision).toBe(revision1);
    expect(stats2.generatedAt).toBe(generatedAt1);

    // 幂等 start
    const start3 = await cmdStart({ noOpen: true, openBrowserFn: () => {} });
    expect(start3).toBe(0);
    expect(readServeState(paths).pid).toBe(state2.pid);

    await cmdStop();
  }, 60000);

  it('concurrent start leaves a single managed process', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
    process.env.OPENCLAW_DIR = ws.workspaceDir;

    const env = {
      ...process.env,
      OPENCLAW_USAGE_PORT: String(port),
      OPENCLAW_CONFIG_DIR: ws.configDir,
      OPENCLAW_DIR: ws.workspaceDir,
    };

    const runCli = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'start', '--no-open'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });

    const [a, b] = await Promise.all([runCli(), runCli()]);
    // 至少一个成功；最终只能有一个受管进程
    expect([a.code, b.code].filter((c) => c === 0).length).toBeGreaterThanOrEqual(1);

    const paths = getLauncherPaths(ws.configDir);
    const state = readServeState(paths);
    expect(state).toBeTruthy();
    expect(isProcessAlive(state.pid)).toBe(true);

    // 再等片刻，确认没有第二个 listener 抢端口导致混乱——状态文件只有一个 pid
    await sleep(300);
    const stateAgain = readServeState(paths);
    expect(stateAgain.pid).toBe(state.pid);

    await cmdStop();
  }, 60000);

  it('start without dist exits non-zero', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;

    const fakeRoot = ws.root;
    mkdirSync(join(fakeRoot, 'dist'), { recursive: true });
    // 故意不写 index/pricing
    const paths = {
      ...getLauncherPaths(ws.configDir),
      repoRoot: fakeRoot,
      serverEntry: join(REPO_ROOT, 'server.js'),
    };
    const code = await cmdStart({ noOpen: true, openBrowserFn: () => {}, paths });
    expect(code).toBe(1);
  });

  it('kills the spawned child when writing serve.json fails', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
    process.env.OPENCLAW_DIR = ws.workspaceDir;

    const basePaths = getLauncherPaths(ws.configDir);
    mkdirSync(basePaths.runDir, { recursive: true, mode: 0o700 });

    // 注入真实的原子写入失败：把 serve.json 的父级做成普通文件，
    // 于是 atomicWriteFile 的 mkdir/rename 必然抛错（ENOTDIR）。
    const blocker = join(basePaths.runDir, 'blocked');
    writeFileSync(blocker, 'not-a-directory', 'utf-8');
    const paths = {
      ...basePaths,
      serveStatePath: join(blocker, 'serve.json'),
    };

    let spawnedPid = null;
    const code = await cmdStart({
      noOpen: true,
      openBrowserFn: () => {},
      paths,
      onSpawn: (pid) => { spawnedPid = pid; },
    });

    expect(code).toBe(1);
    expect(spawnedPid).toBeTruthy();

    // 子进程必须被回收：不留孤儿、端口释放、无残留状态
    expect(isProcessAlive(spawnedPid)).toBe(false);
    expect(await isPortListening('127.0.0.1', port)).toBe(false);
    expect(existsSync(paths.serveStatePath)).toBe(false);
    expect(existsSync(basePaths.serveStatePath)).toBe(false);
    expect(existsSync(basePaths.lockPath)).toBe(false);
  }, 60000);

  it('kills the spawned child when readiness never succeeds', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
    process.env.OPENCLAW_DIR = ws.workspaceDir;

    // 一个永不监听端口、但一直存活的假服务端：必然 readiness 超时
    const fakeEntry = join(ws.root, 'never-ready-server.mjs');
    writeFileSync(fakeEntry, 'setInterval(() => {}, 1000);\n', 'utf-8');

    const paths = {
      ...getLauncherPaths(ws.configDir),
      serverEntry: fakeEntry,
    };

    let spawnedPid = null;
    const code = await cmdStart({
      noOpen: true,
      openBrowserFn: () => {},
      paths,
      readyWaitMs: 1500,
      onSpawn: (pid) => { spawnedPid = pid; },
    });

    expect(code).toBe(1);
    expect(spawnedPid).toBeTruthy();
    expect(isProcessAlive(spawnedPid)).toBe(false);
    expect(readServeState(paths)).toBeNull();
    expect(await isPortListening('127.0.0.1', port)).toBe(false);
  }, 60000);

  it('does not report success for arbitrary HTTP on the port', async () => {
    const ws = await prepareFixtureWorkspace();
    const port = await findFreePort();
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_CONFIG_DIR = ws.configDir;
    process.env.OPENCLAW_DIR = ws.workspaceDir;

    // 先写一个假的「已运行」状态指向错误 health 身份
    // 更直接：在端口上放一个返回错误 health 的 http 服务，并伪造 owned state
    // 这里验证：cmdStart 在端口被占用时拒绝（无论 HTTP 内容）
    const { createServer } = await import('http');
    const fake = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'imposter', pid: 1, launchId: 'x' }));
    });
    await new Promise((resolve, reject) => {
      fake.listen(port, '127.0.0.1', resolve);
      fake.on('error', reject);
    });
    disposables.push(async () => {
      await new Promise((r) => fake.close(() => r()));
    });

    const code = await cmdStart({ noOpen: true, openBrowserFn: () => {} });
    expect(code).toBe(1);
  }, 20000);
});
