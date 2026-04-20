/**
 * 按日期区间重切聚合数据。
 * 从 main.js 抽离以便独立单元测试。
 */

export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
}

export function mergeInto(dst, src) {
  dst.input += src.input || 0;
  dst.output += src.output || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheWrite += src.cacheWrite || 0;
  dst.totalTokens += src.totalTokens || 0;
  dst.totalCost += src.totalCost || 0;
  dst.requests += src.requests || 0;
}

export function collapseCrossTable(crossTable, from, to) {
  const result = {};
  for (const [date, keyMap] of Object.entries(crossTable)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (!result[key]) result[key] = emptyBucket();
      mergeInto(result[key], stats);
    }
  }
  return result;
}

/**
 * 基于交叉聚合表对数据做日期筛选，返回精确的 summary / byProvider / byModel / byDate / sessions。
 * @param {Object} fullData
 * @param {string|null} from YYYY-MM-DD
 * @param {string|null} to YYYY-MM-DD
 */
export function filterDataByDateRange(fullData, from, to) {
  if (!from && !to) return fullData;

  const filteredByDate = {};
  for (const [date, stats] of Object.entries(fullData.byDate || {})) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    filteredByDate[date] = stats;
  }

  const summary = {
    totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
    totalTokens: 0, totalCost: 0, totalRequests: 0, totalSessions: 0,
  };
  for (const stats of Object.values(filteredByDate)) {
    summary.totalInput += stats.input;
    summary.totalOutput += stats.output;
    summary.totalCacheRead += stats.cacheRead;
    summary.totalCacheWrite += stats.cacheWrite;
    summary.totalTokens += stats.totalTokens;
    summary.totalCost += stats.totalCost;
    summary.totalRequests += stats.requests;
  }

  const byProvider = collapseCrossTable(fullData.byDateProvider || {}, from, to);
  const byModelRaw = collapseCrossTable(fullData.byDateModel || {}, from, to);

  // byModel 需要额外带上 provider/model 便于图表展示
  const byModel = {};
  for (const [key, stats] of Object.entries(byModelRaw)) {
    const slashIdx = key.indexOf('/');
    const provider = slashIdx > 0 ? key.slice(0, slashIdx) : key;
    const model = slashIdx > 0 ? key.slice(slashIdx + 1) : '';
    byModel[key] = { provider, model, ...stats };
  }

  // 会话明细：只保留 byDate 交集内的聚合（非整期）
  const filteredSessions = [];
  for (const s of fullData.sessions || []) {
    if (!s.byDate) {
      // 兼容后端未提供 byDate 的情形：按 overlap 保留整期数据
      if (!s.lastTimestamp && !s.firstTimestamp) continue;
      const first = (s.firstTimestamp || s.lastTimestamp).slice(0, 10);
      const last = (s.lastTimestamp || s.firstTimestamp).slice(0, 10);
      if (from && last < from) continue;
      if (to && first > to) continue;
      filteredSessions.push(s);
      continue;
    }

    const bucket = emptyBucket();
    let hit = false;
    for (const [date, stats] of Object.entries(s.byDate)) {
      if (from && date < from) continue;
      if (to && date > to) continue;
      mergeInto(bucket, stats);
      hit = true;
    }
    if (!hit) continue;

    filteredSessions.push({
      ...s,
      totalInput: bucket.input,
      totalOutput: bucket.output,
      totalCacheRead: bucket.cacheRead,
      totalCacheWrite: bucket.cacheWrite,
      totalTokens: bucket.totalTokens,
      totalCost: bucket.totalCost,
      requestCount: bucket.requests,
    });
  }

  summary.totalSessions = filteredSessions.length;

  return {
    summary,
    byProvider,
    byModel,
    byDate: filteredByDate,
    byDateProvider: fullData.byDateProvider,
    byDateModel: fullData.byDateModel,
    sessions: filteredSessions,
    generatedAt: fullData.generatedAt,
  };
}
