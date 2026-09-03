import { calculateCostFromUsage } from './pricing.js';

/**
 * 合并结果（`stats`）的形状版本。
 * 逐文件贡献（`files`）结构不变、仅合并输出新增字段时递增本值：
 * 读盘时形状不匹配则从 `files` 重新合并，无需重新解析 JSONL。
 * v2：session 增加 `byDateModel`（日期 × provider/model 交叉表）
 * v3：贡献 bucket 按 UTC 小时分桶；合并输出新增 `byHourModel`（小时 × provider/model），
 *     `byDate` 等日级表由小时 bucket 上卷（bucket.date 截前 10 位）
 */
export const STATS_SHAPE_VERSION = 3;

function dynamicMap() {
  return Object.create(null);
}

const MAX_SAFE_AGGREGATE = Number.MAX_SAFE_INTEGER;

function addAggregate(target, field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`unsafe statistics aggregate value: ${field}`);
  }
  const next = target[field] + value;
  if (!Number.isFinite(next) || next > MAX_SAFE_AGGREGATE) {
    throw new Error(`statistics aggregate exceeds safe range: ${field}`);
  }
  target[field] = next;
}

/**
 * Put a source boundary around contribution keys and session display IDs.
 * Imported snapshots intentionally carry no local contribution keys; local
 * contributions may retain their key because it is already local data. The
 * returned map never mutates the cache or snapshot.
 */
export function namespaceFileContributions(
  filesMap,
  sourceId,
  sourceLabel,
  { imported = false } = {}
) {
  if (typeof sourceId !== 'string' || !sourceId) throw new Error('sourceId is required');
  const prefix = `${sourceId}:`;
  const output = dynamicMap();
  for (const [key, contribution] of Object.entries(filesMap || {})) {
    const session = { ...(contribution?.session || {}) };
    if (typeof session.id === 'string') {
      session.id = `${prefix}${session.id}`;
    }
    output[`${prefix}${key}`] = {
      ...contribution,
      session,
      sourceId,
      sourceLabel,
    };
  }
  return output;
}

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

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function emptyOpenclawCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * 计算单条 bucket 在当前定价下的费用
 * @param {object} bucket
 * @param {object} pricingConfig
 * @returns {number}
 */
function costForBucket(bucket, pricingConfig) {
  const usageForCost = {
    input: bucket.usage.input,
    output: bucket.usage.output,
    cacheRead: bucket.usage.cacheRead,
    cacheWrite: bucket.usage.cacheWrite,
    totalTokens: bucket.usage.totalTokens,
    cost: bucket.openclawCost,
  };
  const cost = calculateCostFromUsage(
    usageForCost,
    bucket.provider,
    bucket.model,
    pricingConfig
  );
  if (!cost || typeof cost.total !== 'number' || !Number.isFinite(cost.total) || cost.total < 0) {
    throw new Error('unsafe statistics aggregate value: totalCost');
  }
  return cost.total;
}

/**
 * 从原始用量记录流构建与定价无关的会话贡献。
 * 记录来源可以是 SQLite transcript_events 或解压后的归档 blob，
 * 形状与旧 JSONL 解析输出一致。
 * @param {{ id: string, status: string, archivedAt: string|null }} session
 * @param {Array<{ provider: string, model: string, usage: object, openclawCost: object, timestamp: string|null }>} records
 * @returns {object}
 */
export function buildContributionFromRecords(session, records) {
  /** @type {Record<string, object>} */
  const bucketMap = dynamicMap();
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const rec of records) {
    // UTC 小时粒度（"YYYY-MM-DDTHH"）：日级聚合由 mergeFileContributions 上卷
    const date = rec.timestamp ? rec.timestamp.substring(0, 13) : null;
    const key = `${date ?? ''}\0${rec.provider}\0${rec.model}`;
    if (!Object.hasOwn(bucketMap, key)) {
      bucketMap[key] = {
        date,
        provider: rec.provider,
        model: rec.model,
        usage: emptyUsage(),
        openclawCost: emptyOpenclawCost(),
        requests: 0,
      };
    }
    const b = bucketMap[key];
    b.usage.input += rec.usage.input;
    b.usage.output += rec.usage.output;
    b.usage.cacheRead += rec.usage.cacheRead;
    b.usage.cacheWrite += rec.usage.cacheWrite;
    b.usage.totalTokens += rec.usage.totalTokens;
    b.openclawCost.input += rec.openclawCost.input;
    b.openclawCost.output += rec.openclawCost.output;
    b.openclawCost.cacheRead += rec.openclawCost.cacheRead;
    b.openclawCost.cacheWrite += rec.openclawCost.cacheWrite;
    b.openclawCost.total += rec.openclawCost.total;
    b.requests += 1;

    if (rec.timestamp) {
      if (!firstTimestamp || rec.timestamp < firstTimestamp) firstTimestamp = rec.timestamp;
      if (!lastTimestamp || rec.timestamp > lastTimestamp) lastTimestamp = rec.timestamp;
    }
  }

  return {
    session: {
      id: session.id,
      status: session.status,
      archivedAt: session.archivedAt,
    },
    buckets: Object.values(bucketMap),
    hasRecords: records.length > 0,
    firstTimestamp,
    lastTimestamp,
  };
}

/**
 * 在日期+键维度上累加
 */
function addToCrossTable(table, date, key, usage, cost, requests) {
  if (!Object.hasOwn(table, date)) table[date] = dynamicMap();
  if (!Object.hasOwn(table[date], key)) table[date][key] = emptyBucket();
  const b = table[date][key];
  addAggregate(b, 'input', usage.input);
  addAggregate(b, 'output', usage.output);
  addAggregate(b, 'cacheRead', usage.cacheRead);
  addAggregate(b, 'cacheWrite', usage.cacheWrite);
  addAggregate(b, 'totalTokens', usage.totalTokens);
  addAggregate(b, 'totalCost', cost);
  addAggregate(b, 'requests', requests);
}

function sortedObject(obj) {
  const out = dynamicMap();
  Object.keys(obj).sort().forEach((k) => {
    out[k] = obj[k];
  });
  return out;
}

/**
 * 合并逐文件贡献并应用当前定价，生成完整统计
 * @param {Record<string, object>} filesMap contributionKey -> contribution
 * @param {object} pricingConfig
 * @returns {object}
 */
export function mergeFileContributions(filesMap, pricingConfig) {
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

  const byProvider = dynamicMap();
  const byModel = dynamicMap();
  const byDate = dynamicMap();
  const byDateProvider = dynamicMap();
  const byDateModel = dynamicMap();
  const byHourModel = dynamicMap();
  const sessions = [];

  for (const contribution of Object.values(filesMap)) {
    if (!contribution.hasRecords) continue;

    addAggregate(summary, 'totalSessions', 1);

    const sessionStats = {
      id: contribution.session.id,
      status: contribution.session.status,
      archivedAt: contribution.session.archivedAt,
      ...(typeof contribution.sourceId === 'string'
        ? { sourceId: contribution.sourceId, sourceLabel: contribution.sourceLabel }
        : {}),
      providers: new Set(),
      models: new Set(),
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      requestCount: 0,
      firstTimestamp: contribution.firstTimestamp,
      lastTimestamp: contribution.lastTimestamp,
      byDate: dynamicMap(),
      /** 会话内「日期 × provider/model」交叉分布，供 provider/model 筛选精确切片 */
      byDateModel: dynamicMap(),
    };

    for (const bucket of contribution.buckets) {
      const cost = costForBucket(bucket, pricingConfig);
      const usage = bucket.usage;

      addAggregate(summary, 'totalInput', usage.input);
      addAggregate(summary, 'totalOutput', usage.output);
      addAggregate(summary, 'totalCacheRead', usage.cacheRead);
      addAggregate(summary, 'totalCacheWrite', usage.cacheWrite);
      addAggregate(summary, 'totalTokens', usage.totalTokens);
      addAggregate(summary, 'totalCost', cost);
      addAggregate(summary, 'totalRequests', bucket.requests);

      sessionStats.providers.add(bucket.provider);
      sessionStats.models.add(bucket.model);
      addAggregate(sessionStats, 'totalInput', usage.input);
      addAggregate(sessionStats, 'totalOutput', usage.output);
      addAggregate(sessionStats, 'totalCacheRead', usage.cacheRead);
      addAggregate(sessionStats, 'totalCacheWrite', usage.cacheWrite);
      addAggregate(sessionStats, 'totalTokens', usage.totalTokens);
      addAggregate(sessionStats, 'totalCost', cost);
      addAggregate(sessionStats, 'requestCount', bucket.requests);

      if (!Object.hasOwn(byProvider, bucket.provider)) byProvider[bucket.provider] = emptyBucket();
      const p = byProvider[bucket.provider];
      addAggregate(p, 'input', usage.input);
      addAggregate(p, 'output', usage.output);
      addAggregate(p, 'cacheRead', usage.cacheRead);
      addAggregate(p, 'cacheWrite', usage.cacheWrite);
      addAggregate(p, 'totalTokens', usage.totalTokens);
      addAggregate(p, 'totalCost', cost);
      addAggregate(p, 'requests', bucket.requests);

      const modelKey = `${bucket.provider}/${bucket.model}`;
      if (!Object.hasOwn(byModel, modelKey)) {
        byModel[modelKey] = { provider: bucket.provider, model: bucket.model, ...emptyBucket() };
      }
      const m = byModel[modelKey];
      addAggregate(m, 'input', usage.input);
      addAggregate(m, 'output', usage.output);
      addAggregate(m, 'cacheRead', usage.cacheRead);
      addAggregate(m, 'cacheWrite', usage.cacheWrite);
      addAggregate(m, 'totalTokens', usage.totalTokens);
      addAggregate(m, 'totalCost', cost);
      addAggregate(m, 'requests', bucket.requests);

      if (bucket.date) {
        // bucket.date 为 UTC 小时键（"YYYY-MM-DDTHH"）；日级表统一上卷到前 10 位
        const date = bucket.date.slice(0, 10);
        // 旧快照的日级 bucket（无 'T'）不进小时表，避免污染单日按小时视图
        if (bucket.date.length > 10) {
          addToCrossTable(byHourModel, bucket.date, modelKey, usage, cost, bucket.requests);
        }
        if (!Object.hasOwn(byDate, date)) byDate[date] = emptyBucket();
        const d = byDate[date];
        addAggregate(d, 'input', usage.input);
        addAggregate(d, 'output', usage.output);
        addAggregate(d, 'cacheRead', usage.cacheRead);
        addAggregate(d, 'cacheWrite', usage.cacheWrite);
        addAggregate(d, 'totalTokens', usage.totalTokens);
        addAggregate(d, 'totalCost', cost);
        addAggregate(d, 'requests', bucket.requests);

        addToCrossTable(byDateProvider, date, bucket.provider, usage, cost, bucket.requests);
        addToCrossTable(byDateModel, date, modelKey, usage, cost, bucket.requests);

        if (!Object.hasOwn(sessionStats.byDate, date)) sessionStats.byDate[date] = emptyBucket();
        const sd = sessionStats.byDate[date];
        addAggregate(sd, 'input', usage.input);
        addAggregate(sd, 'output', usage.output);
        addAggregate(sd, 'cacheRead', usage.cacheRead);
        addAggregate(sd, 'cacheWrite', usage.cacheWrite);
        addAggregate(sd, 'totalTokens', usage.totalTokens);
        addAggregate(sd, 'totalCost', cost);
        addAggregate(sd, 'requests', bucket.requests);

        addToCrossTable(sessionStats.byDateModel, date, modelKey, usage, cost, bucket.requests);
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
    byHourModel: sortedObject(byHourModel),
    sessions,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 构建空统计（Session 目录不存在或为空）
 * @returns {object}
 */
export function buildEmptyStats() {
  return {
    summary: {
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      totalRequests: 0,
      totalSessions: 0,
    },
    byProvider: dynamicMap(),
    byModel: dynamicMap(),
    byDate: dynamicMap(),
    byDateProvider: dynamicMap(),
    byDateModel: dynamicMap(),
    byHourModel: dynamicMap(),
    sessions: [],
    generatedAt: new Date().toISOString(),
  };
}
