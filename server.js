import express from 'express';
import cors from 'cors';
import { aggregateStats, SESSION_DIR } from './aggregator.js';
import {
  loadPricingConfig,
  savePricingConfig,
  validatePricingConfig,
} from './pricing.js';
import { listOpenClawPricedModels } from './openclaw-config.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Cache to avoid re-scanning on every request
let cachedStats = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

app.get('/api/stats', async (req, res) => {
  try {
    const now = Date.now();
    if (!cachedStats || now - cacheTime > CACHE_TTL) {
      cachedStats = await aggregateStats();
      cacheTime = now;
    }
    res.json(cachedStats);
  } catch (err) {
    console.error('Error aggregating stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    const pricingConfig = await loadPricingConfig();
    cachedStats = await aggregateStats(pricingConfig);
    cacheTime = Date.now();
    res.json({
      ok: true,
      generatedAt: cachedStats.generatedAt,
      pricingVersion: pricingConfig.version,
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

    // 失效缓存
    cachedStats = null;
    cacheTime = 0;

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

    // 失效缓存
    cachedStats = null;
    cacheTime = 0;

    res.json({ ok: true, updated: defaultConfig.updated });
  } catch (err) {
    console.error('Error resetting pricing config:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/openclaw/models - OpenClaw openclaw.json 中带 cost 的模型 + 与自定义价对照
app.get('/api/openclaw/models', async (req, res) => {
  try {
    const [priced, pricingConfig] = await Promise.all([
      listOpenClawPricedModels(),
      loadPricingConfig(),
    ]);
    const customMap = pricingConfig.pricing || {};
    const rows = priced.map((row) => {
      const key = `${row.provider}/${row.model}`;
      const rule = customMap[key];
      let custom = null;
      if (rule) {
        custom = {
          input: rule.input,
          output: rule.output,
          cacheRead: rule.cacheRead ?? null,
          cacheWrite: rule.cacheWrite ?? null,
          enabled: rule.enabled !== false,
        };
      }
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
    });
    res.json({ models: rows });
  } catch (err) {
    console.error('Error listing OpenClaw priced models:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing/models - 列出所有可用的 Provider/Model 组合
app.get('/api/pricing/models', async (req, res) => {
  try {
    const data = await aggregateStats();
    const models = Object.keys(data.byModel);
    res.json({ models });
  } catch (err) {
    console.error('Error fetching models:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OpenClaw Usage API running at http://localhost:${PORT}`);
  console.log(`Scanning sessions from: ${SESSION_DIR}`);
});
