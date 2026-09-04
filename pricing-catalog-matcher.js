import { generateModelKeyCandidates } from './pricing-normalize.js';

const SCORE_THRESHOLD = 0.55;   // 唯一自动生效阈值
const WEAK_THRESHOLD = 0.34;    // 弱召回：进入确认队列
const MAX_CANDIDATES = 8;

export function buildCatalogIndex(models) {
  const byModelId = new Map();
  for (const entry of models || []) {
    if (!entry || typeof entry.model !== 'string') continue;
    const id = entry.model.toLowerCase();
    if (!byModelId.has(id)) byModelId.set(id, []);
    byModelId.get(id).push(entry);
  }
  return { byModelId };
}

function tokenize(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenJaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function editSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** 候选打分：token Jaccard × 0.86 与编辑相似度 × 0.82 取大（参考 CPAMP） */
export function scoreCandidate(observed, catalogId) {
  return Math.max(tokenJaccard(observed, catalogId) * 0.86, editSimilarity(observed, catalogId) * 0.82);
}

/**
 * 已知模型厂官方 provider 集合（对照 models.dev catalog 实际 provider id 维护，保持保守）。
 * 覆盖模型 id 不含厂商名的高频厂商（anthropic/claude-*、openai/gpt-*、google/gemini-*、
 * moonshotai/kimi-* 等）；models.dev 实际 id 为 `xai`/`zai`（无 `x-ai`/`z-ai`），
 * qwen 系列挂在 `alibaba` 下且无独立 `qwen` provider，故不收。
 */
const KNOWN_MODEL_CREATORS = new Set([
  'anthropic', 'openai', 'google', 'deepseek',
  'moonshotai', 'moonshotai-cn', 'meta', 'mistral', 'xai', 'zai',
]);

/**
 * 官方条目启发式：provider 属于已知模型厂集合（anthropic/claude-opus-5、openai/gpt-5），
 * 或 provider id 作为 token 出现在模型 id 中（deepseek/deepseek-v4-flash）。
 * 后者作为补充信号保留：可覆盖集合外、但「自产自销」特征明显的厂商；
 * bedrock/anthropic.claude-* 一类分销条目两者都不命中，不会误判。
 */
export function isOfficialEntry(entry) {
  const provider = String(entry.provider).toLowerCase();
  return KNOWN_MODEL_CREATORS.has(provider) || tokenize(entry.model).includes(provider);
}

function toPrices(cost) {
  return {
    input: cost?.input ?? null,
    output: cost?.output ?? null,
    cacheRead: cost?.cacheRead ?? null,
    cacheWrite: cost?.cacheWrite ?? null,
  };
}

function toCandidate(entry, score, reason) {
  return {
    catalogKey: entry.key,
    provider: entry.provider,
    model: entry.model,
    prices: toPrices(entry.cost),
    score,
    reason,
  };
}

/** 在精确命中的同 id 条目集合中按口径选择 */
function selectFromExactEntries(entries, provider, ignoreProvider) {
  if (!ignoreProvider) {
    const own = entries.filter((e) => e.provider === provider);
    if (own.length === 1) return { status: 'unique', match: toCandidate(own[0], 1, 'exact-own-provider') };
    if (own.length > 1) return { status: 'ambiguous', candidates: own.map((e) => toCandidate(e, 1, 'exact-own-provider-multi')) };
  }
  const official = entries.filter(isOfficialEntry);
  const pool = official.length ? official : entries;
  // 单条目即唯一（官方启发式仅用于多提供者消歧，不应制造单条目歧义）
  if (pool.length === 1) {
    const reason = official.length ? 'exact-official' : 'exact-single';
    return { status: 'unique', match: toCandidate(pool[0], 1, reason) };
  }
  const reason = official.length ? 'exact-official' : 'exact-multi-provider';
  return { status: 'ambiguous', candidates: pool.map((e) => toCandidate(e, 1, reason)) };
}

/** probe 与 catalog id 的 token 集合互为严格子集（一方是另一方的截断/加长版） */
function hasStrictTokenContainment(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === sb.size) return false;
  const [small, large] = sa.size < sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

/**
 * 对 observed provider/model 跑目录匹配。
 * @returns {{ status: 'unique', match: object } | { status: 'ambiguous', candidates: object[] } | { status: 'none' }}
 */
export function matchObservedKey(provider, model, { index, noiseSuffixes, ignoreProvider = true }) {
  // 1. 归一化候选逐个精确查 model id
  for (const candidate of generateModelKeyCandidates(provider, model, noiseSuffixes)) {
    const entries = index.byModelId.get(candidate.toLowerCase());
    if (entries?.length) return selectFromExactEntries(entries, provider, ignoreProvider);
  }
  // 2. 模糊：用最短候选（归一化程度最高）对全目录打分
  const candidates = generateModelKeyCandidates(provider, model, noiseSuffixes);
  if (!candidates.length) return { status: 'none' };
  const probe = candidates[candidates.length - 1].toLowerCase();
  const scored = [];
  for (const [id, entries] of index.byModelId) {
    const score = scoreCandidate(probe, id);
    if (score >= WEAK_THRESHOLD) {
      // 模糊命中同样 provider 感知
      const sub = selectFromExactEntries(entries, provider, ignoreProvider);
      const picked = sub.status === 'unique' ? sub.match : sub.candidates[0];
      scored.push({ ...picked, score, reason: score >= SCORE_THRESHOLD ? 'shared-model-tokens' : 'weak-recall' });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_CANDIDATES);
  // token 严格包含（如 gpt-5.6-codex-mini vs gpt-5.6-codex）说明 observed 带额外区分信息，
  // 只能进确认队列，不得自动唯一
  if (
    top.length && top[0].score >= SCORE_THRESHOLD
    && (top.length === 1 || top[0].score > top[1].score)
    && !hasStrictTokenContainment(probe, top[0].model)
  ) {
    return { status: 'unique', match: top[0] };
  }
  if (top.length) return { status: 'ambiguous', candidates: top };
  return { status: 'none' };
}
