import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './openclaw-config.js';
import { getSqlitePath } from './sqlite-source.js';

/** 缓存结构与解析语义版本；不兼容变更须递增。
 *  v2：数据源切换为 SQLite 会话（贡献键 `sqlite:` / `sqlite-archive:` / `legacy:`），
 *      manifest 换为 SQLite 身份四元组，旧 JSONL 贡献一次性冻结迁移。
 *  v3：贡献 bucket 改为 UTC 小时粒度（合并输出新增 `byHourModel`），
 *      需全量重建贡献；legacy 冻结贡献会在重建时从 stats-v1.json 重新迁移。 */
export const CACHE_SCHEMA_VERSION = 3;

const CACHE_SUBDIR = 'cache/openclaw-usage';
const CACHE_FILENAME = 'stats-v2.json';
const LEGACY_CACHE_FILENAME = 'stats-v1.json';
const LOCK_FILENAME = 'stats-v2.lock';
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
 * 旧版（JSONL 时代）缓存路径，仅供冻结历史迁移读取
 * @returns {string}
 */
export function getLegacyCacheFilePath() {
  return join(getCacheDir(), LEGACY_CACHE_FILENAME);
}

/**
 * @returns {string}
 */
export function getLockFilePath() {
  return join(getCacheDir(), LOCK_FILENAME);
}

/**
 * 由数据源根生成 sourceId（API 仅暴露哈希）。
 * v2 输入为 SQLite 数据库路径；与 v1（sessions 目录路径）天然不同，
 * 迫使旧磁盘快照失效并走全量重建。
 * @param {string} sqlitePath
 * @returns {string}
 */
export function computeSourceId(sqlitePath) {
  const normalized = sqlitePath.replace(/\\/g, '/');
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
 * @param {Record<string, object>} a
 * @param {Record<string, object>} b
 * @returns {boolean}
 */
export function manifestsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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
 * 读取旧版（JSONL 时代）v1 缓存，仅供冻结历史迁移。
 * 缺失或损坏时返回 null；不做任何写回。
 * @returns {Promise<object|null>}
 */
export async function readLegacyDiskCache() {
  try {
    const raw = await readFile(getLegacyCacheFilePath(), 'utf-8');
    const cache = JSON.parse(raw);
    if (cache.schemaVersion !== 1) return null;
    return cache;
  } catch {
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
  const tmpPath = join(cacheDir, `stats-v2.${process.pid}.${Date.now()}.tmp`);
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
