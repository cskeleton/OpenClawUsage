import express from 'express';
import cors from 'cors';
import { getSessionDir } from './aggregator.js';
import {
  findMatchingPricing,
} from './pricing.js';
import { listOpenClawPricedModels, listUnpricedModels } from './openclaw-config.js';
import {
  getStats,
  getPricingConfig,
  updatePricingConfig,
  refreshStatsCache,
} from './stats-service.js';

const PORT = 3001;

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

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/stats', async (req, res) => {
    try {
      const data = await getStats();
      res.json(data);
    } catch (err) {
      console.error('Error aggregating stats:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      const result = await refreshStatsCache();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/pricing - 获取当前价格配置
  app.get('/api/pricing', async (req, res) => {
    try {
      const config = await getPricingConfig();
      res.json(config);
    } catch (err) {
      console.error('Error loading pricing config:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/pricing - 更新价格配置
  app.put('/api/pricing', async (req, res) => {
    try {
      const result = await updatePricingConfig(req.body);
      res.json(result);
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
      const result = await updatePricingConfig(defaultConfig);
      res.json(result);
    } catch (err) {
      console.error('Error resetting pricing config:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/openclaw/models - models.json 中有/无单价模型 + 与自定义价对照
  app.get('/api/openclaw/models', async (req, res) => {
    try {
      const [priced, pricingConfig, unpriced] = await Promise.all([
        listOpenClawPricedModels(),
        getPricingConfig(),
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
      const data = await getStats();
      const models = Object.keys(data.byModel);
      res.json({ models });
    } catch (err) {
      console.error('Error fetching models:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// Only listen when run directly with `node server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`OpenClaw Usage API running at http://localhost:${PORT}`);
    console.log(`Scanning sessions from: ${getSessionDir()}`);
  });
}
