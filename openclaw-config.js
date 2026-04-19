import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join as pathJoin } from 'path';
import { detectOpenClawDir } from './pricing.js';

/**
 * 解析 openclaw.json 路径：优先与价格配置同目录，其次 ~/.openclaw/openclaw.json
 * @returns {Promise<string|null>} 成功时返回绝对路径，失败时 null
 */
async function resolveOpenclawJsonPath() {
  const dir = await detectOpenClawDir();
  const primary = pathJoin(dir, 'openclaw.json');
  try {
    await readFile(primary, 'utf-8');
    return primary;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const fallback = pathJoin(homedir(), '.openclaw', 'openclaw.json');
  try {
    await readFile(fallback, 'utf-8');
    return fallback;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return null;
}

/**
 * 判断 cost 是否视为「有有效单价」（input 或 output 非零）
 * @param {Object} cost
 * @returns {boolean}
 */
function hasMeaningfulCost(cost) {
  if (!cost || typeof cost !== 'object') return false;
  const input = typeof cost.input === 'number' ? cost.input : 0;
  const output = typeof cost.output === 'number' ? cost.output : 0;
  return input !== 0 || output !== 0;
}

/**
 * 从 OpenClaw 的 openclaw.json 读取 models.providers 下带 cost 的模型列表（扁平化）
 * @returns {Promise<Array<{ provider: string, model: string, displayName: string, cost: object, contextWindow: number|null, maxTokens: number|null }>>}
 */
export async function listOpenClawPricedModels() {
  const jsonPath = await resolveOpenclawJsonPath();
  if (!jsonPath) return [];

  let raw;
  try {
    raw = await readFile(jsonPath, 'utf-8');
  } catch {
    return [];
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return [];
  }

  const providers = config?.models?.providers;
  if (!providers || typeof providers !== 'object') return [];

  const out = [];
  for (const [providerName, providerObj] of Object.entries(providers)) {
    const models = providerObj?.models;
    if (!Array.isArray(models)) continue;

    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) continue;
      if (!hasMeaningfulCost(m.cost)) continue;

      const cost = {
        input: typeof m.cost.input === 'number' ? m.cost.input : 0,
        output: typeof m.cost.output === 'number' ? m.cost.output : 0,
        cacheRead:
          m.cost.cacheRead !== undefined && m.cost.cacheRead !== null
            ? Number(m.cost.cacheRead)
            : 0,
        cacheWrite:
          m.cost.cacheWrite !== undefined && m.cost.cacheWrite !== null
            ? Number(m.cost.cacheWrite)
            : 0,
      };

      out.push({
        provider: providerName,
        model: id,
        displayName: typeof m.name === 'string' ? m.name : id,
        cost,
        contextWindow:
          typeof m.contextWindow === 'number' ? m.contextWindow : null,
        maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
      });
    }
  }

  return out;
}
