/**
 * 按日期区间 + provider/model 维度重切聚合数据。
 * 从 main.js 抽离以便独立单元测试。
 */

export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
}

function dynamicMap() {
  return Object.create(null);
}

function emptySummary() {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    totalRequests: 0,
    totalSessions: 0,
  };
}

/**
 * Return the aggregate backing a source selector. `all` deliberately returns
 * the response's top-level aggregate so existing callers keep object identity.
 * A configured source without a snapshot gets a valid empty aggregate instead
 * of accidentally retaining the previous source's data.
 */
export function selectSourceData(fullData, sourceId = 'all') {
  if (!fullData || !sourceId || sourceId === 'all') return fullData;
  const statsBySource = fullData.statsBySource || {};
  if (Object.hasOwn(statsBySource, sourceId) && statsBySource[sourceId]) {
    return statsBySource[sourceId];
  }
  const source = (fullData.sources || []).find((item) => item.id === sourceId);
  return {
    summary: emptySummary(),
    byDate: dynamicMap(),
    byDateProvider: dynamicMap(),
    byDateModel: dynamicMap(),
    byHourModel: dynamicMap(),
    sessions: [],
    generatedAt: null,
    sourceId,
    sourceLabel: source?.label || sourceId,
  };
}

/**
 * Stable selector options. Status is retained so the UI can communicate
 * missing/stale imports while still allowing them to be selected.
 */
export function sourceOptions(fullData) {
  return [
    { id: 'all', label: 'All sources', status: 'all' },
    ...(fullData?.sources || []).map((source) => ({
      id: source.id,
      label: source.label || source.id,
      status: source.status || 'fresh',
    })),
  ];
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
  const result = dynamicMap();
  for (const [date, keyMap] of Object.entries(crossTable)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (!Object.hasOwn(result, key)) result[key] = emptyBucket();
      mergeInto(result[key], stats);
    }
  }
  return result;
}

/** 从 `provider/model` 键中取 provider 段 */
export function providerOfKey(key) {
  const idx = key.indexOf('/');
  return idx > 0 ? key.slice(0, idx) : key;
}

/** 从 `provider/model` 键中取 model 段 */
export function modelOfKey(key) {
  const idx = key.indexOf('/');
  return idx > 0 ? key.slice(idx + 1) : '';
}

/**
 * 构建 `provider/model` 键匹配器。
 * `model` 传入完整的 `provider/model` 键；同时给出 provider 时以 model 为准。
 * @param {{ provider?: string|null, model?: string|null }} filter
 * @returns {((key: string) => boolean)|null} 无维度筛选时返回 null
 */
export function buildKeyMatcher({ provider = null, model = null } = {}) {
  if (model) return (key) => key === model;
  if (provider) {
    const prefix = `${provider}/`;
    return (key) => key === provider || key.startsWith(prefix);
  }
  return null;
}

/** 日期是否落在区间内 */
function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/**
 * 由「UTC 小时 × provider/model」交叉表切出 byHour（小时 → 合计桶）。
 * from/to 为 YYYY-MM-DD，与小时键的日部分比较；matches 为空时不按维度过滤。
 * @param {Record<string, Record<string, object>>} byHourModel
 * @param {string|null} from
 * @param {string|null} to
 * @param {((key: string) => boolean)|null} [matches]
 */
export function sliceHourTable(byHourModel, from = null, to = null, matches = null) {
  const byHour = dynamicMap();
  for (const [hour, keyMap] of Object.entries(byHourModel || {})) {
    if (!inRange(hour.slice(0, 10), from, to)) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (matches && !matches(key)) continue;
      if (!Object.hasOwn(byHour, hour)) byHour[hour] = emptyBucket();
      mergeInto(byHour[hour], stats);
    }
  }
  return byHour;
}

/**
 * 由「日期 × provider/model」交叉表切出 byDate / byProvider / byModel
 * @param {Record<string, Record<string, object>>} byDateModel
 * @param {string|null} from
 * @param {string|null} to
 * @param {(key: string) => boolean} matches
 */
function sliceCrossTable(byDateModel, from, to, matches) {
  const byDate = dynamicMap();
  const byProvider = dynamicMap();
  const byModel = dynamicMap();

  for (const [date, keyMap] of Object.entries(byDateModel || {})) {
    if (!inRange(date, from, to)) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (!matches(key)) continue;

      if (!Object.hasOwn(byDate, date)) byDate[date] = emptyBucket();
      mergeInto(byDate[date], stats);

      const provider = providerOfKey(key);
      if (!Object.hasOwn(byProvider, provider)) byProvider[provider] = emptyBucket();
      mergeInto(byProvider[provider], stats);

      if (!Object.hasOwn(byModel, key)) {
        byModel[key] = { provider, model: modelOfKey(key), ...emptyBucket() };
      }
      mergeInto(byModel[key], stats);
    }
  }

  return { byDate, byProvider, byModel };
}

/** 由 byDate 汇总出 summary（不含 totalSessions） */
function summarizeByDate(byDate) {
  const summary = {
    totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
    totalTokens: 0, totalCost: 0, totalRequests: 0, totalSessions: 0,
  };
  for (const stats of Object.values(byDate)) {
    summary.totalInput += stats.input;
    summary.totalOutput += stats.output;
    summary.totalCacheRead += stats.cacheRead;
    summary.totalCacheWrite += stats.cacheWrite;
    summary.totalTokens += stats.totalTokens;
    summary.totalCost += stats.totalCost;
    summary.totalRequests += stats.requests;
  }
  return summary;
}

/** 用切片桶覆写会话的合计字段 */
function applyBucketToSession(session, bucket) {
  return {
    ...session,
    totalInput: bucket.input,
    totalOutput: bucket.output,
    totalCacheRead: bucket.cacheRead,
    totalCacheWrite: bucket.cacheWrite,
    totalTokens: bucket.totalTokens,
    totalCost: bucket.totalCost,
    requestCount: bucket.requests,
  };
}

/**
 * 无维度筛选时按日期切会话（保持原有行为）
 */
function sliceSessionByDate(session, from, to) {
  if (!session.byDate) {
    // 兼容后端未提供 byDate 的情形：按 overlap 保留整期数据
    if (!session.lastTimestamp && !session.firstTimestamp) return null;
    const first = (session.firstTimestamp || session.lastTimestamp).slice(0, 10);
    const last = (session.lastTimestamp || session.firstTimestamp).slice(0, 10);
    if (from && last < from) return null;
    if (to && first > to) return null;
    return session;
  }

  const bucket = emptyBucket();
  let hit = false;
  for (const [date, stats] of Object.entries(session.byDate)) {
    if (!inRange(date, from, to)) continue;
    mergeInto(bucket, stats);
    hit = true;
  }
  if (!hit) return null;
  return applyBucketToSession(session, bucket);
}

/**
 * 维度筛选下按「日期 ∩ provider/model」切会话。
 * 旧快照缺 `byDateModel` 时保守回退：按 providers / models 列表判断整行去留，
 * 数字仍是该会话在时间段内的全量合计（宁可偏大，也不静默丢数据）。
 */
function sliceSessionByKey(session, from, to, matches, filter) {
  if (!session.byDateModel) {
    if (!sessionMatchesLegacy(session, filter)) return null;
    return sliceSessionByDate(session, from, to);
  }

  const bucket = emptyBucket();
  let hit = false;
  for (const [date, keyMap] of Object.entries(session.byDateModel)) {
    if (!inRange(date, from, to)) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (!matches(key)) continue;
      mergeInto(bucket, stats);
      hit = true;
    }
  }
  if (!hit) return null;
  return applyBucketToSession(session, bucket);
}

/**
 * 旧快照回退匹配：session.models 存的是裸模型名，只能近似判断。
 * @param {object} session
 * @param {{ provider?: string|null, model?: string|null }} filter
 */
function sessionMatchesLegacy(session, { provider = null, model = null } = {}) {
  if (model) {
    const wantProvider = providerOfKey(model);
    const wantModel = modelOfKey(model);
    return (session.providers || []).includes(wantProvider)
      && (session.models || []).includes(wantModel);
  }
  if (provider) {
    return (session.providers || []).includes(provider);
  }
  return true;
}

/**
 * 基于交叉聚合表对数据做日期 + provider/model 筛选，
 * 返回精确的 summary / byProvider / byModel / byDate / sessions。
 * @param {Object} fullData
 * @param {{ from?: string|null, to?: string|null, provider?: string|null, model?: string|null }} [filter]
 *   from / to 为 YYYY-MM-DD；model 传完整 `provider/model` 键
 */
export function filterData(fullData, filter = {}) {
  const {
    from = null,
    to = null,
    provider = null,
    model = null,
    source = filter.source ?? filter.sourceId ?? 'all',
  } = filter;
  const sourceData = selectSourceData(fullData, source);
  const matches = buildKeyMatcher({ provider, model });

  if (!from && !to && !matches) {
    const base = source === 'all' ? fullData : sourceData;
    // 无小时表（旧快照）时保持原有对象身份契约
    if (!base.byHourModel) return base;
    return { ...base, byHour: sliceHourTable(base.byHourModel) };
  }

  let byDate;
  let byProvider;
  let byModel;

  if (matches) {
    // 维度筛选下三张表统一由交叉表切片，保证彼此一致
    ({ byDate, byProvider, byModel } = sliceCrossTable(sourceData.byDateModel || {}, from, to, matches));
  } else {
    byDate = dynamicMap();
    for (const [date, stats] of Object.entries(sourceData.byDate || {})) {
      if (!inRange(date, from, to)) continue;
      byDate[date] = stats;
    }
    byProvider = collapseCrossTable(sourceData.byDateProvider || {}, from, to);
    byModel = dynamicMap();
    for (const [key, stats] of Object.entries(collapseCrossTable(sourceData.byDateModel || {}, from, to))) {
      byModel[key] = { provider: providerOfKey(key), model: modelOfKey(key), ...stats };
    }
  }

  const summary = summarizeByDate(byDate);
  const byHour = sliceHourTable(sourceData.byHourModel, from, to, matches);

  const sessions = [];
  for (const s of sourceData.sessions || []) {
    const sliced = matches
      ? sliceSessionByKey(s, from, to, matches, { provider, model })
      : sliceSessionByDate(s, from, to);
    if (sliced) sessions.push(sliced);
  }
  summary.totalSessions = sessions.length;

  return {
    summary,
    byProvider,
    byModel,
    byDate,
    byHour,
    byDateProvider: sourceData.byDateProvider,
    byDateModel: sourceData.byDateModel,
    sessions,
    generatedAt: sourceData.generatedAt,
    sourceId: source === 'all' ? undefined : source,
    sourceLabel: source === 'all' ? undefined : sourceData.sourceLabel,
  };
}

/**
 * 仅按日期区间筛选（`filterData` 的薄封装，保留既有调用方式）
 * @param {Object} fullData
 * @param {string|null} from YYYY-MM-DD
 * @param {string|null} to YYYY-MM-DD
 */
export function filterDataByDateRange(fullData, from, to) {
  return filterData(fullData, { from, to });
}
