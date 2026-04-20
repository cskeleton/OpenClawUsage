import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join as pathJoin } from 'path';

/**
 * 配置根目录：与 shell `CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"` 一致
 * @returns {string}
 */
export function getOpenClawConfigDir() {
  return process.env.OPENCLAW_CONFIG_DIR
    ? process.env.OPENCLAW_CONFIG_DIR
    : pathJoin(homedir(), '.openclaw');
}

/**
 * agents/main/agent/models.json 的绝对路径（不检查存在性）
 * @returns {string}
 */
export function getAgentModelsJsonPath() {
  return pathJoin(getOpenClawConfigDir(), 'agents', 'main', 'agent', 'models.json');
}

/**
 * 判断 cost 是否视为「有有效单价」（input 或 output 非零）
 * @param {Object|null} cost
 * @returns {boolean}
 */
function hasMeaningfulCost(cost) {
  if (!cost || typeof cost !== 'object') return false;
  const input = typeof cost.input === 'number' ? cost.input : 0;
  const output = typeof cost.output === 'number' ? cost.output : 0;
  return input !== 0 || output !== 0;
}

/**
 * 将模型条目上的 cost 规范化为数值对象；无 cost 字段时返回 null
 * @param {Object} m
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number }|null}
 */
function normalizeCostFromModel(m) {
  if (!m || typeof m !== 'object' || !m.cost || typeof m.cost !== 'object') return null;
  const c = m.cost;
  return {
    input: typeof c.input === 'number' ? c.input : 0,
    output: typeof c.output === 'number' ? c.output : 0,
    cacheRead:
      c.cacheRead !== undefined && c.cacheRead !== null ? Number(c.cacheRead) : 0,
    cacheWrite:
      c.cacheWrite !== undefined && c.cacheWrite !== null ? Number(c.cacheWrite) : 0,
  };
}

/**
 * 从 models.json 读取全部可用模型（唯一目录源）
 * @returns {Promise<Array<{ provider: string, model: string, displayName: string, cost: object|null, contextWindow: number|null, maxTokens: number|null, sources: string[] }>>}
 */
async function listAllModelsFromModelsJson() {
  const p = getAgentModelsJsonPath();
  let raw;
  try {
    raw = await readFile(p, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return [];
  }

  const providers = config?.providers || config?.models?.providers;
  if (!providers || typeof providers !== 'object') return [];

  const rows = [];
  for (const [providerName, providerObj] of Object.entries(providers)) {
    const models = providerObj?.models;
    if (!Array.isArray(models)) continue;

    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) continue;

      rows.push({
        provider: providerName,
        model: id,
        displayName: typeof m.name === 'string' ? m.name : id,
        cost: normalizeCostFromModel(m),
        contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
        maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
        sources: ['modelsJson'],
      });
    }
  }

  rows.sort((a, b) => {
    const ka = `${a.provider}/${a.model}`;
    const kb = `${b.provider}/${b.model}`;
    return ka.localeCompare(kb);
  });
  return rows;
}

/**
 * 内置价参考表：models.json 中带有效 input/output 单价的模型（与「缺少价格」互为补集）
 * @returns {Promise<Array<{ provider: string, model: string, displayName: string, cost: object, contextWindow: number|null, maxTokens: number|null }>>}
 */
export async function listOpenClawPricedModels() {
  const all = await listAllModelsFromModelsJson();
  return all
    .filter((row) => hasMeaningfulCost(row.cost))
    .map((row) => {
      const cost = row.cost;
      return {
        provider: row.provider,
        model: row.model,
        displayName: row.displayName,
        cost,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
      };
    });
}

/**
 * models.json 中未声明有效 input/output 单价的模型
 * @returns {Promise<Array<{ provider: string, model: string, displayName: string, cost: object|null, contextWindow: number|null, maxTokens: number|null, sources: string[] }>>}
 */
export async function listUnpricedModels() {
  const all = await listAllModelsFromModelsJson();
  return all.filter((row) => !hasMeaningfulCost(row.cost));
}
