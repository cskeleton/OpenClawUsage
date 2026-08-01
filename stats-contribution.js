import { statSync } from 'fs';
import { parseSessionJsonlRaw } from './aggregator.js';
import { calculateCostFromUsage } from './pricing.js';

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
  return cost.total;
}

/**
 * 从单个 Session 文件构建与定价无关的逐文件贡献
 * @param {string} filepath
 * @param {{ sessionId: string, status: string, archivedAt: string|null, filename: string }} meta
 * @returns {Promise<object>}
 */
export async function buildFileContribution(filepath, meta) {
  const st = statSync(filepath);
  const records = await parseSessionJsonlRaw(filepath);

  /** @type {Record<string, object>} */
  const bucketMap = {};
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const rec of records) {
    const date = rec.timestamp ? rec.timestamp.substring(0, 10) : null;
    const key = `${date ?? ''}\0${rec.provider}\0${rec.model}`;
    if (!bucketMap[key]) {
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
      id: meta.sessionId,
      status: meta.status,
      archivedAt: meta.archivedAt,
      filename: meta.filename,
    },
    identity: { size: st.size, mtimeMs: st.mtimeMs },
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
  if (!table[date]) table[date] = {};
  if (!table[date][key]) table[date][key] = emptyBucket();
  const b = table[date][key];
  b.input += usage.input;
  b.output += usage.output;
  b.cacheRead += usage.cacheRead;
  b.cacheWrite += usage.cacheWrite;
  b.totalTokens += usage.totalTokens;
  b.totalCost += cost;
  b.requests += requests;
}

function sortedObject(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((k) => {
    out[k] = obj[k];
  });
  return out;
}

/**
 * 合并逐文件贡献并应用当前定价，生成完整统计
 * @param {Record<string, object>} filesMap filename -> contribution
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

  const byProvider = {};
  const byModel = {};
  const byDate = {};
  const byDateProvider = {};
  const byDateModel = {};
  const sessions = [];

  for (const contribution of Object.values(filesMap)) {
    if (!contribution.hasRecords) continue;

    summary.totalSessions += 1;

    const sessionStats = {
      id: contribution.session.id,
      status: contribution.session.status,
      archivedAt: contribution.session.archivedAt,
      filename: contribution.session.filename,
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
      byDate: {},
    };

    for (const bucket of contribution.buckets) {
      const cost = costForBucket(bucket, pricingConfig);
      const usage = bucket.usage;

      summary.totalInput += usage.input;
      summary.totalOutput += usage.output;
      summary.totalCacheRead += usage.cacheRead;
      summary.totalCacheWrite += usage.cacheWrite;
      summary.totalTokens += usage.totalTokens;
      summary.totalCost += cost;
      summary.totalRequests += bucket.requests;

      sessionStats.providers.add(bucket.provider);
      sessionStats.models.add(bucket.model);
      sessionStats.totalInput += usage.input;
      sessionStats.totalOutput += usage.output;
      sessionStats.totalCacheRead += usage.cacheRead;
      sessionStats.totalCacheWrite += usage.cacheWrite;
      sessionStats.totalTokens += usage.totalTokens;
      sessionStats.totalCost += cost;
      sessionStats.requestCount += bucket.requests;

      if (!byProvider[bucket.provider]) byProvider[bucket.provider] = emptyBucket();
      const p = byProvider[bucket.provider];
      p.input += usage.input;
      p.output += usage.output;
      p.cacheRead += usage.cacheRead;
      p.cacheWrite += usage.cacheWrite;
      p.totalTokens += usage.totalTokens;
      p.totalCost += cost;
      p.requests += bucket.requests;

      const modelKey = `${bucket.provider}/${bucket.model}`;
      if (!byModel[modelKey]) {
        byModel[modelKey] = { provider: bucket.provider, model: bucket.model, ...emptyBucket() };
      }
      const m = byModel[modelKey];
      m.input += usage.input;
      m.output += usage.output;
      m.cacheRead += usage.cacheRead;
      m.cacheWrite += usage.cacheWrite;
      m.totalTokens += usage.totalTokens;
      m.totalCost += cost;
      m.requests += bucket.requests;

      if (bucket.date) {
        const date = bucket.date;
        if (!byDate[date]) byDate[date] = emptyBucket();
        const d = byDate[date];
        d.input += usage.input;
        d.output += usage.output;
        d.cacheRead += usage.cacheRead;
        d.cacheWrite += usage.cacheWrite;
        d.totalTokens += usage.totalTokens;
        d.totalCost += cost;
        d.requests += bucket.requests;

        addToCrossTable(byDateProvider, date, bucket.provider, usage, cost, bucket.requests);
        addToCrossTable(byDateModel, date, modelKey, usage, cost, bucket.requests);

        if (!sessionStats.byDate[date]) sessionStats.byDate[date] = emptyBucket();
        const sd = sessionStats.byDate[date];
        sd.input += usage.input;
        sd.output += usage.output;
        sd.cacheRead += usage.cacheRead;
        sd.cacheWrite += usage.cacheWrite;
        sd.totalTokens += usage.totalTokens;
        sd.totalCost += cost;
        sd.requests += bucket.requests;
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
    byProvider: {},
    byModel: {},
    byDate: {},
    byDateProvider: {},
    byDateModel: {},
    sessions: [],
    generatedAt: new Date().toISOString(),
  };
}
