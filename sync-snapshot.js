import { createHash, randomBytes } from 'crypto';
import { constants } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './openclaw-config.js';
import { loadSyncConfig } from './sync-config.js';

export const SOURCE_SNAPSHOT_VERSION = 1;
export const SOURCE_SNAPSHOT_KIND = 'openclaw-usage-source-contributions';
export const SOURCE_SNAPSHOT_SCOPE = 'local-only';
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_CONTRIBUTIONS = 10_000;
export const MAX_BUCKETS_PER_CONTRIBUTION = 10_000;
export const MAX_SNAPSHOT_TEXT_LENGTH = 512;
// Every accepted snapshot can contain at most this many numeric bucket values.
// Keep each value below this bound so a worst-case aggregate remains a safe
// JavaScript number instead of becoming Infinity or an unsafe integer.
export const MAX_SAFE_SNAPSHOT_VALUE = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_CONTRIBUTIONS * MAX_BUCKETS_PER_CONTRIBUTION)
);

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUSES = new Set(['active', 'done', 'reset', 'deleted']);
const IMPORT_SUBDIR = 'cache/openclaw-usage/imports';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function safeText(value, max = MAX_SNAPSHOT_TEXT_LENGTH) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function strictIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validNullableTimestamp(value) {
  return value === null || validTimestamp(value);
}

function normalizeWireTimestamp(value) {
  let epochMilliseconds;
  if (typeof value === 'string' && /^\d{13}$/.test(value)) {
    epochMilliseconds = Number(value);
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    epochMilliseconds = value;
  } else if (typeof value === 'string') {
    epochMilliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(epochMilliseconds)) return null;
  const date = new Date(epochMilliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validCounter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validSafeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_SNAPSHOT_VALUE;
}

function validSafeCost(value) {
  return validCounter(value) && value <= MAX_SAFE_SNAPSHOT_VALUE;
}

function validRequestCount(value) {
  return validSafeCounter(value);
}

function invalidSnapshot(message = 'invalid source snapshot') {
  return new Error(message);
}

function sourceImportDir(options = {}) {
  if (typeof options.importDir === 'string' && options.importDir) return options.importDir;
  return join(options.configDir || getOpenClawConfigDir(), IMPORT_SUBDIR);
}

function sourceSnapshotPath(sourceId, options = {}) {
  // sourceId has already passed strictIdentifier in validation. Never accept a
  // caller-provided path or filename for imported snapshots.
  return join(sourceImportDir(options), `${sourceId}.json`);
}

function sourceConfig(options = {}) {
  if (options.syncConfig !== undefined) return options.syncConfig;
  if (options.config !== undefined) return options.config;
  return null;
}

const NO_FOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

/**
 * Read at most MAX_SNAPSHOT_BYTES plus one byte, and require a regular file
 * before opening it. The O_NOFOLLOW flag also closes the lstat/open race on
 * platforms that provide it.
 */
async function readBoundedSnapshotFile(filepath, fileSize, openFile = open) {
  if (!Number.isSafeInteger(fileSize) || fileSize > MAX_SNAPSHOT_BYTES) return null;

  let handle;
  try {
    handle = await openFile(filepath, NO_FOLLOW_FLAGS);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP' || err.code === 'ENOTDIR') return null;
    throw new Error('unable to read imported snapshots');
  }

  try {
    const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > bytes.length - total) {
        throw new Error('invalid imported snapshot read');
      }
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > MAX_SNAPSHOT_BYTES) return null;
    return bytes.subarray(0, total).toString('utf8');
  } catch {
    throw new Error('unable to read imported snapshots');
  } finally {
    await handle.close();
  }
}

/** Test seam for exercising short-read behavior without changing the public API. */
export function __readBoundedSnapshotFileForTests(filepath, fileSize, openFile) {
  return readBoundedSnapshotFile(filepath, fileSize, openFile);
}

function numberOrZero(value) {
  return validCounter(value) ? value : 0;
}

function mapUsage(usage = {}) {
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite),
    totalTokens: numberOrZero(usage.totalTokens),
  };
}

function mapOpenClawCost(cost = {}) {
  return {
    input: numberOrZero(cost.input),
    output: numberOrZero(cost.output),
    cacheRead: numberOrZero(cost.cacheRead),
    cacheWrite: numberOrZero(cost.cacheWrite),
    total: numberOrZero(cost.total),
  };
}

function mapContribution(fileKey, contribution) {
  const session = contribution?.session || {};
  const contributionId = createHash('sha256')
    .update('openclaw-usage-source-contribution\0')
    .update(fileKey)
    .digest('hex');

  return {
    contributionId,
    session: {
      id: typeof session.id === 'string' ? session.id : 'unknown',
      status: typeof session.status === 'string' ? session.status : 'active',
      archivedAt: normalizeWireTimestamp(session.archivedAt),
    },
    firstTimestamp: normalizeWireTimestamp(contribution?.firstTimestamp),
    lastTimestamp: normalizeWireTimestamp(contribution?.lastTimestamp),
    buckets: Array.isArray(contribution?.buckets)
      ? contribution.buckets.map((bucket) => ({
          date: bucket?.date ?? null,
          provider: typeof bucket?.provider === 'string' ? bucket.provider : 'unknown',
          model: typeof bucket?.model === 'string' ? bucket.model : 'unknown',
          usage: mapUsage(bucket?.usage),
          openclawCost: mapOpenClawCost(bucket?.openclawCost),
          requests: numberOrZero(bucket?.requests),
        }))
      : [],
    hasRecords: contribution?.hasRecords === true,
  };
}

function getCacheFiles(cacheSnapshot) {
  if (assertObject(cacheSnapshot?.files)) return cacheSnapshot.files;
  if (assertObject(cacheSnapshot)) return cacheSnapshot;
  return {};
}

/**
 * Convert the local persistent cache's file contributions to the deliberately
 * small, pricing-independent wire/storage schema. The source filename and
 * file identity are used only as local inputs to an opaque contribution ID.
 *
 * @param {object} cacheSnapshot disk cache or { files, revision, generatedAt }
 * @param {object} syncConfig validated sync config
 * @returns {object}
 */
export function buildSourceSnapshot(cacheSnapshot, syncConfig) {
  const source = syncConfig?.source;
  if (!source || !strictIdentifier(source.id) || !safeText(source.label)) {
    throw invalidSnapshot('invalid source config');
  }
  const files = getCacheFiles(cacheSnapshot);
  const fileKeys = Object.keys(files).sort();
  const contributions = fileKeys.map((fileKey) => mapContribution(fileKey, files[fileKey]));
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        sourceId: source.id,
        revision: cacheSnapshot?.revision ?? '',
        contributionIds: contributions.map((contribution) => contribution.contributionId),
      })
    )
    .digest('hex');

  return {
    version: SOURCE_SNAPSHOT_VERSION,
    kind: SOURCE_SNAPSHOT_KIND,
    scope: SOURCE_SNAPSHOT_SCOPE,
    source: { id: source.id, label: source.label },
    revision,
    generatedAt:
      typeof cacheSnapshot?.generatedAt === 'string' && validTimestamp(cacheSnapshot.generatedAt)
        ? cacheSnapshot.generatedAt
        : new Date().toISOString(),
    contributions,
  };
}

function validateBucket(bucket) {
  if (!assertObject(bucket)) throw invalidSnapshot('invalid source snapshot bucket');
  if (!assertObject(bucket.usage) || !Object.values(bucket.usage).every(validSafeCounter)) {
    throw invalidSnapshot('source snapshot counters must be finite, non-negative, and safe to aggregate');
  }
  if (!assertObject(bucket.openclawCost) || !Object.values(bucket.openclawCost).every(validSafeCost)) {
    throw invalidSnapshot('source snapshot costs must be finite, non-negative, and safe to aggregate');
  }
  if (
    !hasOnlyKeys(bucket, ['date', 'provider', 'model', 'usage', 'openclawCost', 'requests']) ||
    // 允许日级（旧快照）或 UTC 小时级（"YYYY-MM-DDTHH"，v3 起）桶键
    (bucket.date !== null && !/^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(bucket.date)) ||
    !safeText(bucket.provider) ||
    !safeText(bucket.model) ||
    !hasOnlyKeys(bucket.usage, ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) ||
    !hasOnlyKeys(bucket.openclawCost, ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) ||
    !validRequestCount(bucket.requests)
  ) {
    throw invalidSnapshot('invalid source snapshot bucket');
  }
}

function validateContribution(contribution) {
  if (
    !assertObject(contribution) ||
    !hasOnlyKeys(contribution, [
      'contributionId',
      'session',
      'firstTimestamp',
      'lastTimestamp',
      'buckets',
      'hasRecords',
    ]) ||
    !safeText(contribution.contributionId, 128) ||
    !assertObject(contribution.session) ||
    !hasOnlyKeys(contribution.session, ['id', 'status', 'archivedAt']) ||
    !safeText(contribution.session.id) ||
    !STATUSES.has(contribution.session.status) ||
    !validNullableTimestamp(contribution.session.archivedAt) ||
    !validNullableTimestamp(contribution.firstTimestamp) ||
    !validNullableTimestamp(contribution.lastTimestamp) ||
    !Array.isArray(contribution.buckets) ||
    contribution.buckets.length > MAX_BUCKETS_PER_CONTRIBUTION ||
    typeof contribution.hasRecords !== 'boolean'
  ) {
    throw invalidSnapshot('invalid source snapshot contribution');
  }
  for (const bucket of contribution.buckets) validateBucket(bucket);
}

/**
 * Validate a source snapshot independently of SSH/transport. Only an explicitly
 * configured import source is authorized; this keeps a receiver fail-closed.
 *
 * @param {object} value
 * @param {object} syncConfig receiver sync config
 * @returns {true}
 */
export function validateSourceSnapshot(value, syncConfig) {
  if (!assertObject(value)) throw invalidSnapshot();
  if (!hasOnlyKeys(value, ['version', 'kind', 'scope', 'source', 'revision', 'generatedAt', 'contributions'])) {
    throw invalidSnapshot('unknown source snapshot field');
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw invalidSnapshot('source snapshot size exceeds limit');
    }
  } catch (err) {
    if (err?.message === 'source snapshot size exceeds limit') throw err;
    throw invalidSnapshot();
  }
  if (value.version !== SOURCE_SNAPSHOT_VERSION) throw invalidSnapshot('unsupported source snapshot version');
  if (value.kind !== SOURCE_SNAPSHOT_KIND || value.scope !== SOURCE_SNAPSHOT_SCOPE) {
    throw invalidSnapshot('invalid source snapshot kind or scope');
  }
  if (
    !assertObject(value.source) ||
    !hasOnlyKeys(value.source, ['id', 'label']) ||
    !strictIdentifier(value.source.id) ||
    !safeText(value.source.label) ||
    !safeText(value.revision, 128) ||
    !validTimestamp(value.generatedAt) ||
    !Array.isArray(value.contributions)
  ) {
    throw invalidSnapshot();
  }
  if (value.contributions.length > MAX_CONTRIBUTIONS) {
    throw invalidSnapshot('source snapshot contributions exceed limit');
  }

  const allowedSourceIds = syncConfig?.imports?.allowedSourceIds;
  if (!Array.isArray(allowedSourceIds) || !allowedSourceIds.includes(value.source.id)) {
    throw invalidSnapshot('unauthorized source snapshot');
  }

  const contributionIds = new Set();
  for (const contribution of value.contributions) {
    validateContribution(contribution);
    if (contributionIds.has(contribution.contributionId)) {
      throw invalidSnapshot('duplicate source snapshot contribution');
    }
    contributionIds.add(contribution.contributionId);
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidSnapshot();
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw invalidSnapshot('source snapshot size exceeds limit');
  }
  return true;
}

/**
 * Atomically replace the last good imported snapshot for its source. Validation
 * happens before creating or renaming anything, so malformed input cannot
 * overwrite a successful prior receive.
 *
 * @param {object} value
 * @param {{configDir?: string, importDir?: string, syncConfig?: object}} [options]
 * @returns {Promise<{ok: true, sourceId: string, revision: string, generatedAt: string}>}
 */
export async function storeImportedSnapshot(value, options = {}) {
  const config = sourceConfig(options) || (await loadSyncConfig(options));
  validateSourceSnapshot(value, config);

  const directory = sourceImportDir(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = sourceSnapshotPath(value.source.id, options);
  const temporary = join(
    directory,
    `.${value.source.id}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  );

  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw new Error('source snapshot size exceeds limit');
    }
    await writeFile(temporary, serialized, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup; the last complete snapshot remains in place.
    }
    throw new Error('unable to store source snapshot');
  }

  return {
    ok: true,
    sourceId: value.source.id,
    revision: value.revision,
    generatedAt: value.generatedAt,
  };
}

/**
 * Load all valid, allowlisted imported snapshots. Corrupt or incompatible
 * files are ignored, leaving the last valid snapshot for every other source
 * available; no local path or filename is returned.
 *
 * @param {{configDir?: string, importDir?: string, syncConfig?: object}} [options]
 * @returns {Promise<object[]>}
 */
export async function loadImportedSnapshots(options = {}) {
  const config = sourceConfig(options) || (await loadSyncConfig(options));
  const directory = sourceImportDir(options);
  let names;
  try {
    names = await readdir(directory);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('unable to read imported snapshots');
  }

  const snapshots = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const sourceId = name.slice(0, -'.json'.length);
    if (!strictIdentifier(sourceId)) continue;
    let parsed;
    const filepath = join(directory, name);
    try {
      const info = await lstat(filepath);
      if (!info.isFile()) continue;
      const raw = await readBoundedSnapshotFile(filepath, info.size);
      if (raw === null) continue;
      parsed = JSON.parse(raw);
      if (parsed?.source?.id !== sourceId) continue;
      validateSourceSnapshot(parsed, config);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (err.message === 'unable to read imported snapshots') throw err;
      if (err.code) throw new Error('unable to read imported snapshots');
      // Corrupt, incompatible, unauthorized, and schema-invalid snapshots do
      // not replace or hide any other valid source snapshot.
      continue;
    }
    snapshots.push(clone(parsed));
  }
  return snapshots;
}
