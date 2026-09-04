import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolvePricingConfigPath } from './pricing.js';
import { writeTextFileAtomic } from './json-atomic-write.js';

/**
 * 确认队列（candidates queue）持久化。
 * 机器产物：可由 rematchObservedKeys 重新生成，因此缺失/损坏一律回落空态，绝不抛错。
 * 文件与定价配置同目录：dirname(配置路径)/openclaw-usage-pricing-candidates.json
 */

/**
 * @param {string} [configPath] - 定价配置路径覆盖（后台任务钉住触发时刻的路径）
 */
async function getCandidatesPath(configPath) {
  const base = configPath || await resolvePricingConfigPath();
  return join(dirname(base), 'openclaw-usage-pricing-candidates.json');
}

/**
 * 读取确认队列。
 * @param {{ configPath?: string }} [options]
 * @returns {Promise<{ candidates: Array<{ observedKey: string, candidates: object[], lastSeenAt: string, dismissed: boolean }> }>}
 */
export async function loadCandidates({ configPath } = {}) {
  try {
    const parsed = JSON.parse(await readFile(await getCandidatesPath(configPath), 'utf-8'));
    if (!parsed || !Array.isArray(parsed.candidates)) return { candidates: [] };
    return parsed;
  } catch {
    return { candidates: [] };
  }
}

/**
 * 持久化确认队列（原子写：tmp + rename，中断不留截断文件）。
 * @param {{ candidates: object[] }} state
 * @param {{ configPath?: string }} [options]
 */
export async function saveCandidates(state, { configPath } = {}) {
  await writeTextFileAtomic(await getCandidatesPath(configPath), JSON.stringify(state, null, 2));
}

/** 进程内 candidates 读-改-写串行化：惰性 rematch 与 HTTP resolve 并发时防止丢 dismissed 标记 */
let candidatesLock = Promise.resolve();

/**
 * 串行执行一段 candidates 的读-改-写（前一段失败不阻塞后续）。
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export function withCandidatesLock(fn) {
  const run = candidatesLock.then(fn, fn);
  candidatesLock = run.then(() => {}, () => {});
  return run;
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
