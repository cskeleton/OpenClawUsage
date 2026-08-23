import { randomBytes } from 'crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './openclaw-config.js';

export const SYNC_CONFIG_VERSION = 1;
export const SYNC_CONFIG_FILENAME = 'openclaw-usage-sync.json';
export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
export const MIN_SYNC_INTERVAL_MINUTES = 1;
export const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LABEL_LENGTH = 120;
const RESERVED_SOURCE_ID = 'all';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configPath(options = {}) {
  if (typeof options.configPath === 'string' && options.configPath) return options.configPath;
  const configDir = options.configDir || getOpenClawConfigDir();
  return join(configDir, SYNC_CONFIG_FILENAME);
}

function assertObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function validLabel(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalidConfig() {
  return new Error('invalid sync config');
}

function validateSyncConfig(value) {
  if (
    !assertObject(value) ||
    !hasOnlyKeys(value, ['version', 'source', 'policy', 'settings', 'imports']) ||
    value.version !== SYNC_CONFIG_VERSION ||
    !assertObject(value.source) ||
    !hasOnlyKeys(value.source, ['id', 'label']) ||
    !validIdentifier(value.source.id) ||
    value.source.id === RESERVED_SOURCE_ID ||
    !validLabel(value.source.label) ||
    !assertObject(value.policy) ||
    !hasOnlyKeys(value.policy, ['allowedSshTargets']) ||
    !assertObject(value.policy.allowedSshTargets) ||
    !assertObject(value.settings) ||
    !hasOnlyKeys(value.settings, ['enabled', 'targetId', 'intervalMinutes']) ||
    typeof value.settings.enabled !== 'boolean' ||
    !Number.isInteger(value.settings.intervalMinutes) ||
    value.settings.intervalMinutes < MIN_SYNC_INTERVAL_MINUTES ||
    value.settings.intervalMinutes > MAX_SYNC_INTERVAL_MINUTES ||
    !assertObject(value.imports) ||
    !hasOnlyKeys(value.imports, ['allowedSourceIds']) ||
    !Array.isArray(value.imports.allowedSourceIds)
  ) {
    throw invalidConfig();
  }

  for (const [targetId, target] of Object.entries(value.policy.allowedSshTargets)) {
    if (
      !validIdentifier(targetId) ||
      !assertObject(target) ||
      !hasOnlyKeys(target, ['label', 'sshAlias']) ||
      !validLabel(target.label) ||
      !validIdentifier(target.sshAlias)
    ) {
      throw invalidConfig();
    }
  }

  const targetId = value.settings.targetId;
  if (
    targetId !== null &&
    (!validIdentifier(targetId) || !Object.hasOwn(value.policy.allowedSshTargets, targetId))
  ) {
    throw invalidConfig();
  }

  const allowedSourceIds = value.imports.allowedSourceIds;
  const seen = new Set();
  for (const sourceId of allowedSourceIds) {
    if (!validIdentifier(sourceId) || sourceId === RESERVED_SOURCE_ID || sourceId === value.source.id || seen.has(sourceId)) {
      throw invalidConfig();
    }
    seen.add(sourceId);
  }

  return clone(value);
}

export const DEFAULT_SYNC_CONFIG = Object.freeze({
  version: SYNC_CONFIG_VERSION,
  source: { id: 'local', label: 'Local' },
  policy: { allowedSshTargets: {} },
  settings: { enabled: false, targetId: null, intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES },
  imports: { allowedSourceIds: [] },
});

/**
 * Read the local sync configuration. Missing configuration intentionally maps
 * to a valid, disabled single-source instance; malformed configuration fails
 * closed and is never silently replaced.
 *
 * @param {{configDir?: string, configPath?: string, syncConfig?: object}} [options]
 * @returns {Promise<object>}
 */
export async function loadSyncConfig(options = {}) {
  if (options.syncConfig !== undefined) return validateSyncConfig(options.syncConfig);
  if (options.config !== undefined) return validateSyncConfig(options.config);

  let raw;
  try {
    raw = await readFile(configPath(options), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return clone(DEFAULT_SYNC_CONFIG);
    throw new Error('unable to read sync config');
  }

  try {
    return validateSyncConfig(JSON.parse(raw));
  } catch (err) {
    if (err?.message === 'invalid sync config') throw err;
    throw invalidConfig();
  }
}

async function writeSyncConfigAtomic(value, options = {}) {
  const destination = configPath(options);
  const directory = join(destination, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temporary = join(
    directory,
    `.${SYNC_CONFIG_FILENAME}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (err) {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup; the previous complete config remains in place.
    }
    throw new Error('unable to write sync config');
  }
}

/**
 * Update only settings and the display label. Policy, source identity, and
 * import authorization are deliberately outside this Web-safe write boundary.
 *
 * @param {{enabled?: boolean, targetId?: string|null, intervalMinutes?: number, label?: string}} patch
 * @param {{configDir?: string, configPath?: string, syncConfig?: object}} [options]
 * @returns {Promise<object>} public capability projection
 */
export async function updateSyncSettings(patch, options = {}) {
  if (!assertObject(patch)) throw new Error('invalid sync setting patch');
  const allowed = ['enabled', 'targetId', 'intervalMinutes', 'label'];
  if (!hasOnlyKeys(patch, allowed)) throw new Error('unknown sync setting');

  const current = await loadSyncConfig(options);
  const next = clone(current);

  if (Object.hasOwn(patch, 'enabled')) {
    if (typeof patch.enabled !== 'boolean') throw new Error('invalid sync setting');
    next.settings.enabled = patch.enabled;
  }
  if (Object.hasOwn(patch, 'targetId')) {
    if (
      patch.targetId !== null &&
      (!validIdentifier(patch.targetId) ||
        !Object.hasOwn(next.policy.allowedSshTargets, patch.targetId))
    ) {
      throw new Error('invalid sync target');
    }
    next.settings.targetId = patch.targetId;
  }
  if (Object.hasOwn(patch, 'intervalMinutes')) {
    if (
      !Number.isInteger(patch.intervalMinutes) ||
      patch.intervalMinutes < MIN_SYNC_INTERVAL_MINUTES ||
      patch.intervalMinutes > MAX_SYNC_INTERVAL_MINUTES
    ) {
      throw new Error('invalid sync interval');
    }
    next.settings.intervalMinutes = patch.intervalMinutes;
  }
  if (Object.hasOwn(patch, 'label')) {
    if (!validLabel(patch.label)) throw new Error('invalid sync label');
    next.source.label = patch.label;
  }

  validateSyncConfig(next);
  await writeSyncConfigAtomic(next, options);
  return getPublicSyncConfig({ ...options, syncConfig: next });
}

/**
 * Return only fields safe for the Web/API boundary. In particular, SSH aliases
 * and the config path are intentionally absent.
 *
 * @param {{configDir?: string, configPath?: string, syncConfig?: object}} [options]
 * @returns {Promise<object>}
 */
export async function getPublicSyncConfig(options = {}) {
  const config = await loadSyncConfig(options);
  const outboundTargets = Object.entries(config.policy.allowedSshTargets).map(([id, target]) => ({
    id,
    label: target.label,
  }));
  return {
    version: SYNC_CONFIG_VERSION,
    source: { ...config.source },
    settings: { ...config.settings },
    capabilities: {
      canExport: true,
      canImport: config.imports.allowedSourceIds.length > 0,
      canSync: outboundTargets.length > 0,
      outboundTargets,
      importedSourceIds: [...config.imports.allowedSourceIds],
    },
  };
}

export { validateSyncConfig };
