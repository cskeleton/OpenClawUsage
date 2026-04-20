import { aggregateStats } from './aggregator.js';
import { loadPricingConfig, savePricingConfig, validatePricingConfig } from './pricing.js';

const CACHE_TTL = 30_000;

let cachedStats = null;
let cacheTime = 0;
let cachedPricingUpdated = '';

/**
 * 获取（必要时重算）聚合统计。pricing.updated 变化或超时都会触发重算。
 * @param {{ forceFresh?: boolean }} [options]
 */
export async function getStats({ forceFresh = false } = {}) {
  const now = Date.now();
  const pricingConfig = await loadPricingConfig();
  const currentUpdated = pricingConfig.updated || '';

  const expired = now - cacheTime > CACHE_TTL;
  const pricingChanged = currentUpdated !== cachedPricingUpdated;

  if (forceFresh || !cachedStats || expired || pricingChanged) {
    cachedStats = await aggregateStats(pricingConfig);
    cachedStats.pricingUpdated = currentUpdated;
    cachedStats.pricingVersion = pricingConfig.version;
    cacheTime = now;
    cachedPricingUpdated = currentUpdated;
  }

  return cachedStats;
}

/**
 * 使统计缓存失效。
 */
export function invalidateStatsCache() {
  cachedStats = null;
  cacheTime = 0;
  cachedPricingUpdated = '';
}

/**
 * 读取价格配置。
 */
export async function getPricingConfig() {
  return loadPricingConfig();
}

/**
 * 更新价格配置并失效缓存。
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
 * 强制刷新统计缓存。
 */
export async function refreshStatsCache() {
  const data = await getStats({ forceFresh: true });
  return {
    ok: true,
    generatedAt: data.generatedAt,
    pricingVersion: data.pricingVersion,
  };
}
