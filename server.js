import express from 'express';
import { isIP } from 'net';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getSqlitePath } from './sqlite-source.js';
import {
  findMatchingPricing,
  defaultPricingConfigV2,
} from './pricing.js';
import { listOpenClawPricedModels, listUnpricedModels } from './openclaw-config.js';
import { getModelsDevCatalog } from './models-dev.js';
import { rematchObservedKeys, applyCandidateResolutions } from './pricing-matching-service.js';
import { loadCandidates } from './pricing-candidates-store.js';
import {
  getStats,
  getPricingConfig,
  getPricingConfigDetailed,
  updatePricingConfig,
  refreshStatsCache,
  invalidateStatsCache,
} from './stats-service.js';
import {
  getPublicSyncConfig,
  updateSyncSettings,
} from './sync-config.js';
import {
  getSyncStatus,
  syncToTarget,
  testSyncTarget,
} from './sync-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Resolve and strictly validate OPENCLAW_USAGE_HOST. Only IP literals are
 * accepted so deployment configuration cannot inject a socket/path or an
 * ambiguous hostname; the default remains loopback for local installs.
 * @param {string|undefined} raw
 * @returns {string}
 */
export function resolveListenHost(raw = process.env.OPENCLAW_USAGE_HOST) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_HOST;
  }
  const host = String(raw);
  if (host.length > 255 || /[\u0000-\u0020\u007f]/.test(host) || isIP(host) === 0) {
    throw new Error(`Invalid OPENCLAW_USAGE_HOST: ${raw}`);
  }
  return host;
}

/**
 * 解析并校验 OPENCLAW_USAGE_PORT（或回退默认端口）
 * @param {string|undefined} raw
 * @returns {number}
 */
export function resolveListenPort(raw = process.env.OPENCLAW_USAGE_PORT) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_PORT;
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid OPENCLAW_USAGE_PORT: ${raw}`);
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPENCLAW_USAGE_PORT: ${raw}`);
  }
  return port;
}

/** 需要 CSRF 防护的写方法 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 判断 Origin 是否可信（用于阻止跨站表单 / 跨站 fetch 触发写操作）。
 *
 * 规则：
 * 1. 只接受 http / https 协议的 Origin；`null`（sandbox iframe、file://）一律拒绝。
 * 2. Origin 的 host 与请求 Host 完全一致时放行（生产态同源访问）。
 * 3. Origin 指向本机 loopback 时放行，用于开发态 Vite `changeOrigin` 代理
 *    （浏览器 Origin 为 127.0.0.1:3000，而代理改写后的 Host 为 127.0.0.1:3001）。
 *    跨站攻击页面无法伪造 loopback Origin，因此不削弱防跨站表单的目标。
 * @param {string} origin
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isTrustedWriteOrigin(origin, req) {
  if (!origin || origin === 'null') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const requestHost = req.headers?.host;
  if (requestHost && parsed.host === requestHost) return true;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * 写接口防护中间件：
 * - 携带 Origin 时必须是可信来源，否则 403（阻止跨站表单 / 跨站 fetch）。
 * - 写请求必须声明 `Content-Type: application/json` 或 `application/*+json`，否则 415；
 *   HTML 表单只能发送 urlencoded / multipart / text-plain，因此无法绕过。
 * - 无 Origin 的请求视为本机命令行工具（curl 等），仅受 JSON 内容类型约束。
 * - 正文解析由下方 `express.json({ type: [...] })` 同步覆盖这两种类型，避免 guard 放行后 body 为空。
 */
export function writeRequestGuard(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();

  const origin = req.headers?.origin;
  if (origin !== undefined && !isTrustedWriteOrigin(origin, req)) {
    return res.status(403).json({ error: 'Cross-origin write request rejected' });
  }

  const contentType = String(req.headers?.['content-type'] || '').trim();
  if (!/^application\/(json|[\w.+-]+\+json)\s*(;|$)/i.test(contentType)) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  return next();
}

/**
 * 为 openclaw.json 的一条模型记录附加 custom 对比字段
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

const SAFE_SYNC_ERROR_MESSAGES = Object.freeze({
  SYNC_SETTINGS_INVALID: 'Invalid sync settings',
  SYNC_TARGET_INVALID: 'Invalid sync target',
  SYNC_TARGET_NOT_ALLOWED: 'Sync target is not allowlisted',
  SYNC_DISABLED: 'Sync is disabled',
  SYNC_CACHE_NOT_FRESH: 'Local statistics are not fresh',
  SNAPSHOT_TOO_LARGE: 'Sync snapshot is too large',
  SYNC_INPUT_FAILED: 'Unable to read sync input',
  SYNC_INPUT_INVALID: 'Invalid sync snapshot',
  SYNC_SNAPSHOT_INVALID: 'Invalid sync snapshot',
  SYNC_STORE_FAILED: 'Unable to store sync snapshot',
  SYNC_STATUS_WRITE_FAILED: 'Unable to persist sync status',
  SYNC_CONFIG_UNAVAILABLE: 'Sync configuration unavailable',
  SSH_TIMEOUT: 'SSH transport timed out',
  SSH_EXIT: 'SSH receiver exited unsuccessfully',
  SSH_SIGNAL: 'SSH transport terminated',
  SSH_FAILED: 'SSH transport failed',
  SYNC_FAILED: 'Sync failed',
});

function safeSyncError(res, error, fallbackCode = 'SYNC_FAILED') {
  const code = SAFE_SYNC_ERROR_MESSAGES[error?.code] ? error.code : fallbackCode;
  const status = code.startsWith('SSH_') ? 502 : (code === 'SYNC_CONFIG_UNAVAILABLE' ? 500 : 400);
  return res.status(status).json({ code, error: SAFE_SYNC_ERROR_MESSAGES[code] });
}

function actionTargetId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('invalid sync action body');
    error.code = 'SYNC_TARGET_INVALID';
    throw error;
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'targetId')) {
    const error = new Error('invalid sync action body');
    error.code = 'SYNC_TARGET_INVALID';
    throw error;
  }
  if (Object.hasOwn(body, 'targetId') && typeof body.targetId !== 'string') {
    const error = new Error('invalid sync target');
    error.code = 'SYNC_TARGET_INVALID';
    throw error;
  }
  return body.targetId;
}

function safeSyncStatus(status) {
  const statusError = status.error;
  const safeError = statusError === null
    ? null
    : (Object.values(SAFE_SYNC_ERROR_MESSAGES).includes(statusError)
      || /^SSH receiver exited with code \d+$/.test(statusError)
      || /^SSH receiver terminated by [A-Z0-9]+$/.test(statusError)
      ? statusError
      : 'Sync failed');
  return {
    ...status,
    error: safeError,
  };
}

/**
 * 创建 Express 应用。
 * @param {{ staticDir?: string }} [options]
 *   staticDir 默认解析为 server.js 同级的 dist/，不依赖 process.cwd()
 */
export function createApp({ staticDir } = {}) {
  const app = express();
  const resolvedStaticDir = resolve(staticDir || join(__dirname, 'dist'));

  // 与 writeRequestGuard 对齐：除 application/json 外也解析 vendor JSON（application/*+json）
  app.use(express.json({ type: ['application/json', 'application/*+json'] }));

  // 所有 /api 写接口先过同源 + JSON 内容类型防护
  app.use('/api', writeRequestGuard);

  // 轻量健康检查：不得触发 getStats / Session 扫描
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'openclaw-usage',
      pid: process.pid,
      launchId: process.env.OPENCLAW_USAGE_LAUNCH_ID || null,
    });
  });

  app.get('/api/sync/config', async (req, res) => {
    try {
      res.json(await getPublicSyncConfig());
    } catch {
      safeSyncError(res, null, 'SYNC_CONFIG_UNAVAILABLE');
    }
  });

  app.get('/api/sync/status', async (req, res) => {
    try {
      res.json(safeSyncStatus(await getSyncStatus()));
    } catch {
      safeSyncError(res, null, 'SYNC_CONFIG_UNAVAILABLE');
    }
  });

  app.put('/api/sync/settings', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('invalid sync settings');
        error.code = 'SYNC_SETTINGS_INVALID';
        throw error;
      }
      res.json(await updateSyncSettings(body));
    } catch (error) {
      const code = error?.code || (
        /target/i.test(error?.message || '') ? 'SYNC_TARGET_INVALID' : 'SYNC_SETTINGS_INVALID'
      );
      safeSyncError(res, { ...error, code }, code);
    }
  });

  app.post('/api/sync/run', async (req, res) => {
    try {
      const targetId = actionTargetId(req.body);
      res.json(await syncToTarget(targetId));
    } catch (error) {
      safeSyncError(res, error);
    }
  });

  app.post('/api/sync/test', async (req, res) => {
    try {
      const targetId = actionTargetId(req.body);
      res.json(await testSyncTarget(targetId));
    } catch (error) {
      safeSyncError(res, error);
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const waitForRefresh = req.query.fresh === '1' || req.query.fresh === 'true';
      // tzOffset：查看者时区偏移（分钟，UTC+X），缺省按 UTC 归日
      const data = await getStats({ waitForRefresh, tzOffsetMinutes: req.query.tzOffset });
      res.json(data);
    } catch (err) {
      console.error('Error aggregating stats:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      const full = req.query.full === '1' || req.query.full === 'true';
      const result = await refreshStatsCache({ full });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/pricing - 获取当前价格配置（含 revision；配置损坏时附 validationErrors）
  app.get('/api/pricing', async (req, res) => {
    try {
      const { config, validationErrors } = await getPricingConfigDetailed();
      res.json(validationErrors.length ? { ...config, validationErrors } : config);
    } catch (err) {
      console.error('Error loading pricing config:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/pricing - 更新价格配置（信封 { config, baseRevision }，乐观锁）
  app.put('/api/pricing', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object'
          || typeof body.baseRevision !== 'number') {
        return res.status(400).json({ code: 'PRICING_BAD_REQUEST', error: '请求体须为 { config, baseRevision }' });
      }
      const result = await updatePricingConfig(body.config, { baseRevision: body.baseRevision });
      res.json(result);
    } catch (err) {
      if (err.code === 'PRICING_REVISION_CONFLICT') {
        return res.status(409).json({ code: err.code, error: err.message, current: err.current });
      }
      console.error('Error updating pricing config:', err);
      res.status(422).json({ code: 'PRICING_VALIDATION_FAILED', error: err.message });
    }
  });

  // POST /api/pricing/reset - 重置为默认 v2（空）配置，无条件强制写入
  app.post('/api/pricing/reset', async (req, res) => {
    try {
      const result = await updatePricingConfig(defaultPricingConfigV2());
      res.json(result);
    } catch (err) {
      console.error('Error resetting pricing config:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/pricing/candidates - 确认队列（含 dismissed，前端过滤）
  app.get('/api/pricing/candidates', async (req, res) => {
    try {
      res.json(await loadCandidates());
    } catch (err) {
      console.error('Error loading pricing candidates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pricing/candidates/resolve - 批量决议 { resolutions: [{ observedKey, action, catalogId? }] }
  app.post('/api/pricing/candidates/resolve', async (req, res) => {
    try {
      const resolutions = req.body?.resolutions;
      if (!Array.isArray(resolutions)) {
        return res.status(400).json({ code: 'PRICING_BAD_REQUEST', error: '请求体须为 { resolutions: [...] }' });
      }
      const result = await applyCandidateResolutions(resolutions);
      invalidateStatsCache(); // accept 会改 rules/aliases → 触发 re-merge
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error resolving pricing candidates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pricing/rematch - 对 stats 中未覆盖模型批量重扫 models.dev
  app.post('/api/pricing/rematch', async (req, res) => {
    try {
      const data = await getStats();
      const keys = Object.keys(data.byModel || {});
      const result = await rematchObservedKeys(keys);
      if (result.matched > 0) invalidateStatsCache();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error rematching pricing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/openclaw/models - openclaw.json 中有/无单价模型 + 与自定义价对照
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

  // GET /api/models-dev/models - models.dev 在线目录（只读，磁盘缓存 24h，先旧后新）
  app.get('/api/models-dev/models', async (req, res) => {
    try {
      const data = await getModelsDevCatalog();
      res.json(data);
    } catch (err) {
      console.error('Error fetching models.dev catalog:', err);
      res.status(502).json({ error: err.message });
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

  // 未知 /api/* 返回 JSON 404，不回退到 HTML
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // 仅托管 dist/，禁止暴露仓库其它内容
  if (existsSync(resolvedStaticDir)) {
    app.use(express.static(resolvedStaticDir, {
      index: ['index.html'],
      fallthrough: true,
      redirect: false,
    }));
  }

  // 未知页面 / 非 GET·HEAD 未知请求：404，不得返回 HTML 200
  app.use((req, res) => {
    res.status(404).type('text').send('Not Found');
  });

  return app;
}

/**
 * 启动生产态 HTTP 服务（仅直接运行 server.js 时调用）
 */
export function startServer() {
  let port;
  let host;
  try {
    port = resolveListenPort();
    host = resolveListenHost();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`OpenClaw Usage running at http://${host}:${port}`);
    console.log(`Reading sessions from SQLite: ${getSqlitePath()}`);
  });

  server.on('error', (err) => {
    console.error(`Failed to listen on ${host}:${port}:`, err.message);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
    // 短暂等待现有请求结束后强制退出
    setTimeout(() => {
      console.error('Graceful shutdown timed out, exiting');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// 仅在直接运行 `node server.js` 时监听
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  startServer();
}
