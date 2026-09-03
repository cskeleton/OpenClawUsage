import { join } from 'path';
import { createHash } from 'crypto';
import { existsSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import {
  getSqlitePath,
  scanSqliteManifest,
  buildSqliteContributions,
  listSqliteSessionIds,
} from './sqlite-source.js';
import { getOpenClawConfigDir } from './openclaw-config.js';
import {
  getPublicSyncConfig,
  loadSyncConfig,
  SYNC_CONFIG_FILENAME,
} from './sync-config.js';
import { loadImportedSnapshots } from './sync-snapshot.js';
import { loadPricingConfig, savePricingConfig, validatePricingConfig } from './pricing.js';
import {
  CACHE_SCHEMA_VERSION,
  computeSourceId,
  buildPricingFingerprint,
  fingerprintsEqual,
  manifestsEqual,
  isCacheWritable,
  tryAcquireLock,
  releaseLock,
  waitForLockRelease,
  readDiskCache,
  readLegacyDiskCache,
  writeDiskCacheAtomic,
  getLockFilePath,
} from './stats-cache-store.js';
import {
  mergeFileContributions,
  buildEmptyStats,
  namespaceFileContributions,
  STATS_SHAPE_VERSION,
} from './stats-contribution.js';

const MANIFEST_SCAN_COALESCE_MS = 1000;

/** @type {{ stats: object|null, files: Record<string, object>, manifest: object, revision: number, sourceId: string, pricingFingerprint: object|null, cacheState: string }} */
let memory = {
  stats: null,
  files: {},
  manifest: {},
  revision: 0,
  sourceId: '',
  pricingFingerprint: null,
  cacheState: 'fresh',
};

/** @type {Promise<void>|null} */
let inflightRefresh = null;
/** 当前 inflight 是否为全量刷新 */
let inflightIsFull = false;
let lastManifestScan = null;
let persistenceUnavailable = false;

/**
 * 附加定价元数据到统计结果
 */
function attachPricingMeta(stats, pricingConfig) {
  return {
    ...stats,
    pricingUpdated: pricingConfig.updated || '',
    pricingVersion: pricingConfig.version,
  };
}

/**
 * 包装 API 响应，附加 cache 元数据
 */
function wrapStatsResponse(stats, cacheMeta) {
  return {
    ...stats,
    cache: {
      state: cacheMeta.state,
      revision: cacheMeta.revision,
      sourceId: cacheMeta.sourceId,
      checkedAt: cacheMeta.checkedAt,
      ...(cacheMeta.combinedRevision
        ? { combinedRevision: cacheMeta.combinedRevision }
        : {}),
    },
  };
}

/**
 * 1 秒内复用数据库清单检查结果
 */
async function getManifestCoalesced() {
  const now = Date.now();
  if (
    lastManifestScan &&
    now - lastManifestScan.at < MANIFEST_SCAN_COALESCE_MS
  ) {
    return lastManifestScan.result;
  }
  return rescanManifest();
}

/**
 * 强制重新扫描数据库清单（刷新路径与等锁结束后使用）
 * @returns {{ exists: boolean, identity?: object, sessions: object, archives: object }}
 */
function rescanManifest() {
  const result = scanSqliteManifest();
  lastManifestScan = { at: Date.now(), result };
  return result;
}

/**
 * 从磁盘缓存加载到内存
 */
function loadMemoryFromDiskCache(diskCache) {
  memory.files = { ...diskCache.files };
  memory.manifest = { ...diskCache.manifest };
  memory.revision = diskCache.revision || 0;
  memory.sourceId = diskCache.sourceId;
  memory.stats = diskCache.stats;
}

/**
 * 比较 manifest 差异（sessions 与 archives 两个维度合并为单一贡献键集合）
 * @param {{ sessions: object, archives: object }} oldManifest
 * @param {{ sessions: object, archives: object }} newManifest
 */
function diffManifest(oldManifest, newManifest) {
  const oldKeys = manifestKeyMap(oldManifest);
  const newKeys = manifestKeyMap(newManifest);

  const added = [];
  const changed = [];
  const removed = [];

  for (const [name, identity] of Object.entries(newKeys)) {
    const old = oldKeys[name];
    if (!old) {
      added.push(name);
    } else if (JSON.stringify(old) !== JSON.stringify(identity)) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(oldKeys)) {
    if (!newKeys[name]) removed.push(name);
  }

  return { added, changed, removed };
}

/**
 * 把 manifest 的 sessions/archives 归一为「贡献键 → 身份」映射。
 * 活跃会话键 `sqlite:<sessionId>`；归档键 `sqlite-archive:<sessionId>@<generation>`。
 */
function manifestKeyMap(manifest) {
  const out = Object.create(null);
  for (const [sessionId, identity] of Object.entries(manifest?.sessions || {})) {
    out[`sqlite:${sessionId}`] = identity;
  }
  for (const [key, identity] of Object.entries(manifest?.archives || {})) {
    out[`sqlite-archive:${key}`] = identity;
  }
  return out;
}

/**
 * 磁盘快照里的 `stats` 是否可直接复用。
 * 除定价指纹外还要求合并结果形状版本一致：
 * 旧形状（缺少 session.byDateModel 等字段）必须从 `files` 重新合并，
 * 但这是纯内存计算，不需要重新解析 JSONL。
 * @param {object|null} diskCache
 * @param {object} fp 当前定价指纹
 * @returns {boolean}
 */
function canReuseDiskStats(diskCache, fp) {
  if (!diskCache?.stats) return false;
  if (!fingerprintsEqual(diskCache.pricingFingerprint, fp)) return false;
  // 缺字段的旧快照按形状版本 1 处理
  return (diskCache.statsShapeVersion ?? 1) === STATS_SHAPE_VERSION;
}

/**
 * 从磁盘快照采纳到内存（不解析 JSONL）。
 * 定价指纹与结果形状均一致时直接复用磁盘上的统计结果，避免无意义的全量重新合并。
 */
function adoptDiskCache(diskCache, pricingConfig, fp) {
  loadMemoryFromDiskCache(diskCache);
  if (!canReuseDiskStats(diskCache, fp)) {
    memory.stats = attachPricingMeta(
      mergeFileContributions(diskCache.files, pricingConfig),
      pricingConfig
    );
  }
  memory.pricingFingerprint = fp;
  memory.cacheState = 'fresh';
}

/**
 * 选择增量刷新的基线。
 * manifest 与 files 必须同源，否则会把「基线里没有的文件」误判为未变化而漏解析。
 * 空的 memory.manifest 不构成基线，重启后应回落到磁盘 manifest。
 * @param {string} sourceId
 * @param {object|null} diskCache
 * @returns {{ files: object, manifest: object }}
 */
function pickIncrementalBaseline(sourceId, diskCache) {
  const memoryUsable =
    memory.sourceId === sourceId && Object.keys(memory.manifest || {}).length > 0;
  const diskUsable = !!diskCache && diskCache.sourceId === sourceId;

  if (memoryUsable && (!diskUsable || (memory.revision || 0) >= (diskCache.revision || 0))) {
    return { files: { ...memory.files }, manifest: { ...memory.manifest } };
  }
  if (diskUsable) {
    return { files: { ...diskCache.files }, manifest: { ...diskCache.manifest } };
  }
  return { files: {}, manifest: {} };
}

/**
 * 从 v1（JSONL 时代）磁盘缓存冻结历史贡献。
 * 仅迁移有记录、且会话 id 不与 SQLite 活跃/归档重合的贡献（防双计）；
 * 迁移后的贡献键统一加 `legacy:` 前缀，不再参与变更检测。
 * @returns {Promise<Record<string, object>>}
 */
async function buildLegacyContributions() {
  const legacyCache = await readLegacyDiskCache();
  if (!legacyCache || !legacyCache.files) return {};

  const sqliteIds = listSqliteSessionIds();
  const out = Object.create(null);
  for (const [filename, contribution] of Object.entries(legacyCache.files)) {
    if (!contribution?.hasRecords) continue;
    if (sqliteIds && sqliteIds.has(contribution.session?.id)) continue;
    out[`legacy:${filename}`] = {
      session: {
        id: contribution.session.id,
        status: contribution.session.status,
        archivedAt: contribution.session.archivedAt,
      },
      identity: { frozen: true },
      buckets: contribution.buckets,
      hasRecords: true,
      firstTimestamp: contribution.firstTimestamp,
      lastTimestamp: contribution.lastTimestamp,
    };
  }
  return out;
}

/**
 * 解析/合并贡献并发布到进程内内存
 * @returns {Promise<{ filesMap: object, stats: object, revision: number, now: string, manifest: object }>}
 */
async function buildSnapshot({ full, sourceId, manifest, pricingConfig, fp }) {
  const diskCache = await readDiskCache();
  // 全量刷新丢弃全部逐会话贡献；增量刷新复用同源基线
  const baseline = full ? { files: {}, manifest: {} } : pickIncrementalBaseline(sourceId, diskCache);
  const filesMap = baseline.files;

  const diff = diffManifest(baseline.manifest, manifest);
  for (const name of diff.removed) {
    delete filesMap[name];
  }
  // 防御：基线 files 含 manifest 之外的残留贡献时清理，但冻结的 legacy 贡献除外
  const currentKeys = manifestKeyMap(manifest);
  for (const name of Object.keys(filesMap)) {
    if (!name.startsWith('legacy:') && !currentKeys[name]) delete filesMap[name];
  }

  if (diff.added.length > 0 || diff.changed.length > 0) {
    const sessionDiff = splitDiff(diff, 'sqlite:');
    const archiveDiff = splitDiff(diff, 'sqlite-archive:');
    const { contributions } = await buildSqliteContributions(sessionDiff, archiveDiff);
    Object.assign(filesMap, contributions);
  }

  // 首次构建（或全量后基线为空）时冻结 v1 历史贡献
  if (!Object.keys(filesMap).some((key) => key.startsWith('legacy:'))) {
    const legacy = await buildLegacyContributions();
    Object.assign(filesMap, legacy);
  }

  const stats = attachPricingMeta(mergeFileContributions(filesMap, pricingConfig), pricingConfig);
  const revision = Math.max(memory.revision || 0, diskCache?.revision || 0) + 1;
  const now = new Date().toISOString();

  memory.stats = stats;
  memory.files = filesMap;
  memory.manifest = { ...manifest };
  memory.revision = revision;
  memory.sourceId = sourceId;
  memory.pricingFingerprint = fp;
  memory.cacheState = 'fresh';

  return { filesMap, stats, revision, now, manifest };
}

/**
 * 从合并 diff 中按前缀拆出各维度的会话/归档键
 */
function splitDiff(diff, prefix) {
  const pick = (list) => list.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  return { added: pick(diff.added), changed: pick(diff.changed), removed: pick(diff.removed) };
}

/**
 * 数据库不存在时的处理：有旧结果则标记陈旧，否则发布空统计（含冻结历史）
 * @returns {boolean} 是否已完成处理
 */
function handleMissingDatabase(sourceId, pricingConfig, fp) {
  if (memory.stats) {
    memory.cacheState = 'stale';
    return true;
  }
  memory.stats = attachPricingMeta(buildEmptyStats(), pricingConfig);
  memory.files = {};
  memory.manifest = {};
  memory.revision = 1;
  memory.sourceId = sourceId;
  memory.pricingFingerprint = fp;
  memory.cacheState = 'fresh';
  return true;
}

/**
 * 判断等锁结束后的磁盘快照是否足以替代本方的这次刷新。
 * 必须对齐「当前最新 manifest」，否则采纳的是过期快照；
 * 本方要求 full 时，只有对方在本次等待期间新发布了全量快照才等价。
 * @param {object|null} diskCache
 * @param {{ sourceId: string, manifest: object, full: boolean, revisionBeforeWait?: number }} expectation
 * @returns {boolean}
 */
function canAdoptDiskSnapshot(diskCache, { sourceId, manifest, full, revisionBeforeWait = -1 }) {
  if (!diskCache || diskCache.sourceId !== sourceId) return false;
  // 数据库 schema 身份（dev/ino/schema_version）不同视为不同源快照，必须自行重建
  if (JSON.stringify(diskCache.manifest?.identity) !== JSON.stringify(manifest?.identity)) {
    return false;
  }
  if (!manifestsEqual(
    manifestKeyMap(diskCache.manifest),
    manifestKeyMap(manifest)
  )) return false;
  if (full) {
    if (diskCache.buildMode !== 'full') return false;
    // buildMode 只能说明快照曾经由 full 产生；revision 必须在本次等待期间前进，
    // 才能证明它是持锁方刚发布的结果，而不是等待前遗留的旧 full 快照。
    const currentRevision = Number.isFinite(diskCache.revision) ? diskCache.revision : -1;
    if (currentRevision <= revisionBeforeWait) return false;
  }
  return true;
}

/**
 * 执行增量或全量刷新并发布新快照。
 * 跨进程：先抢锁；未拿到则 wait-for-lock 后读盘，仅当磁盘快照对齐最新 manifest
 * （full 时还需对方也是全量重建）才采纳，否则本方重新抢锁自行构建（规格选项 A）。
 * @param {{ full?: boolean }} options
 */
async function executeRefresh({ full = false } = {}) {
  const pricingConfig = await loadPricingConfig();
  const fp = buildPricingFingerprint(pricingConfig);
  const sourceId = computeSourceId(getSqlitePath());
  let scan = rescanManifest();

  if (!scan.exists) {
    handleMissingDatabase(sourceId, pricingConfig, fp);
    return;
  }

  // OpenClaw 升级改表（schema_version 变化）时强制全量重建
  const schemaChanged =
    !!memory.manifest?.identity &&
    JSON.stringify(memory.manifest.identity) !== JSON.stringify(scan.identity);
  if (schemaChanged && !full) {
    full = true;
  }

  const writable = await isCacheWritable();
  if (!writable) {
    persistenceUnavailable = true;
    console.warn('[stats-service] 缓存目录不可写，仅使用进程内缓存');
    await buildSnapshot({ full, sourceId, manifest: scan, pricingConfig, fp });
    return;
  }
  persistenceUnavailable = false;

  // full 等待方需要证明等锁后读到的是本轮新发布的快照，而不是旧的 full 结果。
  const revisionBeforeWait = full
    ? ((await readDiskCache())?.revision ?? -1)
    : -1;
  let acquired = await tryAcquireLock();
  if (!acquired) {
    // 等待持锁方完成后再读盘，避免双方都先构建
    await waitForLockRelease();

    // 等待期间数据源可能又发生变化，必须以最新清单判断磁盘快照是否够新
    scan = rescanManifest();
    if (!scan.exists) {
      handleMissingDatabase(sourceId, pricingConfig, fp);
      return;
    }

    const refreshed = await readDiskCache();
    if (canAdoptDiskSnapshot(refreshed, {
      sourceId,
      manifest: scan,
      full,
      revisionBeforeWait,
    })) {
      adoptDiskCache(refreshed, pricingConfig, fp);
      return;
    }

    // 磁盘快照落后于最新源，或本方要求 full 而磁盘只是增量结果：重新抢锁自行构建
    acquired = await tryAcquireLock();
    if (!acquired) {
      // full 语义不得被吞：抢不到锁时退化为仅进程内的全量构建
      if (memory.stats && !full) {
        memory.cacheState = 'stale';
        return;
      }
      await buildSnapshot({
        full,
        sourceId,
        manifest: scan,
        pricingConfig,
        fp,
      });
      return;
    }
  }

  const manifest = scan;
  try {
    const { filesMap, stats, revision, now } = await buildSnapshot({
      full,
      sourceId,
      manifest,
      pricingConfig,
      fp,
    });
    try {
      const diskPayload = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        statsShapeVersion: STATS_SHAPE_VERSION,
        sourceId,
        pricingFingerprint: fp,
        manifest,
        files: filesMap,
        stats,
        revision,
        // 标记本轮构建方式，供跨进程等待方判断 full 语义是否已满足
        buildMode: full ? 'full' : 'incremental',
        generatedAt: stats.generatedAt,
        checkedAt: now,
      };
      await writeDiskCacheAtomic(diskPayload);
    } catch (err) {
      console.warn('[stats-service] 写入持久化缓存失败:', err.message);
      memory.cacheState = memory.stats ? 'stale' : memory.cacheState;
    }
  } finally {
    await releaseLock();
  }
}

/**
 * 带去重的刷新入口。
 * 进行中的增量不得吞掉后续 full:true；全量会在增量结束后再跑。
 * @param {{ full?: boolean }} [options]
 */
function runRefresh(options = {}) {
  const wantFull = !!options.full;

  if (inflightRefresh) {
    if (wantFull && !inflightIsFull) {
      // 增量进行中：排队全量，保证故障恢复语义不被静默降级
      return inflightRefresh.catch(() => {}).then(() => runRefresh({ full: true }));
    }
    return inflightRefresh;
  }

  inflightIsFull = wantFull;
  const job = executeRefresh({ full: wantFull })
    .catch((err) => {
      console.warn('[stats-service] 刷新失败:', err.message);
      if (memory.stats) {
        memory.cacheState = 'stale';
      } else {
        throw err;
      }
    })
    .finally(() => {
      if (inflightRefresh === job) {
        inflightRefresh = null;
        inflightIsFull = false;
      }
    });

  inflightRefresh = job;
  return job;
}

/**
 * 后台调度增量刷新（不阻塞）
 */
function scheduleBackgroundRefresh() {
  if (inflightRefresh) return;
  runRefresh({ full: false }).catch(() => {});
}

/**
 * 尝试从磁盘/内存复用并决定是否需要刷新
 */
async function ensureLoaded(pricingConfig, fp, sourceId, manifestScan) {
  const { exists } = manifestScan;
  const manifest = manifestScan;

  if (memory.stats && memory.sourceId === sourceId) {
    const manifestMatch = manifestsEqual(memory.manifest, manifest);
    const pricingMatch = fingerprintsEqual(memory.pricingFingerprint, fp);

    if (manifestMatch && pricingMatch) {
      memory.cacheState = 'fresh';
      return true;
    }

    if (!pricingMatch) {
      memory.stats = attachPricingMeta(mergeFileContributions(memory.files, pricingConfig), pricingConfig);
      memory.pricingFingerprint = fp;
      if (manifestMatch) {
        memory.cacheState = 'fresh';
        return true;
      }
    }
    return false;
  }

  const diskCache = await readDiskCache();
  if (!diskCache || diskCache.sourceId !== sourceId) {
    return false;
  }

  loadMemoryFromDiskCache(diskCache);
  const manifestMatch = manifestsEqual(diskCache.manifest, manifest);

  // 定价与结果形状均未变化时直接复用磁盘上的统计结果，不重新合并贡献、不改写 generatedAt；
  // 仅定价变化或形状过期时重算，与内存命中路径保持一致
  if (!canReuseDiskStats(diskCache, fp)) {
    memory.stats = attachPricingMeta(
      mergeFileContributions(memory.files, pricingConfig),
      pricingConfig
    );
  }
  memory.pricingFingerprint = fp;

  if (manifestMatch) {
    memory.cacheState = 'fresh';
    return true;
  }

  if (!exists && Object.keys(memory.files).length > 0) {
    memory.cacheState = 'stale';
    return true;
  }

  return false;
}

/**
 * 获取（必要时重算）聚合统计
 * @param {{ forceFresh?: boolean, waitForRefresh?: boolean }} [options]
 *   forceFresh：强制绕过缓存短路，总是执行一次增量刷新后再返回；
 *   waitForRefresh：仅在检测到变化时等待刷新完成（对应 HTTP `?fresh=1`）。
 */
async function getLocalStats({ forceFresh = false, waitForRefresh = false } = {}) {
  const pricingConfig = await loadPricingConfig();
  const fp = buildPricingFingerprint(pricingConfig);
  const sourceId = computeSourceId(getSqlitePath());
  const manifestScan = await getManifestCoalesced();
  const checkedAt = new Date().toISOString();

  const loaded = await ensureLoaded(pricingConfig, fp, sourceId, manifestScan);

  // forceFresh 契约：真正走刷新路径，不因缓存 fresh 而短路
  if (forceFresh) {
    await runRefresh({ full: false });
    if (!memory.stats) {
      throw new Error('无法构建统计缓存');
    }
    return wrapStatsResponse(memory.stats, {
      state: memory.cacheState,
      revision: memory.revision,
      sourceId,
      checkedAt: new Date().toISOString(),
    });
  }

  if (loaded && !waitForRefresh) {
    return wrapStatsResponse(memory.stats, {
      state: memory.cacheState,
      revision: memory.revision,
      sourceId,
      checkedAt,
    });
  }

  if (loaded && memory.cacheState === 'fresh' && waitForRefresh) {
    return wrapStatsResponse(memory.stats, {
      state: 'fresh',
      revision: memory.revision,
      sourceId,
      checkedAt,
    });
  }

  if (memory.stats && !loaded) {
    if (waitForRefresh) {
      await runRefresh({ full: false });
      return wrapStatsResponse(memory.stats, {
        state: memory.cacheState,
        revision: memory.revision,
        sourceId,
        checkedAt: new Date().toISOString(),
      });
    }
    scheduleBackgroundRefresh();
    return wrapStatsResponse(memory.stats, {
      state: 'refreshing',
      revision: memory.revision,
      sourceId,
      checkedAt,
    });
  }

  if (!manifestScan.exists && !memory.stats) {
    const empty = attachPricingMeta(buildEmptyStats(), pricingConfig);
    memory.stats = empty;
    memory.files = {};
    memory.manifest = {};
    memory.revision = 0;
    memory.sourceId = sourceId;
    memory.pricingFingerprint = fp;
    memory.cacheState = 'fresh';
    return wrapStatsResponse(empty, {
      state: 'fresh',
      revision: 0,
      sourceId,
      checkedAt,
    });
  }

  if (!manifestScan.exists && memory.stats) {
    memory.cacheState = 'stale';
    return wrapStatsResponse(memory.stats, {
      state: 'stale',
      revision: memory.revision,
      sourceId,
      checkedAt,
    });
  }

  await runRefresh({ full: !memory.stats && !await readDiskCache() });
  if (!memory.stats) {
    throw new Error('无法构建统计缓存');
  }

  return wrapStatsResponse(memory.stats, {
    state: memory.cacheState,
    revision: memory.revision,
    sourceId,
    checkedAt: new Date().toISOString(),
  });
}

const IMPORT_SUBDIR = 'cache/openclaw-usage/imports';

function importedSnapshotPath(sourceId) {
  return join(getOpenClawConfigDir(), IMPORT_SUBDIR, `${sourceId}.json`);
}

function receivedAtForSnapshot(snapshot) {
  try {
    return new Date(statSync(importedSnapshotPath(snapshot.source.id)).mtimeMs).toISOString();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // A receiver may replace/remove a file between directory enumeration and
      // metadata lookup. The snapshot was still validated and is safe to use;
      // generatedAt is a conservative last-good timestamp for this response.
      return snapshot.generatedAt;
    }
    throw new Error('unable to read imported snapshots');
  }
}

function addSourceInfo(source, kind, metadata = {}) {
  return {
    id: source.id,
    label: source.label,
    kind,
    status: metadata.status || 'fresh',
    stale: metadata.status === 'stale',
    lastReceivedAt: metadata.lastReceivedAt ?? null,
    generatedAt: metadata.generatedAt ?? null,
    staleSince: metadata.staleSince ?? null,
    revision: metadata.revision ?? null,
  };
}

function canonicalSnapshotIdentity(snapshot) {
  const compareUtf16 = (left, right) => {
    const a = String(left);
    const b = String(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const leftCode = a.charCodeAt(index);
      const rightCode = b.charCodeAt(index);
      if (leftCode < rightCode) return -1;
      if (leftCode > rightCode) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  };
  const contributions = snapshot.contributions
    .map((contribution) => ({
      contributionId: contribution.contributionId,
      session: {
        id: contribution.session.id,
        status: contribution.session.status,
        archivedAt: contribution.session.archivedAt,
      },
      firstTimestamp: contribution.firstTimestamp,
      lastTimestamp: contribution.lastTimestamp,
      buckets: contribution.buckets
        .map((bucket) => ({
          date: bucket.date,
          provider: bucket.provider,
          model: bucket.model,
          usage: {
            input: bucket.usage.input,
            output: bucket.usage.output,
            cacheRead: bucket.usage.cacheRead,
            cacheWrite: bucket.usage.cacheWrite,
            totalTokens: bucket.usage.totalTokens,
          },
          openclawCost: {
            input: bucket.openclawCost.input,
            output: bucket.openclawCost.output,
            cacheRead: bucket.openclawCost.cacheRead,
            cacheWrite: bucket.openclawCost.cacheWrite,
            total: bucket.openclawCost.total,
          },
          requests: bucket.requests,
        }))
        .sort((a, b) => compareUtf16(JSON.stringify(a), JSON.stringify(b))),
      hasRecords: contribution.hasRecords,
    }))
    .sort((a, b) => compareUtf16(a.contributionId, b.contributionId));
  return {
    version: snapshot.version,
    kind: snapshot.kind,
    scope: snapshot.scope,
    source: { id: snapshot.source.id, label: snapshot.source.label },
    revision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    contributions,
  };
}

function buildCombinedRevision({ localResponse, pricingConfig, syncConfig, importedById }) {
  const imports = syncConfig.imports.allowedSourceIds.map((sourceId) => {
    const imported = importedById.get(sourceId);
    return imported
      ? {
          sourceId,
          state: 'present',
          receivedAt: imported.lastReceivedAt,
          snapshot: canonicalSnapshotIdentity(imported.snapshot),
        }
      : { sourceId, state: 'missing', receivedAt: null, snapshot: null };
  });
  const identity = {
    local: {
      source: {
        id: syncConfig.source.id,
        label: syncConfig.source.label,
      },
      revision: localResponse.cache?.revision ?? 0,
      sourceId: localResponse.cache?.sourceId ?? '',
      pricing: buildPricingFingerprint(pricingConfig),
    },
    imports,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function statsForContributions(files, pricingConfig) {
  return attachPricingMeta(mergeFileContributions(files, pricingConfig), pricingConfig);
}

/**
 * Build the public multi-source view from the local pricing-independent cache
 * and durable imported snapshots. Imports are loaded on each response so a
 * successful receive, replacement, or removal is visible on the next request
 * without polluting the local stats-v1 cache with foreign identities.
 */
export async function getStats(options = {}) {
  const localResponse = await getLocalStats(options);
  const pricingConfig = await loadPricingConfig();
  const syncConfig = await loadSyncConfig();
  const publicSync = await getPublicSyncConfig({ syncConfig });
  const snapshots = await loadImportedSnapshots({ syncConfig });
  const localSource = syncConfig.source;
  const hasSyncConfig = existsSync(join(getOpenClawConfigDir(), SYNC_CONFIG_FILENAME));
  const localFiles = hasSyncConfig || snapshots.length > 0
    ? namespaceFileContributions(memory.files, localSource.id, localSource.label)
    : memory.files;

  const localStats = {
    ...statsForContributions(localFiles, pricingConfig),
    generatedAt: localResponse.generatedAt,
  };
  const allFiles = Object.create(null);
  Object.assign(allFiles, localFiles);
  const importedById = new Map();
  for (const snapshot of snapshots) {
    const source = snapshot.source;
    const files = namespaceFileContributions(
      Object.fromEntries(snapshot.contributions.map((contribution) => [
        contribution.contributionId,
        contribution,
      ])),
      source.id,
      source.label,
      { imported: true }
    );
    Object.assign(allFiles, files);
    importedById.set(source.id, {
      snapshot,
      files,
      lastReceivedAt: receivedAtForSnapshot(snapshot),
    });
  }

  const statsBySource = Object.create(null);
  statsBySource[localSource.id] = localStats;
  const now = Date.now();
  const sources = [addSourceInfo(localSource, 'local', {
    status: localResponse.cache?.state === 'stale' ? 'stale' : 'fresh',
    generatedAt: localStats.generatedAt,
  })];

  for (const sourceId of syncConfig.imports.allowedSourceIds) {
    const imported = importedById.get(sourceId);
    if (!imported) {
      statsBySource[sourceId] = attachPricingMeta(buildEmptyStats(), pricingConfig);
      sources.push(addSourceInfo({ id: sourceId, label: sourceId }, 'imported', {
        status: 'missing',
      }));
      continue;
    }
    const generatedAt = imported.snapshot.generatedAt;
    const lastReceivedAt = imported.lastReceivedAt;
    const staleSinceMs = Date.parse(lastReceivedAt)
      + syncConfig.settings.intervalMinutes * 60 * 1000;
    const staleSince = new Date(staleSinceMs).toISOString();
    const status = now >= staleSinceMs ? 'stale' : 'fresh';
    statsBySource[sourceId] = statsForContributions(imported.files, pricingConfig);
    sources.push(addSourceInfo(imported.snapshot.source, 'imported', {
      status,
      lastReceivedAt,
      generatedAt,
      staleSince,
      revision: imported.snapshot.revision,
    }));
  }

  const combined = {
    ...statsForContributions(allFiles, pricingConfig),
    // Preserve the existing local-cache generatedAt contract for callers that
    // use it as a cache identity. Imported freshness is represented separately
    // by source metadata and durable snapshot identity.
    generatedAt: localResponse.generatedAt,
  };
  return {
    ...wrapStatsResponse(combined, {
      ...localResponse.cache,
      combinedRevision: buildCombinedRevision({
        localResponse,
        pricingConfig,
        syncConfig,
        importedById,
      }),
    }),
    instance: {
      source: publicSync.source,
      settings: publicSync.settings,
      capabilities: publicSync.capabilities,
    },
    sources,
    statsBySource,
  };
}

/**
 * 使最终聚合统计失效（保留逐文件贡献）
 */
export function invalidateStatsCache() {
  memory.pricingFingerprint = null;
}

/**
 * 重置内存状态（测试用）
 */
export function resetStatsServiceForTests() {
  memory = {
    stats: null,
    files: {},
    manifest: {},
    revision: 0,
    sourceId: '',
    pricingFingerprint: null,
    cacheState: 'fresh',
  };
  inflightRefresh = null;
  inflightIsFull = false;
  lastManifestScan = null;
  persistenceUnavailable = false;
}

/**
 * 读取价格配置
 */
export async function getPricingConfig() {
  return loadPricingConfig();
}

/**
 * 更新价格配置并失效聚合结果
 * @param {object} config
 */
export async function updatePricingConfig(config) {
  validatePricingConfig(config);
  await savePricingConfig(config);
  invalidateStatsCache();
  return {
    ok: true,
    updated: config.updated,
  };
}

/**
 * 刷新统计缓存
 * @param {{ full?: boolean }} [options]
 */
export async function refreshStatsCache({ full = false } = {}) {
  await runRefresh({ full });
  const data = memory.stats;
  if (!data) {
    throw new Error('刷新后无可用统计');
  }
  return {
    ok: true,
    generatedAt: data.generatedAt,
    pricingVersion: data.pricingVersion,
    cache: {
      state: memory.cacheState,
      revision: memory.revision,
      sourceId: memory.sourceId,
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Return the current local, pricing-independent per-file contributions.
 *
 * The sync transport calls this after a normal incremental refresh so the
 * exported wire snapshot is built from the same memory/disk cache used by
 * Web and MCP. No pricing result, manifest identity, or source path is
 * included in this narrow boundary.
 */
export async function getLocalContributionCache() {
  await refreshStatsCache({ full: false });
  if (memory.cacheState !== 'fresh') {
    throw new Error('local contribution cache is not fresh');
  }
  const diskCache = await readDiskCache();
  const useMemory = !!memory.stats || !!memory.sourceId;
  const files = useMemory
    ? memory.files
    : (diskCache?.files || {});
  return {
    files: { ...files },
    revision: memory.revision || diskCache?.revision || 0,
    generatedAt: memory.stats?.generatedAt || diskCache?.generatedAt || new Date().toISOString(),
    cacheState: memory.cacheState,
  };
}

/** 测试与诊断用 */
export function __getMemoryState() {
  return { ...memory, persistenceUnavailable };
}

/** 测试用：强制释放锁文件 */
export async function __forceReleaseLockForTests() {
  try {
    await unlink(getLockFilePath());
  } catch {
    // ignore
  }
}
