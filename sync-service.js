import { randomBytes } from 'crypto';
import { execFile as nodeExecFile } from 'child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getOpenClawConfigDir } from './openclaw-config.js';
import { loadSyncConfig } from './sync-config.js';
import {
  buildSourceSnapshot,
  MAX_SNAPSHOT_BYTES,
  storeImportedSnapshot,
} from './sync-snapshot.js';
import { getLocalContributionCache as defaultGetLocalContributionCache } from './stats-service.js';

export const SSH_TIMEOUT_MS = 30_000;
export const SSH_CONNECT_TIMEOUT_SECONDS = 15;
export const MAX_SYNC_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES;
export const SYNC_STATUS_VERSION = 1;
export const SYNC_STATUS_FILENAME = 'sync-status.json';
export const SYNC_PROBE_ENVELOPE = Object.freeze({
  version: 1,
  kind: 'openclaw-usage-sync-probe',
  scope: 'transport-only',
});

const STATUS_SUBDIR = 'run/openclaw-usage';
const SSH_MAX_BUFFER_BYTES = 1024 * 1024;

function statusPath(options = {}) {
  if (typeof options.statusPath === 'string' && options.statusPath) return options.statusPath;
  const configDir = options.configDir
    || (typeof options.configPath === 'string' && options.configPath ? dirname(options.configPath) : null)
    || getOpenClawConfigDir();
  return join(configDir, STATUS_SUBDIR, SYNC_STATUS_FILENAME);
}

function invalidSyncError(message, code = 'SYNC_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSyncProbe(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.version === SYNC_PROBE_ENVELOPE.version
    && value.kind === SYNC_PROBE_ENVELOPE.kind
    && value.scope === SYNC_PROBE_ENVELOPE.scope;
}

function defaultStatus() {
  return {
    version: SYNC_STATUS_VERSION,
    targetId: null,
    lastAttempt: null,
    lastSuccess: null,
    failureSince: null,
    error: null,
  };
}

function validStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['version', 'targetId', 'lastAttempt', 'lastSuccess', 'failureSince', 'error'];
  if (Object.keys(value).some((key) => !fields.includes(key))) return false;
  if (value.version !== SYNC_STATUS_VERSION) return false;
  if (value.targetId !== null && typeof value.targetId !== 'string') return false;
  for (const field of ['lastAttempt', 'lastSuccess', 'failureSince']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field])))) {
      return false;
    }
  }
  return value.error === null || typeof value.error === 'string';
}

async function readStatus(options = {}) {
  try {
    const raw = await readFile(statusPath(options), 'utf8');
    const parsed = JSON.parse(raw);
    return validStatus(parsed) ? parsed : defaultStatus();
  } catch (err) {
    if (err.code === 'ENOENT') return defaultStatus();
    return defaultStatus();
  }
}

async function writeStatus(status, options = {}) {
  const destination = statusPath(options);
  const directory = join(destination, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.${SYNC_STATUS_FILENAME}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (err) {
    try { await unlink(temporary); } catch { /* best effort */ }
    throw invalidSyncError('unable to persist sync status', 'SYNC_STATUS_WRITE_FAILED');
  }
}

function safeSshFailure(error) {
  if (error?.code === 'ETIMEDOUT' || error?.killed || error?.signal === 'SIGTERM') {
    return invalidSyncError('SSH transport timed out', 'SSH_TIMEOUT');
  }
  if (Number.isInteger(error?.code)) {
    return invalidSyncError(`SSH receiver exited with code ${error.code}`, 'SSH_EXIT');
  }
  if (typeof error?.signal === 'string') {
    return invalidSyncError(`SSH receiver terminated by ${error.signal}`, 'SSH_SIGNAL');
  }
  return invalidSyncError('SSH transport failed', 'SSH_FAILED');
}

function targetFor(config, requestedTargetId) {
  const targetId = requestedTargetId === undefined ? config.settings.targetId : requestedTargetId;
  if (targetId === null || targetId === undefined || targetId === '') {
    throw invalidSyncError('sync disabled: no target configured', 'SYNC_DISABLED');
  }
  if (typeof targetId !== 'string' || !Object.hasOwn(config.policy.allowedSshTargets, targetId)) {
    throw invalidSyncError('sync target is not allowlisted', 'SYNC_TARGET_NOT_ALLOWED');
  }
  return { targetId, target: config.policy.allowedSshTargets[targetId] };
}

function sshArgs(sshAlias) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    sshAlias,
    'openclaw-usage',
    'receive-sync',
  ];
}

function executeSsh(sshAlias, payload, options = {}) {
  const execFile = options.execFile || nodeExecFile;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(safeSshFailure(error));
        return;
      }
      resolve({ stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
    };

    let child;
    try {
      child = execFile(
        'ssh',
        sshArgs(sshAlias),
        {
          timeout: SSH_TIMEOUT_MS,
          maxBuffer: SSH_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        finish
      );
    } catch (error) {
      finish(error);
      return;
    }

    if (!child?.stdin || typeof child.stdin.end !== 'function') {
      finish(invalidSyncError('SSH transport did not provide stdin', 'SSH_FAILED'));
      return;
    }
    try {
      child.stdin.end(payload === null ? undefined : payload);
    } catch (error) {
      finish(error);
    }
  });
}

async function getConfig(options = {}) {
  return loadSyncConfig(options);
}

async function getOutboundSnapshot(config, options = {}) {
  let cache;
  if (options.getLocalContributionCache) {
    const refreshStatsCache = options.refreshStatsCache || (async () => {});
    await refreshStatsCache();
    cache = await options.getLocalContributionCache();
  } else {
    // The narrow stats-service boundary refreshes first, then reads the
    // pricing-independent memory/disk contribution map exactly once.
    cache = await defaultGetLocalContributionCache();
  }
  if (cache?.cacheState !== undefined && cache.cacheState !== 'fresh') {
    throw invalidSyncError('local contribution cache is not fresh', 'SYNC_CACHE_NOT_FRESH');
  }
  return buildSourceSnapshot(cache, config);
}

async function recordFailure(options, targetId, error, previousStatus) {
  const now = new Date().toISOString();
  const status = {
    ...defaultStatus(),
    ...previousStatus,
    targetId,
    lastAttempt: previousStatus?.lastAttempt || now,
    failureSince: previousStatus?.failureSince || now,
    error: error.message,
  };
  await writeStatus(status, options);
  return status;
}

/**
 * Push one complete local contribution snapshot to one pre-authorized target.
 * A run performs no retries; callers/schedulers decide when to run again.
 */
export async function syncToTarget(requestedTargetId, options = {}) {
  const config = await getConfig(options);
  if (options.scheduled && config.settings.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      status: 'disabled',
      targetId: config.settings.targetId,
    };
  }
  const { targetId, target } = targetFor(config, requestedTargetId);
  const previousStatus = await readStatus(options);
  const attemptedAt = new Date().toISOString();
  await writeStatus({
    ...defaultStatus(),
    ...previousStatus,
    targetId,
    lastAttempt: attemptedAt,
    error: null,
  }, options);

  try {
    const snapshot = await getOutboundSnapshot(config, options);
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SYNC_SNAPSHOT_BYTES) {
      throw invalidSyncError('source snapshot size exceeds limit', 'SNAPSHOT_TOO_LARGE');
    }
    await executeSsh(target.sshAlias, serialized, options);
    const succeededAt = new Date().toISOString();
    await writeStatus({
      ...defaultStatus(),
      ...previousStatus,
      targetId,
      lastAttempt: attemptedAt,
      lastSuccess: succeededAt,
      failureSince: null,
      error: null,
    }, options);
    return {
      ok: true,
      targetId,
      sourceId: snapshot.source.id,
      revision: snapshot.revision,
      lastSuccess: succeededAt,
    };
  } catch (error) {
    const safeError = error?.code?.startsWith?.('SSH_')
      || error?.code === 'SNAPSHOT_TOO_LARGE'
      || error?.code === 'SYNC_CACHE_NOT_FRESH'
      ? error
      : invalidSyncError(error?.code === 'SYNC_STATUS_WRITE_FAILED' ? error.message : 'sync failed', error?.code || 'SYNC_FAILED');
    await recordFailure(options, targetId, safeError, {
      ...previousStatus,
      lastAttempt: attemptedAt,
    });
    throw safeError;
  }
}

/**
 * Read one bounded JSON snapshot from stdin and atomically store it.
 */
export async function receiveSync(input = process.stdin, options = {}) {
  let raw;
  if (Buffer.isBuffer(input)) {
    raw = input;
  } else if (typeof input === 'string' || input instanceof Uint8Array) {
    raw = Buffer.from(input);
  } else {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_SYNC_SNAPSHOT_BYTES) {
          throw invalidSyncError('source snapshot size exceeds limit', 'SNAPSHOT_TOO_LARGE');
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (error?.code === 'SNAPSHOT_TOO_LARGE') throw error;
      throw invalidSyncError('unable to read sync input', 'SYNC_INPUT_FAILED');
    }
    raw = Buffer.concat(chunks, size);
  }
  if (raw.byteLength > MAX_SYNC_SNAPSHOT_BYTES) {
    throw invalidSyncError('source snapshot size exceeds limit', 'SNAPSHOT_TOO_LARGE');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalidSyncError('invalid sync snapshot JSON', 'SYNC_INPUT_INVALID');
  }

  if (isSyncProbe(parsed)) return { ok: true, probe: true };

  const config = await getConfig(options);
  try {
    return await storeImportedSnapshot(parsed, { ...options, syncConfig: config });
  } catch (error) {
    if (/unable to store|invalid|unauthorized|unsupported|size|counter|snapshot/i.test(error?.message || '')) {
      throw invalidSyncError(error.message, 'SYNC_SNAPSHOT_INVALID');
    }
    throw invalidSyncError('unable to store sync snapshot', 'SYNC_STORE_FAILED');
  }
}

export async function getSyncStatus(options = {}) {
  const config = await getConfig(options);
  const status = await readStatus(options);
  return {
    ...status,
    enabled: config.settings.enabled,
    configuredTargetId: config.settings.targetId,
    outboundTargets: Object.entries(config.policy.allowedSshTargets).map(([id, target]) => ({
      id,
      label: target.label,
    })),
  };
}

/**
 * Probe the same fixed receiver command without exporting or writing a
 * contribution. This is intentionally one SSH invocation with no retry.
 */
export async function testSyncTarget(requestedTargetId, options = {}) {
  const config = await getConfig(options);
  const { targetId, target } = targetFor(config, requestedTargetId);
  await executeSsh(target.sshAlias, JSON.stringify(SYNC_PROBE_ENVELOPE), options);
  return { ok: true, targetId };
}

export { statusPath as getSyncStatusPath };
