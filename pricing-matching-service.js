import { loadPricingConfig, savePricingConfig, resolvePricingRule } from './pricing.js';
import { splitModelKey } from './pricing-normalize.js';
import { buildCatalogIndex, matchObservedKey } from './pricing-catalog-matcher.js';
import { getModelsDevCatalog } from './models-dev.js';
import { loadCandidates, saveCandidates, upsertCandidateEntry } from './pricing-candidates-store.js';

/**
 * 对 observed keys 批量跑 models.dev 匹配：唯一命中写入 rules（source: 'models.dev'），
 * 歧义进确认队列。已被 rules/aliases/patterns 覆盖的键（以完整 resolvePricingRule 口径判定）跳过。
 *
 * 写入语义：内部 savePricingConfig 一律**不带 baseRevision**（best-effort 强制写）。
 * 自动匹配是后台批量路径，不持有用户会话的 revision；若与并发用户 PUT 撞车，
 * 由用户侧 409 重载兜底，而不是让批量匹配整体失败。
 * 另：unique 命中写入前会确认目标 canonical 键不存在或不是 manual——
 * manual 条目是用户意图，自动匹配绝不可覆盖。
 *
 * @param {string[]} keys - `provider/model` 列表
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ scanned: number, matched: number, queued: number, catalogUnavailable?: true }>}
 */
export async function rematchObservedKeys(keys, { fetchImpl } = {}) {
  const config = await loadPricingConfig();
  if (config.enabled === false) return { scanned: 0, matched: 0, queued: 0 };
  const uncovered = [...new Set(keys)].filter((key) => {
    const { provider, model } = splitModelKey(key);
    return !resolvePricingRule(provider, model, config);
  });
  if (!uncovered.length) return { scanned: 0, matched: 0, queued: 0 };

  let catalog;
  try {
    catalog = await getModelsDevCatalog({ fetchImpl });
  } catch {
    return { scanned: uncovered.length, matched: 0, queued: 0, catalogUnavailable: true };
  }
  const index = buildCatalogIndex(catalog.models);
  const candidatesState = await loadCandidates();
  const ignoreProvider = config.matching?.ignoreProvider !== false;
  const noiseSuffixes = config.matching?.noiseSuffixes;
  let matched = 0;
  let queued = 0;

  for (const key of uncovered) {
    const { provider, model } = splitModelKey(key);
    const result = matchObservedKey(provider, model, { index, noiseSuffixes, ignoreProvider });
    if (result.status === 'unique') {
      const { model: catalogModel, prices } = result.match;
      if (prices.input == null || prices.output == null) continue; // 无价目不入库
      const existing = config.rules[catalogModel];
      if (existing && existing.source === 'manual') continue; // manual 规则不可被自动匹配覆盖
      config.rules[catalogModel] = {
        input: prices.input,
        output: prices.output,
        cacheRead: prices.cacheRead,
        cacheWrite: prices.cacheWrite,
        enabled: true,
        source: 'models.dev',
        syncedAt: catalog.fetchedAt,
      };
      matched++;
    } else if (result.status === 'ambiguous') {
      upsertCandidateEntry(candidatesState, {
        observedKey: key,
        candidates: result.candidates,
        lastSeenAt: new Date().toISOString(),
        dismissed: false,
      });
      queued++;
    }
  }
  if (matched > 0) await savePricingConfig(config); // 无 baseRevision：best-effort 强制写（见 JSDoc）
  if (queued > 0) await saveCandidates(candidatesState);
  return { scanned: uncovered.length, matched, queued };
}

/**
 * 应用确认队列决议（批量）。单条失败计入 failed，不中断其余决议、不抛错。
 *
 * accept：写 `aliases[observedKey] = catalogModel`，并在目标 canonical 键不存在
 * 或不是 manual 时写入/刷新 `rules[catalogModel]`（source: 'models.dev'）；
 * manual 规则只挂 alias、不改动价格。dismiss：仅标记 dismissed。
 * 两种 action 都把条目标记 dismissed（已处理即移出待办）。
 *
 * 写入语义同 rematchObservedKeys：内部 savePricingConfig 不带 baseRevision
 * （best-effort 强制写）；并发用户 PUT 若基于旧 revision 将收到 409 并重载。
 *
 * @param {Array<{ observedKey: string, action: 'accept'|'dismiss', catalogId?: string }>} resolutions
 * @returns {Promise<{ applied: number, failed: Array<{ observedKey: string, error: string }> }>}
 */
export async function applyCandidateResolutions(resolutions) {
  const state = await loadCandidates();
  const config = await loadPricingConfig();
  let applied = 0;
  const failed = [];
  let configDirty = false;

  for (const r of resolutions || []) {
    const entry = state.candidates.find((c) => c.observedKey === r?.observedKey);
    if (!entry) {
      failed.push({ observedKey: r?.observedKey ?? '', error: 'candidate not found' });
      continue;
    }
    if (r.action === 'dismiss') {
      entry.dismissed = true;
      applied++;
      continue;
    }
    if (r.action === 'accept') {
      const chosen = entry.candidates.find((c) => c.model === r.catalogId || c.catalogKey === r.catalogId);
      if (!chosen || chosen.prices.input == null || chosen.prices.output == null) {
        failed.push({ observedKey: r.observedKey, error: 'catalogId not in candidates or missing prices' });
        continue;
      }
      config.aliases[entry.observedKey] = chosen.model;
      if (!config.rules[chosen.model] || config.rules[chosen.model].source !== 'manual') {
        config.rules[chosen.model] = {
          input: chosen.prices.input,
          output: chosen.prices.output,
          cacheRead: chosen.prices.cacheRead,
          cacheWrite: chosen.prices.cacheWrite,
          enabled: true,
          source: 'models.dev',
          syncedAt: new Date().toISOString(),
        };
      }
      entry.dismissed = true;
      configDirty = true;
      applied++;
      continue;
    }
    failed.push({ observedKey: r.observedKey, error: `unknown action: ${r.action}` });
  }

  if (configDirty) await savePricingConfig(config); // 无 baseRevision：best-effort 强制写（见 JSDoc）
  await saveCandidates(state);
  return { applied, failed };
}
