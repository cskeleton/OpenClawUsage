import express from 'express';
import cors from 'cors';
import { aggregateStats, getSessionDir } from './aggregator.js';
import {
  loadPricingConfig,
  savePricingConfig,
  validatePricingConfig,
  findMatchingPricing,
} from './pricing.js';
import { listOpenClawPricedModels, listUnpricedModels } from './openclaw-config.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// 聚合缓存：30 秒 TTL + pricing.updated 失效键（与 MCP 侧一致）
let cachedStats = null;
let cacheTime = 0;
let cachedPricingUpdated = '';
const CACHE_TTL = 30_000;

/**
 * 获取（必要时重算）聚合统计。pricing.updated 变化或超时都会触发重算。
 * @param {{ forceFresh?: boolean }} [options]
 */
async function getCachedStats({ forceFresh = false } = {}) {
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

function invalidateCache() {
  cachedStats = null;
  cacheTime = 0;
  cachedPricingUpdated = '';
}

app.get('/api/stats', async (req, res) => {
  try {
    const data = await getCachedStats();
    res.json(data);
  } catch (err) {
    console.error('Error aggregating stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    const data = await getCachedStats({ forceFresh: true });
    res.json({
      ok: true,
      generatedAt: data.generatedAt,
      pricingVersion: data.pricingVersion,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing - 获取当前价格配置
app.get('/api/pricing', async (req, res) => {
  try {
    const config = await loadPricingConfig();
    res.json(config);
  } catch (err) {
    console.error('Error loading pricing config:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/pricing - 更新价格配置
app.put('/api/pricing', async (req, res) => {
  try {
    const config = req.body;
    validatePricingConfig(config);
    await savePricingConfig(config);
    invalidateCache();
    res.json({ ok: true, updated: config.updated });
  } catch (err) {
    console.error('Error updating pricing config:', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/pricing/reset - 重置为默认（空）配置
app.post('/api/pricing/reset', async (req, res) => {
  try {
    const defaultConfig = {
      version: '1.0',
      enabled: true,
      updated: new Date().toISOString(),
      pricing: {}
    };
    await savePricingConfig(defaultConfig);
    invalidateCache();
    res.json({ ok: true, updated: defaultConfig.updated });
  } catch (err) {
    console.error('Error resetting pricing config:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 为 models.json 的一条模型记录附加 custom 对比字段
 */
function attachCustomRule(row, customMap) {
  const key = `${row.provider}/${row.model}`;
  const rule = findMatchingPricing(key, customMap);
  const custom = rule
    ? {
        input: rule.input,
        output: rule.output,
        cacheRead: rule.cacheRead ?? null,
        cacheWrite: rule.cacheWrite ?? null,
        enabled: rule.enabled !== false,
      }
    : null;
  return {
    key,
    provider: row.provider,
    model: row.model,
    displayName: row.displayName,
    cost: row.cost,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    custom,
  };
}

// GET /api/openclaw/models - models.json 中有/无单价模型 + 与自定义价对照
app.get('/api/openclaw/models', async (req, res) => {
  try {
    const [priced, pricingConfig, unpriced] = await Promise.all([
      listOpenClawPricedModels(),
      loadPricingConfig(),
      listUnpricedModels(),
    ]);
    const customMap = pricingConfig.pricing || {};
    const rows = priced.map((row) => attachCustomRule(row, customMap));
    const unpricedModels = unpriced.map((row) => attachCustomRule(row, customMap));
    res.json({ models: rows, unpricedModels });
  } catch (err) {
    console.error('Error listing OpenClaw priced models:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/models - 列出所有可用的 Provider/Model 组合（走缓存）
app.get('/api/pricing/models', async (req, res) => {
  try {
    const data = await getCachedStats();
    const models = Object.keys(data.byModel);
    res.json({ models });
  } catch (err) {
    console.error('Error fetching models:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OpenClaw Usage API running at http://localhost:${PORT}`);
  console.log(`Scanning sessions from: ${getSessionDir()}`);
});
