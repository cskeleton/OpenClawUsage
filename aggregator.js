import { readdirSync, statSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { createInterface } from 'readline';
import { loadPricingConfig, calculateCostFromUsage } from './pricing.js';
import { getOpenClawConfigDir } from './openclaw-config.js';

/**
 * 解析 sessions 目录（跟随 OPENCLAW_CONFIG_DIR，与 models.json 同源）。
 * @returns {string}
 */
export function getSessionDir() {
  return join(getOpenClawConfigDir(), 'agents', 'main', 'sessions');
}

/**
 * 把文件名中压缩过的时间戳（冒号被替换为连字符）还原为 ISO 字符串。
 * 仅替换 `T` 之后的时分秒，保留日期部分的连字符。
 * @param {string} raw 文件名里 `.reset.` / `.deleted.` 后的时间串，如 `2026-04-15T13-05-48.786Z`
 * @returns {string}
 */
export function normalizeArchivedAt(raw) {
  return raw.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
}

/**
 * Determine session status and ID from filename
 */
export function parseSessionFile(filename) {
  const base = basename(filename);

  // Skip non-session files (sessions.json 索引、其他 *.json 元数据)
  if (base.endsWith('.json')) return null;
  if (base.startsWith('probe-')) return null;

  // Skip checkpoint 变体：避免与主文件/reset 副本双重计数
  if (base.includes('.checkpoint.')) return null;

  // Extract UUID from filename
  const uuidMatch = base.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!uuidMatch) return null;

  const sessionId = uuidMatch[1];

  let status = 'active';
  let archivedAt = null;

  if (base.includes('.jsonl.reset.')) {
    status = 'reset';
    const tsMatch = base.match(/\.reset\.(.+)$/);
    if (tsMatch) archivedAt = normalizeArchivedAt(tsMatch[1]);
  } else if (base.includes('.jsonl.deleted.')) {
    status = 'deleted';
    const tsMatch = base.match(/\.deleted\.(.+)$/);
    if (tsMatch) archivedAt = normalizeArchivedAt(tsMatch[1]);
  } else if (!base.endsWith('.jsonl')) {
    return null; // Unknown format
  }

  return { sessionId, status, archivedAt, filename: base };
}

/**
 * Parse a single JSONL file and extract usage records
 * @param {string} filepath - 文件路径
 * @param {Object|null} pricingConfig - 价格配置对象，null 表示使用 OpenClaw 原始成本
 */
export async function parseSessionJsonl(filepath, pricingConfig) {
  const records = [];

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filepath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'message') return;

        const msg = obj.message;
        if (!msg || !msg.usage) return;

        // Filter out OpenClaw internal messages (gateway-injected, delivery-mirror)
        if (msg.provider === 'openclaw') return;

        const usage = {
          input: msg.usage.input || 0,
          output: msg.usage.output || 0,
          cacheRead: msg.usage.cacheRead || 0,
          cacheWrite: msg.usage.cacheWrite || 0,
          totalTokens: msg.usage.totalTokens || 0,
          cost: {
            input: msg.usage.cost?.input || 0,
            output: msg.usage.cost?.output || 0,
            cacheRead: msg.usage.cost?.cacheRead || 0,
            cacheWrite: msg.usage.cost?.cacheWrite || 0,
            total: msg.usage.cost?.total || 0,
          },
        };

        records.push({
          provider: msg.provider || 'unknown',
          model: msg.model || 'unknown',
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          },
          cost: calculateCostFromUsage(usage, msg.provider, msg.model, pricingConfig),
          timestamp: obj.timestamp || null,
        });
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(records));
    rl.on('error', reject);
  });
}

/**
 * 初始化空统计桶（summary / byProvider[x] / byModel[x] / byDate[x] 通用结构）
 */
function emptyBucket() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    requests: 0,
  };
}

/**
 * 在日期+键维度上累加一条记录。
 * @param {Record<string, Record<string, ReturnType<typeof emptyBucket>>>} table
 * @param {string} date
 * @param {string} key
 * @param {Object} rec
 */
function addToCrossTable(table, date, key, rec) {
  if (!table[date]) table[date] = {};
  if (!table[date][key]) table[date][key] = emptyBucket();
  const b = table[date][key];
  b.input += rec.usage.input;
  b.output += rec.usage.output;
  b.cacheRead += rec.usage.cacheRead;
  b.cacheWrite += rec.usage.cacheWrite;
  b.totalTokens += rec.usage.totalTokens;
  b.totalCost += rec.cost.total;
  b.requests += 1;
}

/**
 * 按 key 排序对象 key（浅拷贝）
 */
function sortedObject(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((k) => {
    out[k] = obj[k];
  });
  return out;
}

/**
 * Aggregate all session data
 * @param {Object|null} pricingConfig - 价格配置对象，null 时自动加载
 */
export async function aggregateStats(pricingConfig = null) {
  if (!pricingConfig) {
    pricingConfig = await loadPricingConfig();
  }

  const sessionDir = getSessionDir();

  let files;
  try {
    files = readdirSync(sessionDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // sessions 目录不存在：返回空聚合而不是抛错
      return {
        summary: {
          totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
          totalTokens: 0, totalCost: 0, totalRequests: 0, totalSessions: 0,
        },
        byProvider: {},
        byModel: {},
        byDate: {},
        byDateProvider: {},
        byDateModel: {},
        sessions: [],
        generatedAt: new Date().toISOString(),
      };
    }
    throw err;
  }

  const summary = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    totalRequests: 0,
    totalSessions: 0,
  };

  const byProvider = {};
  const byModel = {};
  const byDate = {};
  /** 日期 × provider */
  const byDateProvider = {};
  /** 日期 × `provider/model` */
  const byDateModel = {};
  const sessions = [];

  for (const file of files) {
    const meta = parseSessionFile(file);
    if (!meta) continue;

    const filepath = join(sessionDir, file);

    let records;
    try {
      records = await parseSessionJsonl(filepath, pricingConfig);
    } catch (err) {
      // 单个文件失败不影响整体聚合
      console.warn(`[aggregator] 跳过 ${file}: ${err.message}`);
      continue;
    }

    if (records.length === 0) continue;

    summary.totalSessions++;

    const sessionStats = {
      id: meta.sessionId,
      status: meta.status,
      archivedAt: meta.archivedAt,
      filename: meta.filename,
      providers: new Set(),
      models: new Set(),
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      requestCount: records.length,
      firstTimestamp: null,
      lastTimestamp: null,
      /** 会话内的按日分布，供前端筛选时切片 */
      byDate: {},
    };

    for (const rec of records) {
      // Update summary
      summary.totalInput += rec.usage.input;
      summary.totalOutput += rec.usage.output;
      summary.totalCacheRead += rec.usage.cacheRead;
      summary.totalCacheWrite += rec.usage.cacheWrite;
      summary.totalTokens += rec.usage.totalTokens;
      summary.totalCost += rec.cost.total;
      summary.totalRequests++;

      // Update session stats
      sessionStats.providers.add(rec.provider);
      sessionStats.models.add(rec.model);
      sessionStats.totalInput += rec.usage.input;
      sessionStats.totalOutput += rec.usage.output;
      sessionStats.totalCacheRead += rec.usage.cacheRead;
      sessionStats.totalCacheWrite += rec.usage.cacheWrite;
      sessionStats.totalTokens += rec.usage.totalTokens;
      sessionStats.totalCost += rec.cost.total;

      if (rec.timestamp) {
        if (!sessionStats.firstTimestamp || rec.timestamp < sessionStats.firstTimestamp) {
          sessionStats.firstTimestamp = rec.timestamp;
        }
        if (!sessionStats.lastTimestamp || rec.timestamp > sessionStats.lastTimestamp) {
          sessionStats.lastTimestamp = rec.timestamp;
        }
      }

      // By provider
      if (!byProvider[rec.provider]) byProvider[rec.provider] = emptyBucket();
      const p = byProvider[rec.provider];
      p.input += rec.usage.input;
      p.output += rec.usage.output;
      p.cacheRead += rec.usage.cacheRead;
      p.cacheWrite += rec.usage.cacheWrite;
      p.totalTokens += rec.usage.totalTokens;
      p.totalCost += rec.cost.total;
      p.requests++;

      // By model
      const modelKey = `${rec.provider}/${rec.model}`;
      if (!byModel[modelKey]) {
        byModel[modelKey] = { provider: rec.provider, model: rec.model, ...emptyBucket() };
      }
      const m = byModel[modelKey];
      m.input += rec.usage.input;
      m.output += rec.usage.output;
      m.cacheRead += rec.usage.cacheRead;
      m.cacheWrite += rec.usage.cacheWrite;
      m.totalTokens += rec.usage.totalTokens;
      m.totalCost += rec.cost.total;
      m.requests++;

      // By date 及交叉聚合
      if (rec.timestamp) {
        const date = rec.timestamp.substring(0, 10);
        if (!byDate[date]) byDate[date] = emptyBucket();
        const d = byDate[date];
        d.input += rec.usage.input;
        d.output += rec.usage.output;
        d.cacheRead += rec.usage.cacheRead;
        d.cacheWrite += rec.usage.cacheWrite;
        d.totalTokens += rec.usage.totalTokens;
        d.totalCost += rec.cost.total;
        d.requests++;

        addToCrossTable(byDateProvider, date, rec.provider, rec);
        addToCrossTable(byDateModel, date, modelKey, rec);

        // 会话内按日
        if (!sessionStats.byDate[date]) sessionStats.byDate[date] = emptyBucket();
        const sd = sessionStats.byDate[date];
        sd.input += rec.usage.input;
        sd.output += rec.usage.output;
        sd.cacheRead += rec.usage.cacheRead;
        sd.cacheWrite += rec.usage.cacheWrite;
        sd.totalTokens += rec.usage.totalTokens;
        sd.totalCost += rec.cost.total;
        sd.requests++;
      }
    }

    sessions.push({
      ...sessionStats,
      providers: [...sessionStats.providers],
      models: [...sessionStats.models],
    });
  }

  sessions.sort((a, b) => {
    if (!a.lastTimestamp) return 1;
    if (!b.lastTimestamp) return -1;
    return b.lastTimestamp.localeCompare(a.lastTimestamp);
  });

  return {
    summary,
    byProvider,
    byModel,
    byDate: sortedObject(byDate),
    byDateProvider: sortedObject(byDateProvider),
    byDateModel: sortedObject(byDateModel),
    sessions,
    generatedAt: new Date().toISOString(),
  };
}
