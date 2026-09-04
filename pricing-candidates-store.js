import { readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolvePricingConfigPath } from './pricing.js';

/**
 * 确认队列（candidates queue）持久化。
 * 机器产物：可由 rematchObservedKeys 重新生成，因此缺失/损坏一律回落空态，绝不抛错。
 * 文件与定价配置同目录：dirname(resolvePricingConfigPath())/openclaw-usage-pricing-candidates.json
 */

async function getCandidatesPath() {
  return join(dirname(await resolvePricingConfigPath()), 'openclaw-usage-pricing-candidates.json');
}

/**
 * 读取确认队列。
 * @returns {Promise<{ candidates: Array<{ observedKey: string, candidates: object[], lastSeenAt: string, dismissed: boolean }> }>}
 */
export async function loadCandidates() {
  try {
    const parsed = JSON.parse(await readFile(await getCandidatesPath(), 'utf-8'));
    if (!parsed || !Array.isArray(parsed.candidates)) return { candidates: [] };
    return parsed;
  } catch {
    return { candidates: [] };
  }
}

/**
 * 持久化确认队列。
 * @param {{ candidates: object[] }} state
 */
export async function saveCandidates(state) {
  await writeFile(await getCandidatesPath(), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 按 observedKey 去重 upsert，刷新 lastSeenAt（同 key 旧条目被替换到队尾）。
 * @param {{ candidates: object[] }} state
 * @param {object} entry
 */
export function upsertCandidateEntry(state, entry) {
  const idx = state.candidates.findIndex((c) => c.observedKey === entry.observedKey);
  if (idx >= 0) state.candidates.splice(idx, 1);
  state.candidates.push(entry);
}
