import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './openclaw-config.js';

/** 缓存结构与解析语义版本；不兼容变更须递增 */
export const CACHE_SCHEMA_VERSION = 1;

const CACHE_SUBDIR = 'cache/openclaw-usage';
const CACHE_FILENAME = 'stats-v1.json';
const LOCK_FILENAME = 'stats-v1.lock';
const LOCK_STALE_MS = 120_000;

/**
 * 持久化缓存目录（跟随 OPENCLAW_CONFIG_DIR）
 * @returns {string}
 */
export function getCacheDir() {
  return join(getOpenClawConfigDir(), CACHE_SUBDIR);
}

/**
 * @returns {string}
 */
export function getCacheFilePath() {
  return join(getCacheDir(), CACHE_FILENAME);
}

/**
 * @returns {string}
 */
export function getLockFilePath() {
  return join(getCacheDir(), LOCK_FILENAME);
}

/**
 * 由 Session 根目录生成 sourceId（API 仅暴露哈希）
 * @param {string} sessionDir
 * @returns {string}
 */
export function computeSourceId(sessionDir) {
  const normalized = sessionDir.replace(/\\/g, '/');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 构建定价指纹（保持 pricing 声明顺序）
 * @param {object} pricingConfig
 * @returns {object}
 */
export function buildPricingFingerprint(pricingConfig) {
  return {
    version: pricingConfig?.version || 'none',
    enabled: pricingConfig?.enabled !== false,
    updated: pricingConfig?.updated || '',
    pricing: pricingConfig?.pricing || {},
  };
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function fingerprintsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {Record<string, { size: number, mtimeMs: number }>} a
 * @param {Record<string, { size: number, mtimeMs: number }>} b
 * @returns {boolean}
 */
export function manifestsEqual(a, b) {
  const keysA = Object.keys(a || {});
  const keysB = Object.keys(b || {});
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const left = a[key];
    const right = b[key];
    if (!right || left.size !== right.size || left.mtimeMs !== right.mtimeMs) {
      return false;
    }
  }
  return true;
}

/**
 * 检测缓存目录是否可写。
 * 探针文件名带 pid + 随机后缀，避免 Web/MCP 并发探测时互相删除对方的探针而误判不可写。
 * @returns {Promise<boolean>}
 */
export async function isCacheWritable() {
  const testPath = join(
    getCacheDir(),
    `.write-test.${process.pid}.${randomBytes(6).toString('hex')}`
  );
  try {
    await mkdir(getCacheDir(), { recursive: true, mode: 0o700 });
    await writeFile(testPath, 'ok', { mode: 0o600 });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await unlink(testPath);
    } catch {
      // 探针清理失败不影响可写判定
    }
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试独占创建跨进程锁
 * @returns {Promise<boolean>}
 */
export async function tryAcquireLock() {
  const lockPath = getLockFilePath();
  await mkdir(getCacheDir(), { recursive: true, mode: 0o700 });
  const lockContent = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  try {
    await writeFile(lockPath, lockContent, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  try {
    const data = JSON.parse(await readFile(lockPath, 'utf-8'));
    const started = new Date(data.startedAt).getTime();
    const stale = Date.now() - started > LOCK_STALE_MS;
    if (stale && !isProcessAlive(data.pid)) {
      await unlink(lockPath);
      try {
        await writeFile(lockPath, lockContent, { flag: 'wx', mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    // 无法确认持有进程已退出时不抢锁
  }
  return false;
}

/**
 * 释放本进程持有的锁
 * @returns {Promise<void>}
 */
export async function releaseLock() {
  try {
    const lockPath = getLockFilePath();
    const data = JSON.parse(await readFile(lockPath, 'utf-8'));
    if (data.pid === process.pid) {
      await unlink(lockPath);
    }
  } catch {
    // 忽略
  }
}

/**
 * 等待跨进程锁释放（或变为可回收的陈旧锁）
 * @param {{ timeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<'released'|'timeout'|'reclaimable'>}
 */
export async function waitForLockRelease({ timeoutMs = 130_000, pollMs = 100 } = {}) {
  const lockPath = getLockFilePath();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await readFile(lockPath, 'utf-8'));
      const started = new Date(data.startedAt).getTime();
      const stale = Date.now() - started > LOCK_STALE_MS;
      if (stale && !isProcessAlive(data.pid)) {
        return 'reclaimable';
      }
    } catch (err) {
      if (err.code === 'ENOENT') return 'released';
      // 锁内容不可读时继续轮询，避免误判
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return 'timeout';
}

/**
 * 读取磁盘缓存；损坏或 schema 不匹配时返回 null
 * @returns {Promise<object|null>}
 */
export async function readDiskCache() {
  try {
    const raw = await readFile(getCacheFilePath(), 'utf-8');
    const cache = JSON.parse(raw);
    if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    return cache;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

/**
 * 原子写入缓存 JSON
 * @param {object} cache
 * @returns {Promise<void>}
 */
export async function writeDiskCacheAtomic(cache) {
  const cacheDir = getCacheDir();
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const tmpPath = join(cacheDir, `stats-v1.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(cache), { mode: 0o600 });
    await rename(tmpPath, getCacheFilePath());
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw err;
  }
}

/**
 * 清理本进程可能遗留的临时文件
 * @returns {Promise<void>}
 */
export async function cleanupTempFiles() {
  // rename 成功后无临时文件；写入失败时由调用方在 finally 中 unlink
}
