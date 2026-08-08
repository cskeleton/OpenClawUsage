import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getCacheDir } from './stats-cache-store.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export const MODELS_DEV_CACHE_FILENAME = 'models-dev-v1.json';

/** 当前生效的 fetch 实现（测试可注入；后台刷新也走它） */
let activeFetchImpl = null;
let inflightRefresh = null;

function getCacheFilePath() {
  return join(getCacheDir(), MODELS_DEV_CACHE_FILENAME);
}

function toNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 归一化 models.dev api.json 为扁平模型列表
 * @param {object} apiJson
 * @returns {Array<{ key: string, provider: string, model: string, displayName: string, cost: { input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null }, contextWindow: number|null }>}
 */
function normalizeCatalog(apiJson) {
  const models = [];
  for (const [providerId, provider] of Object.entries(apiJson || {})) {
    const modelsMap = provider?.models;
    if (!modelsMap || typeof modelsMap !== 'object') continue;
    for (const [modelId, m] of Object.entries(modelsMap)) {
      if (!m || typeof m !== 'object') continue;
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : {};
      models.push({
        key: `${providerId}/${modelId}`,
        provider: providerId,
        model: modelId,
        displayName: typeof m.name === 'string' && m.name ? m.name : modelId,
        cost: {
          input: toNumberOrNull(cost.input),
          output: toNumberOrNull(cost.output),
          cacheRead: toNumberOrNull(cost.cache_read),
          cacheWrite: toNumberOrNull(cost.cache_write),
        },
        contextWindow: toNumberOrNull(m.limit?.context),
      });
    }
  }
  models.sort((a, b) => a.key.localeCompare(b.key));
  return models;
}

/**
 * 将 fetch 的返回统一为 JSON 对象（兼容直接返回对象或 Response 的注入实现）
 * @param {() => Promise<any>} doFetch
 * @returns {Promise<object>}
 */
async function fetchJson(doFetch) {
  const out = await doFetch();
  if (out instanceof Response) {
    if (!out.ok) throw new Error(`models.dev responded HTTP ${out.status}`);
    return out.json();
  }
  return out;
}

/** 真实网络请求：固定 URL + 10s 超时，不带任何本地信息 */
async function fetchRemote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`models.dev responded HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readSnapshot() {
  try {
    const raw = await readFile(getCacheFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSnapshot(snapshot) {
  try {
    await mkdir(getCacheDir(), { recursive: true });
    await writeFile(getCacheFilePath(), JSON.stringify(snapshot), 'utf-8');
  } catch (err) {
    console.warn('models.dev 缓存写入失败:', err?.message || err);
  }
}

/** 后台刷新：同一时间至多一个在途；失败仅记日志，不影响已返回的陈旧快照 */
async function refreshInBackground() {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const json = await fetchJson(activeFetchImpl || fetchRemote);
      await writeSnapshot({ fetchedAt: new Date().toISOString(), models: normalizeCatalog(json) });
    } catch (err) {
      console.warn('models.dev 后台刷新失败:', err?.message || err);
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/**
 * 获取 models.dev 目录（先旧后新：过期缓存立即返回 stale 并后台刷新）
 * @param {{ fetchImpl?: Function, nowMs?: number }} [options]
 * @returns {Promise<{ models: Array, fetchedAt: string, stale: boolean, source: 'models.dev' }>}
 */
export async function getModelsDevCatalog({ fetchImpl, nowMs } = {}) {
  if (fetchImpl) activeFetchImpl = fetchImpl;
  const doFetch = fetchImpl || fetchRemote;
  const now = nowMs ?? Date.now();
  const snapshot = await readSnapshot();

  if (snapshot) {
    const age = now - Date.parse(snapshot.fetchedAt);
    if (age >= 0 && age < TTL_MS) {
      return { models: snapshot.models, fetchedAt: snapshot.fetchedAt, stale: false, source: 'models.dev' };
    }
    // 过期：先返回陈旧快照，后台刷新
    refreshInBackground().catch(() => {});
    return { models: snapshot.models, fetchedAt: snapshot.fetchedAt, stale: true, source: 'models.dev' };
  }

  // 无缓存：同步拉取，失败 fail-closed
  let json;
  try {
    json = await fetchJson(doFetch);
  } catch (err) {
    throw new Error(`models.dev 目录获取失败: ${err?.message || err}`);
  }
  const models = normalizeCatalog(json);
  const fetchedAt = new Date(now).toISOString();
  await writeSnapshot({ fetchedAt, models });
  return { models, fetchedAt, stale: false, source: 'models.dev' };
}

/** 测试辅助：清空进程内状态与注入的 fetch */
export function __clearModelsDevCacheForTests() {
  inflightRefresh = null;
  activeFetchImpl = null;
}
