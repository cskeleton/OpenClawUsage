#!/usr/bin/env node
/**
 * OpenClawUsage 本机启动器 CLI
 * 支持 start / stop / status / build / help，无第三方 CLI 框架。
 */
import { spawn, execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
  openSync,
  closeSync,
  rmSync,
} from 'fs';
import { createConnection } from 'net';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomBytes } from 'crypto';
import { resolveListenPort } from '../server.js';
import {
  syncToTarget,
  receiveSync,
  getSyncStatus,
} from '../sync-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'server.js');

const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 100;
const READY_WAIT_MS = 10_000;
const READY_POLL_MS = 200;
const STOP_TERM_WAIT_MS = 3_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;

const MARKER_HELP = `Usage: openclaw-usage <command> [options]

Commands:
  start [--no-open]  Start background web+API server (default http://127.0.0.1:3001)
  stop               Stop the managed background server
  status             Report running state (exit 0 only when running)
  build              Run npm run build in the repository root
  sync [targetId]    Push one sanitized snapshot to an allowlisted target
  receive-sync       Receive one sanitized snapshot from stdin
  sync-status        Print the last sync attempt/success/failure as JSON
  help               Show this help

Environment:
  OPENCLAW_CONFIG_DIR     OpenClaw config dir (default ~/.openclaw)
  OPENCLAW_USAGE_PORT     Listen port 1..65535 (default 3001)
  OPENCLAW_USAGE_LAUNCH_ID  Set by start for the child process (do not set manually)

State files (under $OPENCLAW_CONFIG_DIR):
  run/openclaw-usage/serve.json
  run/openclaw-usage/lifecycle.lock
  logs/openclaw-usage/serve.log
  run/openclaw-usage/sync-status.json
  cache/openclaw-usage/stats-v2.json
`;

/**
 * 解析 OpenClaw 配置根目录
 */
export function getConfigDir() {
  const raw = process.env.OPENCLAW_CONFIG_DIR;
  if (raw && String(raw).trim()) return resolve(String(raw).trim());
  return join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw');
}

/**
 * 启动器相关路径
 */
export function getLauncherPaths(configDir = getConfigDir()) {
  const runDir = join(configDir, 'run', 'openclaw-usage');
  const logDir = join(configDir, 'logs', 'openclaw-usage');
  const cacheDir = join(configDir, 'cache', 'openclaw-usage');
  return {
    configDir,
    runDir,
    logDir,
    cacheDir,
    serveStatePath: join(runDir, 'serve.json'),
    lockPath: join(runDir, 'lifecycle.lock'),
    logPath: join(logDir, 'serve.log'),
    statsCachePath: join(cacheDir, 'stats-v2.json'),
    repoRoot: REPO_ROOT,
    serverEntry: SERVER_ENTRY,
  };
}

/**
 * 确保运行目录存在且权限为 0700
 */
export function ensureRunDirs(paths = getLauncherPaths()) {
  for (const dir of [paths.runDir, paths.logDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 忽略 chmod 失败（部分文件系统不支持）
    }
  }
}

/**
 * 原子写入文件（临时文件 + rename），权限 0600
 */
export function atomicWriteFile(targetPath, content, mode = 0o600) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, content, { encoding: 'utf-8', mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // ignore
  }
  renameSync(tmp, targetPath);
  try {
    chmodSync(targetPath, mode);
  } catch {
    // ignore
  }
}

/**
 * 解析端口；非法时抛错
 */
export function parsePort(raw = process.env.OPENCLAW_USAGE_PORT) {
  return resolveListenPort(raw);
}

/**
 * 检查 dist 是否完整
 */
export function checkDistReady(repoRoot = REPO_ROOT) {
  const indexHtml = join(repoRoot, 'dist', 'index.html');
  const pricingHtml = join(repoRoot, 'dist', 'pricing.html');
  const missing = [];
  if (!existsSync(indexHtml)) missing.push('dist/index.html');
  if (!existsSync(pricingHtml)) missing.push('dist/pricing.html');
  return { ok: missing.length === 0, missing, indexHtml, pricingHtml };
}

/**
 * 读取 serve.json 并区分「不存在」与「存在但损坏」。
 *
 * 三态语义（对齐规格 §5.3 / §5.4）：
 * - `missing`：状态文件不存在 → stop 报「未在运行」，status 结合端口判定 stopped / port-conflict。
 * - `invalid`：文件存在但 JSON 损坏或字段非法 → 必须按 stale 处理并清理，避免坏文件长期残留。
 * - `valid`：结构合法，`state` 为解析结果。
 * @returns {{ status: 'missing'|'invalid'|'valid', state: object|null, reason?: string }}
 */
export function readServeStateEntry(paths = getLauncherPaths()) {
  if (!existsSync(paths.serveStatePath)) {
    return { status: 'missing', state: null };
  }

  let raw;
  try {
    raw = readFileSync(paths.serveStatePath, 'utf-8');
  } catch (err) {
    return { status: 'invalid', state: null, reason: `unreadable state file: ${err.message}` };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: 'invalid', state: null, reason: 'state file is not valid JSON' };
  }

  const invalid = (reason) => ({ status: 'invalid', state: null, reason });
  if (!data || typeof data !== 'object') return invalid('state file is not an object');
  if (data.version !== 1) return invalid('unsupported state version');
  if (!Number.isInteger(data.pid) || data.pid <= 0) return invalid('invalid pid field');
  if (typeof data.serverEntry !== 'string' || !data.serverEntry) return invalid('invalid serverEntry field');
  if (typeof data.repoRoot !== 'string' || !data.repoRoot) return invalid('invalid repoRoot field');
  if (typeof data.launchId !== 'string' || !data.launchId) return invalid('invalid launchId field');
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) return invalid('invalid port field');

  return { status: 'valid', state: data };
}

/**
 * 读取 serve.json；不存在或无效均返回 null（兼容旧调用方）
 */
export function readServeState(paths = getLauncherPaths()) {
  return readServeStateEntry(paths).state;
}

/**
 * 写入 serve.json
 */
export function writeServeState(state, paths = getLauncherPaths()) {
  ensureRunDirs(paths);
  atomicWriteFile(paths.serveStatePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/**
 * 删除 serve.json（忽略不存在）
 */
export function clearServeState(paths = getLauncherPaths()) {
  try {
    unlinkSync(paths.serveStatePath);
  } catch (err) {
    // ENOTDIR：父级路径不是目录，等价于状态文件不存在
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
}

/**
 * 进程是否存活
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return true;
    return false;
  }
}

/**
 * 读取进程启动时间字符串（用于 PID 复用判定）
 * @returns {string|null} null 表示暂时无法读取
 */
export function getProcessStartTime(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = String(out).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * 读取进程命令行
 * @returns {string|null} null 表示暂时无法读取
 */
export function getProcessCommandLine(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = String(out).trim();
    return text || null;
  } catch {
    // Linux 回退：/proc/<pid>/cmdline
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`);
      return raw.toString('utf-8').replace(/\0/g, ' ').trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * 校验存活 PID 是否归属本启动器。
 * @returns {{ status: 'owned'|'mismatch'|'uncertain', reason?: string }}
 */
export function verifyProcessOwnership(state, expectedRepoRoot = REPO_ROOT) {
  if (!state || !Number.isInteger(state.pid)) {
    return { status: 'mismatch', reason: 'invalid state' };
  }
  if (!isProcessAlive(state.pid)) {
    return { status: 'mismatch', reason: 'process not alive' };
  }

  if (state.repoRoot !== expectedRepoRoot) {
    return { status: 'mismatch', reason: 'repoRoot mismatch' };
  }

  const cmdline = getProcessCommandLine(state.pid);
  if (cmdline === null) {
    return { status: 'uncertain', reason: 'cannot read process command line' };
  }
  if (!cmdline.includes(state.serverEntry)) {
    return { status: 'mismatch', reason: 'command line does not include serverEntry' };
  }

  const startedAt = getProcessStartTime(state.pid);
  if (startedAt === null) {
    return { status: 'uncertain', reason: 'cannot read process start time' };
  }
  if (!state.processStartedAt) {
    return { status: 'uncertain', reason: 'state missing processStartedAt' };
  }
  if (startedAt !== state.processStartedAt) {
    return { status: 'mismatch', reason: 'processStartedAt mismatch (possible PID reuse)' };
  }

  return { status: 'owned' };
}

/**
 * TCP 探测端口是否已被监听
 */
export function isPortListening(host, port, timeoutMs = 500) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/**
 * 请求 /api/health
 * @returns {Promise<object|null>}
 */
export async function fetchHealth(host, port, timeoutMs = 1000) {
  const url = `http://${host}:${port}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判断 health 是否匹配指定子进程身份
 */
export function healthMatches(health, { pid, launchId }) {
  return !!(
    health
    && health.ok === true
    && health.service === 'openclaw-usage'
    && health.pid === pid
    && health.launchId === launchId
  );
}

/**
 * 日志超过 5 MiB 时轮转为 serve.log.1
 */
export function rotateLogIfNeeded(logPath) {
  if (!existsSync(logPath)) return;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size <= LOG_ROTATE_BYTES) return;
  const rotated = `${logPath}.1`;
  try {
    if (existsSync(rotated)) unlinkSync(rotated);
  } catch {
    // ignore
  }
  renameSync(logPath, rotated);
}

/**
 * 获取生命周期锁；超时抛错
 */
export async function acquireLifecycleLock(paths = getLauncherPaths(), waitMs = LOCK_WAIT_MS) {
  ensureRunDirs(paths);
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    const payload = `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`;

    // 使用 wx 一次性写入完整内容，避免「空文件窗口」被其它进程当成损坏锁删掉
    try {
      writeFileSync(paths.lockPath, payload, { flag: 'wx', mode: 0o600 });
      try { chmodSync(paths.lockPath, 0o600); } catch { /* ignore */ }
      return {
        path: paths.lockPath,
        release() {
          try { unlinkSync(paths.lockPath); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }

    // 锁存在：若持有进程已退出则回收；解析失败时不立即删除（避免误回收）
    try {
      const raw = readFileSync(paths.lockPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data || !Number.isInteger(data.pid) || !isProcessAlive(data.pid)) {
        try { unlinkSync(paths.lockPath); } catch { /* ignore */ }
        continue;
      }
    } catch {
      try {
        const st = statSync(paths.lockPath);
        // 仅当锁文件异常久未更新时才回收损坏锁
        if (Date.now() - st.mtimeMs > 30_000) {
          try { unlinkSync(paths.lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch {
        // 文件已消失，下一轮重试
        continue;
      }
    }

    await sleep(LOCK_POLL_MS);
  }

  throw new Error(`Failed to acquire lifecycle lock within ${waitMs}ms: ${paths.lockPath}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 评估当前受管状态（供 start/status 共用）
 */
export async function evaluateManagedState(paths = getLauncherPaths(), port = parsePort()) {
  const entry = readServeStateEntry(paths);

  if (entry.status === 'missing') {
    const busy = await isPortListening(LISTEN_HOST, port);
    return {
      kind: busy ? 'port-conflict' : 'stopped',
      state: null,
      port,
      url: `http://${LISTEN_HOST}:${port}`,
    };
  }

  // 损坏状态文件：按 stale 处理（可清理），不得误报为 stopped
  if (entry.status === 'invalid') {
    return {
      kind: 'stale',
      state: null,
      reason: entry.reason || 'invalid state file',
      invalidState: true,
      port,
      url: `http://${LISTEN_HOST}:${port}`,
    };
  }

  const state = entry.state;

  if (!isProcessAlive(state.pid)) {
    return { kind: 'stale', state, reason: 'pid exited', port: state.port, url: `http://${LISTEN_HOST}:${state.port}` };
  }

  const ownership = verifyProcessOwnership(state, paths.repoRoot);
  if (ownership.status === 'uncertain') {
    return {
      kind: 'stale',
      state,
      reason: ownership.reason,
      uncertain: true,
      port: state.port,
      url: `http://${LISTEN_HOST}:${state.port}`,
    };
  }
  if (ownership.status === 'mismatch') {
    return {
      kind: 'stale',
      state,
      reason: ownership.reason,
      ownershipMismatch: true,
      port: state.port,
      url: `http://${LISTEN_HOST}:${state.port}`,
    };
  }

  const health = await fetchHealth(state.host || LISTEN_HOST, state.port);
  if (healthMatches(health, { pid: state.pid, launchId: state.launchId })) {
    return {
      kind: 'running',
      state,
      health,
      port: state.port,
      url: `http://${LISTEN_HOST}:${state.port}`,
    };
  }

  return {
    kind: 'unhealthy',
    state,
    health,
    port: state.port,
    url: `http://${LISTEN_HOST}:${state.port}`,
  };
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'linux') {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function printCacheInfo(paths) {
  if (!existsSync(paths.statsCachePath)) {
    console.log(`stats cache: missing (${paths.statsCachePath})`);
    return;
  }
  try {
    const st = statSync(paths.statsCachePath);
    console.log(`stats cache: present, mtime=${st.mtime.toISOString()} (${paths.statsCachePath})`);
  } catch (err) {
    console.log(`stats cache: unreadable (${err.message})`);
  }
}

/**
 * start 命令
 */
/**
 * 回收本次 start 拉起的子进程，并只在确认其退出后才清理状态。
 *
 * 这是 start 的事务回滚点：spawn 之后的任何失败分支（无法读取启动时间、
 * 状态写入失败、readiness 超时、意外异常）都必须走这里，否则会留下
 * 「health 通但 stop 管不到」的孤儿进程。
 * @param {number} pid 子进程 PID
 * @param {object} paths 启动器路径
 * @param {{ reason?: string, termWaitMs?: number }} [options]
 * @returns {Promise<boolean>} 是否已确认子进程退出且状态已清理
 */
export async function rollbackStartedChild(pid, paths, { reason = '', termWaitMs = 3_000 } = {}) {
  if (reason) console.error(`Rolling back start: ${reason}`);

  let result;
  try {
    result = await stopOwnedProcess(pid, { termWaitMs });
  } catch (err) {
    result = { ok: false, reason: err?.message || String(err) };
  }

  if (!result.ok || isProcessAlive(pid)) {
    console.error(`Failed to reclaim spawned pid ${pid}: ${result.reason || 'still alive'}`);
    console.error(`Leaving serve.json in place so that "openclaw-usage stop" can retry: ${paths.serveStatePath}`);
    return false;
  }

  // 仅在确认子进程已退出后才允许清理状态
  try {
    clearServeState(paths);
  } catch (err) {
    console.error(`Failed to clear serve.json after rollback: ${err.message}`);
    return false;
  }
  return true;
}

export async function cmdStart({
  noOpen = false,
  openBrowserFn = openBrowser,
  paths: pathsOverride = null,
  readyWaitMs = READY_WAIT_MS,
  onSpawn = null,
} = {}) {
  const paths = pathsOverride || getLauncherPaths();
  let port;
  try {
    port = parsePort();
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const dist = checkDistReady(paths.repoRoot);
  if (!dist.ok) {
    console.error(`Missing build output: ${dist.missing.join(', ')}`);
    console.error('Run: openclaw-usage build');
    return 1;
  }

  let lock;
  try {
    lock = await acquireLifecycleLock(paths);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  try {
    const evaluated = await evaluateManagedState(paths, port);

    if (evaluated.kind === 'running') {
      console.log(`Already running at ${evaluated.url} (pid ${evaluated.state.pid})`);
      if (!noOpen) openBrowserFn(evaluated.url);
      return 0;
    }

    if (evaluated.kind === 'unhealthy') {
      console.error(`Managed process is unhealthy (pid ${evaluated.state.pid}).`);
      console.error(`Refusing to start a second process. Check log: ${paths.logPath}`);
      console.error('Try: openclaw-usage stop');
      return 1;
    }

    if (evaluated.kind === 'stale') {
      if (evaluated.uncertain) {
        console.error(`Cannot verify ownership of pid ${evaluated.state?.pid}: ${evaluated.reason}`);
        console.error('Refusing to clear state or start. Retry later or inspect the process.');
        return 1;
      }
      if (evaluated.ownershipMismatch && evaluated.state && isProcessAlive(evaluated.state.pid)) {
        console.warn(`Warning: pid ${evaluated.state.pid} is alive but not owned by this launcher (${evaluated.reason}).`);
        console.warn('Clearing stale serve.json without signaling that process.');
      }
      if (evaluated.invalidState) {
        console.warn(`Warning: removing corrupted serve.json (${evaluated.reason}).`);
      }
      clearServeState(paths);
    }

    // 端口被其他服务占用
    if (await isPortListening(LISTEN_HOST, port)) {
      console.error(`Port ${LISTEN_HOST}:${port} is already in use by another process.`);
      console.error('Stop the conflicting service or set OPENCLAW_USAGE_PORT to a free port.');
      return 1;
    }

    const launchId = randomBytes(16).toString('hex');
    rotateLogIfNeeded(paths.logPath);
    ensureRunDirs(paths);

    const logFd = openSync(paths.logPath, 'a', 0o600);
    try { chmodSync(paths.logPath, 0o600); } catch { /* ignore */ }

    const child = spawn(process.execPath, [paths.serverEntry], {
      cwd: paths.repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OPENCLAW_USAGE_PORT: String(port),
        OPENCLAW_USAGE_LAUNCH_ID: launchId,
      },
    });

    closeSync(logFd);

    if (!child.pid) {
      console.error('Failed to spawn server process');
      return 1;
    }

    child.unref();
    const childPid = child.pid;
    if (typeof onSpawn === 'function') onSpawn(childPid);

    // spawn 之后进入事务区：任何失败路径都必须先回收子进程，再清理状态
    try {
      // 必须拿到 processStartedAt，否则后续 stop 无法安全归属校验
      let processStartedAt = null;
      const startMetaDeadline = Date.now() + 1000;
      while (Date.now() <= startMetaDeadline) {
        if (!isProcessAlive(childPid)) break;
        processStartedAt = getProcessStartTime(childPid);
        if (processStartedAt) break;
        await sleep(50);
      }

      if (!processStartedAt) {
        console.error(`Log: ${paths.logPath}`);
        await rollbackStartedChild(childPid, paths, {
          reason: 'failed to read child process start time',
        });
        return 1;
      }

      const state = {
        version: 1,
        pid: childPid,
        repoRoot: paths.repoRoot,
        serverEntry: paths.serverEntry,
        host: LISTEN_HOST,
        port,
        launchId,
        processStartedAt,
        startedAt: new Date().toISOString(),
      };
      writeServeState(state, paths);

      const deadline = Date.now() + readyWaitMs;
      let ready = false;
      while (Date.now() <= deadline) {
        if (!isProcessAlive(childPid)) {
          break;
        }
        const health = await fetchHealth(LISTEN_HOST, port);
        if (healthMatches(health, { pid: childPid, launchId })) {
          ready = true;
          break;
        }
        await sleep(READY_POLL_MS);
      }

      if (!ready) {
        console.error('Server failed to become ready (owned health check).');
        console.error(`Log: ${paths.logPath}`);
        await rollbackStartedChild(childPid, paths, { reason: 'readiness check failed' });
        return 1;
      }

      const url = `http://${LISTEN_HOST}:${port}`;
      console.log(`Started ${url}`);
      console.log(`pid=${childPid}`);
      console.log(`log=${paths.logPath}`);
      if (!noOpen) openBrowserFn(url);
      return 0;
    } catch (err) {
      // 典型场景：serve.json 原子写入 / rename 失败。若此处直接抛出，
      // 已 detached 的子进程会成为无法被 stop 管理的孤儿。
      console.error(`Start failed after spawning pid ${childPid}: ${err?.message || err}`);
      console.error(`Log: ${paths.logPath}`);
      await rollbackStartedChild(childPid, paths, { reason: 'unexpected error while recording state' });
      return 1;
    }
  } finally {
    lock.release();
  }
}

/**
 * 向归属确认的进程发送 SIGTERM，超时后 SIGKILL
 */
export async function stopOwnedProcess(pid, {
  termWaitMs = STOP_TERM_WAIT_MS,
  killFn = (p, sig) => process.kill(p, sig),
  aliveFn = isProcessAlive,
  sleepFn = sleep,
} = {}) {
  if (!aliveFn(pid)) return { ok: true, signaled: false };

  try {
    killFn(pid, 'SIGTERM');
  } catch (err) {
    if (err && err.code === 'ESRCH') return { ok: true, signaled: false };
    throw err;
  }

  const deadline = Date.now() + termWaitMs;
  while (Date.now() <= deadline) {
    if (!aliveFn(pid)) return { ok: true, signaled: true, usedKill: false };
    await sleepFn(100);
  }

  if (!aliveFn(pid)) return { ok: true, signaled: true, usedKill: false };

  try {
    killFn(pid, 'SIGKILL');
  } catch (err) {
    if (err && err.code === 'ESRCH') return { ok: true, signaled: true, usedKill: true };
    throw err;
  }

  await sleepFn(200);
  if (aliveFn(pid)) {
    return { ok: false, signaled: true, usedKill: true, reason: 'process still alive after SIGKILL' };
  }
  return { ok: true, signaled: true, usedKill: true };
}

/**
 * stop 命令
 */
export async function cmdStop({ paths: pathsOverride = null } = {}) {
  const paths = pathsOverride || getLauncherPaths();
  let lock;
  try {
    lock = await acquireLifecycleLock(paths);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  try {
    const entry = readServeStateEntry(paths);
    if (entry.status === 'missing') {
      console.log('Not running');
      return 0;
    }

    // 损坏状态文件：按规格清理陈旧状态并正常退出，不得留下坏文件
    if (entry.status === 'invalid') {
      clearServeState(paths);
      console.log(`Cleared stale state (${entry.reason || 'invalid state file'})`);
      return 0;
    }

    const state = entry.state;

    if (!isProcessAlive(state.pid)) {
      clearServeState(paths);
      console.log('Cleared stale state (process already exited)');
      return 0;
    }

    const ownership = verifyProcessOwnership(state, paths.repoRoot);
    if (ownership.status === 'uncertain') {
      console.error(`Cannot verify ownership of pid ${state.pid}: ${ownership.reason}`);
      console.error('Not signaling; state preserved for retry.');
      return 1;
    }
    if (ownership.status === 'mismatch') {
      console.warn(`Warning: pid ${state.pid} is alive but not owned (${ownership.reason}).`);
      console.warn('Clearing stale serve.json without signaling that process.');
      clearServeState(paths);
      return 1;
    }

    const result = await stopOwnedProcess(state.pid);
    if (!result.ok) {
      console.error(`Failed to stop pid ${state.pid}: ${result.reason}`);
      return 1;
    }

    clearServeState(paths);
    console.log(`Stopped pid ${state.pid}`);
    return 0;
  } finally {
    lock.release();
  }
}

/**
 * status 命令
 */
export async function cmdStatus() {
  const paths = getLauncherPaths();
  let port;
  try {
    port = parsePort();
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const evaluated = await evaluateManagedState(paths, port);
  const url = evaluated.url;

  switch (evaluated.kind) {
    case 'running':
      console.log(`status: running`);
      console.log(`pid: ${evaluated.state.pid}`);
      console.log(`url: ${url}`);
      console.log(`log: ${paths.logPath}`);
      printCacheInfo(paths);
      return 0;
    case 'unhealthy':
      console.log(`status: unhealthy`);
      console.log(`pid: ${evaluated.state.pid}`);
      console.log(`url: ${url}`);
      console.log(`log: ${paths.logPath}`);
      printCacheInfo(paths);
      return 1;
    case 'stale':
      console.log(`status: stale`);
      if (evaluated.state?.pid) console.log(`pid: ${evaluated.state.pid}`);
      if (evaluated.reason) console.log(`reason: ${evaluated.reason}`);
      console.log(`url: ${url}`);
      console.log(`log: ${paths.logPath}`);
      printCacheInfo(paths);
      return 1;
    case 'port-conflict':
      console.log(`status: port-conflict`);
      console.log(`url: ${url}`);
      console.log(`log: ${paths.logPath}`);
      printCacheInfo(paths);
      return 1;
    case 'stopped':
    default:
      console.log(`status: stopped`);
      console.log(`url: ${url}`);
      console.log(`log: ${paths.logPath}`);
      printCacheInfo(paths);
      return 1;
  }
}

/**
 * build 命令
 */
export function cmdBuild() {
  const paths = getLauncherPaths();
  console.log(`Building in ${paths.repoRoot} ...`);
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: paths.repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    return 0;
  } catch {
    return 1;
  }
}

function safeCliFailure(error, fallback) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : null;
  return code ? { ok: false, error: fallback, code } : { ok: false, error: fallback };
}

/** Run one outbound sync without retries and print safe JSON only. */
export async function cmdSync({ targetId, scheduled = false, syncFn = syncToTarget, print = (line) => console.log(line) } = {}) {
  try {
    const result = scheduled ? await syncFn(targetId, { scheduled: true }) : await syncFn(targetId);
    print(JSON.stringify(result));
    return 0;
  } catch (error) {
    print(JSON.stringify(safeCliFailure(error, 'sync failed')));
    return 1;
  }
}

/** Receive one stdin snapshot and print a deterministic safe result. */
export async function cmdReceiveSync({ input = process.stdin, receiveFn = receiveSync, print = (line) => console.log(line) } = {}) {
  try {
    const result = await receiveFn(input);
    print(JSON.stringify(result));
    return 0;
  } catch (error) {
    print(JSON.stringify(safeCliFailure(error, 'receive-sync failed')));
    return 1;
  }
}

/** Print only the persisted/public sync status projection. */
export async function cmdSyncStatus({ statusFn = getSyncStatus, print = (line) => console.log(line) } = {}) {
  try {
    const result = await statusFn();
    print(JSON.stringify(result));
    return 0;
  } catch (error) {
    print(JSON.stringify(safeCliFailure(error, 'sync-status failed')));
    return 1;
  }
}

export function cmdHelp() {
  const paths = getLauncherPaths();
  process.stdout.write(MARKER_HELP);
  console.log(`\nRepository: ${paths.repoRoot}`);
  console.log(`Config dir: ${paths.configDir}`);
  return 0;
}

/**
 * CLI 入口
 */
export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return cmdHelp();
  }

  if (cmd === 'start') {
    const noOpen = rest.includes('--no-open');
    const unknown = rest.filter((a) => a !== '--no-open');
    if (unknown.length) {
      console.error(`Unknown option(s): ${unknown.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdStart({ noOpen });
  }

  if (cmd === 'stop') {
    if (rest.length) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdStop();
  }

  if (cmd === 'status') {
    if (rest.length) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdStatus();
  }

  if (cmd === 'build') {
    if (rest.length) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdBuild();
  }

  if (cmd === 'sync') {
    const scheduled = rest.includes('--scheduled');
    const unsupportedFlags = rest.filter((arg) => arg.startsWith('-') && arg !== '--scheduled');
    const targetArgs = rest.filter((arg) => arg !== '--scheduled');
    if (unsupportedFlags.length || targetArgs.length > 1 || (scheduled && rest[rest.length - 1] !== '--scheduled')) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdSync({ targetId: targetArgs[0], scheduled });
  }

  if (cmd === 'receive-sync') {
    if (rest.length) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdReceiveSync();
  }

  if (cmd === 'sync-status') {
    if (rest.length) {
      console.error(`Unexpected arguments: ${rest.join(' ')}`);
      process.stdout.write(MARKER_HELP);
      return 1;
    }
    return cmdSyncStatus();
  }

  console.error(`Unknown command: ${cmd}`);
  process.stdout.write(MARKER_HELP);
  return 1;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then((code) => {
    process.exit(code ?? 0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// 测试辅助：允许清理临时锁
export function forceRemovePath(p) {
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
}
