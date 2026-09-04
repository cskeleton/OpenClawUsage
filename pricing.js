import { readFile } from 'fs/promises';
import { writeTextFileAtomic } from './json-atomic-write.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { DEFAULT_NOISE_SUFFIXES, generateModelKeyCandidates } from './pricing-normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 展示单位 $/M；内部仍按每 1e6 tokens 换算
const TOKENS_PER_UNIT = 1_000_000;

/** @typedef {'exact' | 'wildcard' | 'regex'} PricingMatchType */

/**
 * 将 glob 风格通配符转为匹配完整 modelKey 的正则（^...$）
 * @param {string} pattern - 通配符模式（作用于整串 `provider/model`）
 * @returns {RegExp}
 */
export function wildcardToRegex(pattern) {
  if (typeof pattern !== 'string') {
    throw new TypeError('通配符模式必须是字符串');
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if ('\\^$+{}[]|().'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * 解析 `/pattern/flags` 形式的正则键（键为完整字符串，非 RegExp 对象）
 * @param {string} key - 配置中的键
 * @returns {RegExp|null} 无法解析时返回 null
 */
export function parseRegexEntry(key) {
  if (typeof key !== 'string' || !key.startsWith('/')) {
    return null;
  }
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash <= 0) {
    return null;
  }
  const body = key.slice(1, lastSlash);
  const flags = key.slice(lastSlash + 1);
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * 规范化 matchType（缺省为 exact）
 * @param {string|undefined|null} matchType
 * @returns {PricingMatchType}
 */
function normalizeMatchType(matchType) {
  if (matchType === undefined || matchType === null || matchType === '') {
    return 'exact';
  }
  return /** @type {PricingMatchType} */ (matchType);
}

/**
 * 是否为通配符 / 正则模式规则
 * @param {PricingMatchType} mt
 */
function isPatternMatchType(mt) {
  return mt === 'wildcard' || mt === 'regex';
}

export const PRICING_SCHEMA_VERSION = '2.0';

/**
 * v2 默认价格配置
 * @returns {Object}
 */
export function defaultPricingConfigV2() {
  return {
    version: PRICING_SCHEMA_VERSION,
    enabled: true,
    updated: '0001-01-01T00:00:00.000Z',
    revision: 0,
    matching: { ignoreProvider: true, noiseSuffixes: [...DEFAULT_NOISE_SUFFIXES] },
    rules: {},
    aliases: {},
    patterns: {},
  };
}

/**
 * v1 → v2 结构迁移（语义不变）：
 * exact 条目移入 rules（source: 'manual'，去掉 matchType）；
 * wildcard/regex 条目原样移入 patterns（保留 matchType）。
 * @param {Object} v1 - v1 配置对象
 * @returns {Object} v2 配置对象
 */
export function migratePricingConfigV1toV2(v1) {
  const rules = {};
  const patterns = {};
  for (const [key, entry] of Object.entries(v1?.pricing || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const mt = normalizeMatchType(entry.matchType);
    if (mt === 'exact') {
      const { matchType, ...rest } = entry;
      rules[key] = { ...rest, source: 'manual' };
    } else {
      patterns[key] = entry;
    }
  }
  return {
    version: PRICING_SCHEMA_VERSION,
    enabled: v1?.enabled !== false,
    updated: typeof v1?.updated === 'string' ? v1.updated : '0001-01-01T00:00:00.000Z',
    revision: 1,
    matching: { ignoreProvider: true, noiseSuffixes: [...DEFAULT_NOISE_SUFFIXES] },
    rules,
    aliases: {},
    patterns,
  };
}

/**
 * 键排序后的稳定序列化（供指纹比较使用）
 * @param {*} value
 * @returns {string}
 */
export function stablePricingStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stablePricingStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stablePricingStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 在 pricing 表中查找适用于 modelKey 的一条规则（含优先级）
 * @param {string} modelKey - `provider/model`
 * @param {Record<string, object>} pricingMap - config.pricing
 * @returns {object|null} 命中的价格条目，无则 null
 */
export function findMatchingPricing(modelKey, pricingMap) {
  if (!pricingMap || typeof pricingMap !== 'object') {
    return null;
  }

  const direct = pricingMap[modelKey];
  if (direct && direct.enabled !== false) {
    const mt = normalizeMatchType(direct.matchType);
    if (mt === 'exact') {
      return direct;
    }
  }

  for (const [key, entry] of Object.entries(pricingMap)) {
    if (!entry || entry.enabled === false) continue;
    const mt = normalizeMatchType(entry.matchType);
    if (!isPatternMatchType(mt)) continue;

    if (mt === 'wildcard') {
      try {
        const re = wildcardToRegex(key);
        if (re.test(modelKey)) return entry;
      } catch {
        continue;
      }
    } else if (mt === 'regex') {
      const re = parseRegexEntry(key);
      if (re && re.test(modelKey)) return entry;
    }
  }

  return null;
}

/**
 * 动态检测 OpenClaw 工作目录。
 * 优先级：OPENCLAW_DIR env > openclaw.json 里的 agents.defaults.workspace > ~/.openclaw
 * @deprecated 定价配置的规范位置已由 `resolvePricingConfigPath()` 统一为
 * `OPENCLAW_CONFIG_DIR`（见下）；本函数仅为 legacy 迁移候选
 * （`legacyPricingPathCandidates`）保留 workspace 探测逻辑。
 * @returns {Promise<string>} OpenClaw 工作目录路径
 */
export async function detectOpenClawDir() {
    // 1. 环境变量优先
    const envPath = process.env.OPENCLAW_DIR;
    if (envPath) return envPath;

    // 2. 从 openclaw.json 读取 workspace 配置
    const defaultConfigPath = join(homedir(), '.openclaw', 'openclaw.json');
    try {
        const configData = await readFile(defaultConfigPath, 'utf-8');
        const config = JSON.parse(configData);
        const workspace = config?.agents?.defaults?.workspace;
        if (workspace && typeof workspace === 'string') {
            // 兼容两种格式：目录路径（新）与文件路径（旧）
            return workspace.endsWith('.json') ? dirname(workspace) : workspace;
        }
    } catch {}

    // 3. 回退到 ~/.openclaw/
    return join(homedir(), '.openclaw');
}

/**
 * 定价配置文件规范路径（文件名固定为 openclaw-usage-pricing.json）。
 * 优先级：OPENCLAW_USAGE_PRICING_PATH > OPENCLAW_CONFIG_DIR > OPENCLAW_DIR（deprecated alias）> ~/.openclaw
 * @returns {Promise<string>}
 */
export async function resolvePricingConfigPath() {
  const explicit = process.env.OPENCLAW_USAGE_PRICING_PATH;
  if (explicit) return explicit;
  const dir = process.env.OPENCLAW_CONFIG_DIR
    || process.env.OPENCLAW_DIR
    || join(homedir(), '.openclaw');
  return join(dir, 'openclaw-usage-pricing.json');
}

/**
 * legacy 候选（迁移来源），按优先级；去重且不含规范路径自身
 * @returns {Promise<string[]>}
 */
export async function legacyPricingPathCandidates() {
  const canonical = await resolvePricingConfigPath();
  const detected = await detectOpenClawDir();
  const candidates = [
    join(detected, 'openclaw-usage-pricing.json'),
    join(homedir(), '.openclaw', 'openclaw-usage-pricing.json'),
  ];
  return [...new Set(candidates)].filter((p) => p !== canonical);
}

/**
 * 加载价格配置（含校验结果）。
 * 文件不存在 → 尝试 legacy 路径；仍为 v1 或无 version → 自动迁移为 v2 并写回；
 * JSON 损坏 → 返回默认配置并附 validationErrors。
 * @param {{ configPath?: string }} [options] - configPath 固定读取/迁移写回路径（供后台任务钉住触发时刻的路径，防 env 变化后写偏）
 * @returns {Promise<{ config: Object, validationErrors: string[] }>}
 */
export async function loadPricingConfigDetailed({ configPath: pinnedPath } = {}) {
  const configPath = pinnedPath || await resolvePricingConfigPath();
  let raw = null;
  try {
    raw = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      // legacy 迁移来源：按候选顺序取第一个可读文件（不存在或不可读则跳过）
      for (const legacyPath of await legacyPricingPathCandidates()) {
        try {
          raw = JSON.parse(await readFile(legacyPath, 'utf-8'));
          break;
        } catch { /* 继续下一个候选 */ }
      }
    } else if (error instanceof SyntaxError) {
      return { config: defaultPricingConfigV2(), validationErrors: [`价格配置 JSON 解析失败: ${error.message}`] };
    } else {
      throw error;
    }
  }
  if (!raw) return { config: defaultPricingConfigV2(), validationErrors: [] };

  let config = raw;
  const validationErrors = [];
  if (raw.version !== PRICING_SCHEMA_VERSION) {
    try {
      config = migratePricingConfigV1toV2(raw);
      await savePricingConfig(config, pinnedPath ? { configPath: pinnedPath } : {});
    } catch (e) {
      validationErrors.push(`v1 配置迁移失败: ${e.message}`);
      config = defaultPricingConfigV2();
    }
  }
  try {
    validatePricingConfig(config);
  } catch (e) {
    validationErrors.push(e.message);
  }
  return { config, validationErrors };
}

/**
 * 加载价格配置
 * @param {{ configPath?: string }} [options]
 * @returns {Promise<Object>} 价格配置对象
 */
export async function loadPricingConfig(options) {
  return (await loadPricingConfigDetailed(options)).config;
}

/**
 * 去掉元字段（updated / revision）后的内容视图，供 no-op 比较使用
 * @param {Object} config
 * @returns {Object}
 */
function stripPricingMeta(config) {
  const { updated, revision, ...rest } = config || {};
  return rest;
}

/**
 * 保存价格配置（乐观锁 + no-op 检测）。
 * 注意：读-比较-写不是跨进程原子操作，baseRevision 只是 best-effort 乐观锁；
 * 两个进程并发写同一文件时后写者仍可能覆盖先写者。
 * @param {Object} config - v2 配置
 * @param {{ baseRevision?: number, configPath?: string }} [options] - baseRevision 提供时与磁盘当前 revision 比较，不符则冲突；configPath 固定写入路径
 * @returns {Promise<{ revision: number, updated: string, changed: boolean }>}
 */
export async function savePricingConfig(config, { baseRevision, configPath: pinnedPath } = {}) {
  validatePricingConfig(config);
  const configPath = pinnedPath || await resolvePricingConfigPath();
  let current = null;
  try {
    current = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const currentRevision = typeof current?.revision === 'number' ? current.revision : 0;
  if (baseRevision !== undefined && baseRevision !== currentRevision) {
    const err = new Error('价格配置已被其他入口修改，请刷新后重试');
    err.code = 'PRICING_REVISION_CONFLICT';
    err.current = current;
    throw err;
  }
  const changed = !current
    || stablePricingStringify(stripPricingMeta(current)) !== stablePricingStringify(stripPricingMeta(config));
  const next = {
    ...config,
    revision: currentRevision + (changed ? 1 : 0),
    updated: changed ? new Date().toISOString() : (current?.updated || config.updated),
  };
  if (changed) {
    await writeTextFileAtomic(configPath, JSON.stringify(next, null, 2));
  }
  return { revision: next.revision, updated: next.updated, changed };
}

/**
 * 校验单条规则条目（rules / patterns 共用）
 * @param {string} fieldPath - 错误消息前缀，如 `rules.openai/gpt-4o`
 * @param {Object} entry
 * @throws {Error} 验证失败时抛出错误
 */
function validateRuleEntry(fieldPath, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${fieldPath} 的价格配置必须是一个对象`);
  }

  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    throw new Error(`${fieldPath} 的 enabled 必须为布尔值`);
  }

  if (typeof entry.input !== 'number' || entry.input < 0) {
    throw new Error(`${fieldPath} 的 Input 价格必须是非负数`);
  }

  if (typeof entry.output !== 'number' || entry.output < 0) {
    throw new Error(`${fieldPath} 的 Output 价格必须是非负数`);
  }

  if (entry.cacheRead !== null && entry.cacheRead !== undefined) {
    if (typeof entry.cacheRead !== 'number' || entry.cacheRead < 0) {
      throw new Error(`${fieldPath} 的 Cache Read 价格必须是非负数或 null`);
    }
  }

  if (entry.cacheWrite !== null && entry.cacheWrite !== undefined) {
    if (typeof entry.cacheWrite !== 'number' || entry.cacheWrite < 0) {
      throw new Error(`${fieldPath} 的 Cache Write 价格必须是非负数或 null`);
    }
  }
}

/**
 * 验证 v2 价格配置结构
 * @param {Object} config - 价格配置对象
 * @throws {Error} 验证失败时抛出错误（消息含字段路径）
 */
export function validatePricingConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('价格配置必须是一个对象');
  }

  if (typeof config.version !== 'string') {
    throw new Error('价格配置必须包含 version 字段');
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new Error('价格配置的 enabled 必须为布尔值');
  }

  if (config.matching !== undefined) {
    if (!config.matching || typeof config.matching !== 'object' || Array.isArray(config.matching)) {
      throw new Error('价格配置的 matching 必须是一个对象');
    }
    const { ignoreProvider, noiseSuffixes } = config.matching;
    if (ignoreProvider !== undefined && typeof ignoreProvider !== 'boolean') {
      throw new Error('matching.ignoreProvider 必须为布尔值');
    }
    if (noiseSuffixes !== undefined) {
      if (!Array.isArray(noiseSuffixes) || noiseSuffixes.some((s) => typeof s !== 'string')) {
        throw new Error('matching.noiseSuffixes 必须为字符串数组');
      }
    }
  }

  for (const section of ['rules', 'patterns', 'aliases']) {
    if (!config[section] || typeof config[section] !== 'object' || Array.isArray(config[section])) {
      throw new Error(`价格配置必须包含 ${section} 字段（对象）`);
    }
  }

  // 精确规则层：逐条校验 + source 白名单 + 不允许 matchType
  for (const [key, entry] of Object.entries(config.rules)) {
    if (key.trim() === '') {
      throw new Error('rules 的键必须是非空字符串');
    }
    const fieldPath = `rules.${key}`;
    validateRuleEntry(fieldPath, entry);
    if (entry.source !== undefined && entry.source !== 'manual' && entry.source !== 'models.dev') {
      throw new Error(`${fieldPath} 的 source 必须为 manual 或 models.dev`);
    }
    if (entry.matchType !== undefined) {
      throw new Error(`${fieldPath} 不允许携带 matchType；wildcard/regex 规则请放入 patterns`);
    }
  }

  // legacy wildcard/regex 模式层：沿用现有 matchType/wildcard/regex 校验
  for (const [key, entry] of Object.entries(config.patterns)) {
    if (key.trim() === '') {
      throw new Error('patterns 的键必须是非空字符串');
    }
    const fieldPath = `patterns.${key}`;
    validateRuleEntry(fieldPath, entry);

    const mtRaw = entry.matchType;
    if (mtRaw !== undefined && mtRaw !== null && mtRaw !== '') {
      if (mtRaw !== 'exact' && mtRaw !== 'wildcard' && mtRaw !== 'regex') {
        throw new Error(`${fieldPath} 的 matchType 必须为 exact、wildcard 或 regex`);
      }
    }

    const mt = normalizeMatchType(entry.matchType);
    if (mt === 'regex') {
      const re = parseRegexEntry(key);
      if (!re) {
        throw new Error(`${fieldPath} 的正则键格式无效（需为 /pattern/flags 且正则可编译）`);
      }
    }
    if (mt === 'wildcard') {
      if (!key.includes('*') && !key.includes('?')) {
        throw new Error(`${fieldPath} 声明为 wildcard 但键不含 * 或 ?；请改用 rules 精确规则或使用通配符`);
      }
      try {
        wildcardToRegex(key);
      } catch (e) {
        throw new Error(`${fieldPath} 的通配符模式无效: ${e.message}`);
      }
    }
  }

  // 别名层：非空字符串 → 非空字符串
  for (const [key, target] of Object.entries(config.aliases)) {
    if (key.trim() === '') {
      throw new Error('aliases 的键必须是非空字符串');
    }
    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error(`aliases.${key} 的目标必须是非空字符串`);
    }
  }
}

/**
 * 使用会话中 OpenClaw 写入的原始成本（账面价）
 * @param {Object} usage
 * @param {string} [model] - 可选；提供时作为 canonical 透出，便于上层聚合
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number, source: string, canonical: string|null }}
 */
function openclawCostFallback(usage, model) {
  return {
    input: usage.cost?.input || 0,
    output: usage.cost?.output || 0,
    cacheRead: usage.cost?.cacheRead || 0,
    cacheWrite: usage.cost?.cacheWrite || 0,
    total: usage.cost?.total || 0,
    source: 'openclaw',
    canonical: model ?? null,
  };
}

/**
 * 匹配管线：别名 → 原始键精确 → 归一化候选（provider 感知）→ legacy patterns。
 * 跳过 enabled === false 的条目并继续查找（与 v1 语义一致）。
 * @param {string} provider
 * @param {string} model
 * @param {object} config - v2 配置
 * @returns {null | { rule: object, canonical: string, matchedKey: string, via: 'alias'|'exact'|'normalized'|'pattern' }}
 */
export function resolvePricingRule(provider, model, config) {
  if (!config || config.enabled === false) return null;
  const rules = config.rules || {};
  const ignoreProvider = config.matching?.ignoreProvider !== false;
  const rawKey = `${provider}/${model}`;

  const lookupCanonical = (canonical) => {
    if (!ignoreProvider) {
      const qualifiedKey = `${provider}/${canonical}`;
      const qualified = rules[qualifiedKey];
      if (qualified && qualified.enabled !== false) {
        return { rule: qualified, canonical, matchedKey: qualifiedKey };
      }
    }
    const bare = rules[canonical];
    if (bare && bare.enabled !== false) {
      return { rule: bare, canonical, matchedKey: canonical };
    }
    return null;
  };

  const alias = config.aliases?.[rawKey];
  if (typeof alias === 'string' && alias) {
    const hit = lookupCanonical(alias);
    if (hit) return { ...hit, via: 'alias' };
  }

  // 精确层：ignoreProvider=true 时裸 model 规则优先、原始键兜底（provider 无关语义）；
  // ignoreProvider=false 时 provider 限定键优先、bare 兜底（provider 感知）。
  // 命中键 === 原始键才算 via 'exact'，否则视为归一化命中。
  const orderedKeys = ignoreProvider ? [model, rawKey] : [rawKey, model];
  for (const key of orderedKeys) {
    const rule = rules[key];
    if (rule && rule.enabled !== false) {
      return { rule, canonical: model, matchedKey: key, via: key === rawKey ? 'exact' : 'normalized' };
    }
  }

  const noiseSuffixes = config.matching?.noiseSuffixes || DEFAULT_NOISE_SUFFIXES;
  for (const candidate of generateModelKeyCandidates(provider, model, noiseSuffixes)) {
    if (candidate === model) continue; // 精确层已覆盖
    const hit = lookupCanonical(candidate);
    if (hit) return { ...hit, via: 'normalized' };
  }

  const patternHit = findMatchingPricing(rawKey, config.patterns || {});
  if (patternHit) {
    return { rule: patternHit, canonical: model, matchedKey: rawKey, via: 'pattern' };
  }
  return null;
}

/**
 * 按解析结果计价。resolution 为 null → 账面价回退。
 * @param {Object} usage
 * @param {null|object} resolution - resolvePricingRule 的返回值
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number, source: string, canonical: string|null }}
 */
export function applyPricingResolution(usage, resolution) {
  if (!resolution) return openclawCostFallback(usage);
  const pricing = resolution.rule;
  const inputCost = (pricing.input * (usage.input || 0)) / TOKENS_PER_UNIT;
  const outputCost = (pricing.output * (usage.output || 0)) / TOKENS_PER_UNIT;
  // 缓存单价留空：无单独缓存价，统一按 Input 原价计算缓存 token 费用
  const cacheReadPrice = pricing.cacheRead ?? pricing.input;
  const cacheWritePrice = pricing.cacheWrite ?? pricing.input;
  const cacheReadCost = (cacheReadPrice * (usage.cacheRead || 0)) / TOKENS_PER_UNIT;
  const cacheWriteCost = (cacheWritePrice * (usage.cacheWrite || 0)) / TOKENS_PER_UNIT;
  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    source: resolution.via === 'pattern' ? 'pattern' : (resolution.rule.source || 'manual'),
    canonical: resolution.canonical,
  };
}

/**
 * 根据使用量计算成本
 * @param {Object} usage - 使用量对象 {input, output, cacheRead, cacheWrite, totalTokens, cost}
 * @param {string} provider - 提供商
 * @param {string} model - 模型名称
 * @param {Object|null} pricingConfig - 价格配置对象，null 表示使用 OpenClaw 原始成本
 * @returns {Object} 计算结果 {input, output, cacheRead, cacheWrite, total, source, canonical}
 */
export function calculateCostFromUsage(usage, provider, model, pricingConfig) {
  // 未加载配置或全局关闭自定义价：使用 OpenClaw 原始成本
  if (!pricingConfig || pricingConfig.enabled === false) {
    return openclawCostFallback(usage, model);
  }
  // 空 rules + patterns 时 resolve 自然返回 null，同样回退账面价
  return applyPricingResolution(usage, resolvePricingRule(provider, model, pricingConfig));
}
