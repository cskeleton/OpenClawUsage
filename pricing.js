import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 展示单位 $/M；内部仍按每 1e6 tokens 换算
const TOKENS_PER_UNIT = 1_000_000;

/**
 * 动态检测 OpenClaw 工作目录
 * 优先级：OPENCLAW_CONFIG_PATH env > ~/.openclaw/ > ~/openclaw/
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

// 配置文件路径：动态检测 OpenClaw 工作目录
let _pricingConfigPath = null;
async function getPricingConfigPath() {
    if (_pricingConfigPath) return _pricingConfigPath;
    const openclawDir = await detectOpenClawDir();
    _pricingConfigPath = join(openclawDir, 'openclaw-usage-pricing.json');
    return _pricingConfigPath;
}

// 旧路径兼容（用于首次迁移）
const LEGACY_PRICING_PATH = join(homedir(), '.openclaw', 'openclaw-usage-pricing.json');

/**
 * 加载价格配置
 * @returns {Promise<Object>} 价格配置对象
 */
export async function loadPricingConfig() {
  const configPath = await getPricingConfigPath();

  // 尝试新路径
  try {
    const data = await readFile(configPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // 新路径不存在时，尝试旧路径（用于从旧配置迁移）
  try {
    const legacyData = await readFile(LEGACY_PRICING_PATH, 'utf-8');
    const config = JSON.parse(legacyData);
    // 自动迁移到新路径
    await savePricingConfig(config);
    return config;
  } catch {}

  // 全部不存在时返回默认配置
  return {
    version: '1.0',
    updated: new Date().toISOString(),
    pricing: {}
  };
}

/**
 * 保存价格配置
 * @param {Object} config - 价格配置对象
 * @returns {Promise<void>}
 */
export async function savePricingConfig(config) {
  // 验证配置
  validatePricingConfig(config);

  // 更新时间戳
  config.updated = new Date().toISOString();

  // 写入动态路径
  const configPath = await getPricingConfigPath();
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 验证价格配置结构
 * @param {Object} config - 价格配置对象
 * @throws {Error} 验证失败时抛出错误
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

  if (!config.pricing || typeof config.pricing !== 'object') {
    throw new Error('价格配置必须包含 pricing 字段');
  }

  // 验证每个模型的价格配置
  for (const [modelKey, pricing] of Object.entries(config.pricing)) {
    if (typeof modelKey !== 'string' || modelKey.trim() === '') {
      throw new Error('模型键必须是非空字符串');
    }

    if (!pricing || typeof pricing !== 'object') {
      throw new Error(`模型 ${modelKey} 的价格配置必须是一个对象`);
    }

    if (pricing.enabled !== undefined && typeof pricing.enabled !== 'boolean') {
      throw new Error(`模型 ${modelKey} 的 enabled 必须为布尔值`);
    }

    if (typeof pricing.input !== 'number' || pricing.input < 0) {
      throw new Error(`模型 ${modelKey} 的 Input 价格必须是非负数`);
    }

    if (typeof pricing.output !== 'number' || pricing.output < 0) {
      throw new Error(`模型 ${modelKey} 的 Output 价格必须是非负数`);
    }

    if (pricing.cacheRead !== null && pricing.cacheRead !== undefined) {
      if (typeof pricing.cacheRead !== 'number' || pricing.cacheRead < 0) {
        throw new Error(`模型 ${modelKey} 的 Cache Read 价格必须是非负数或 null`);
      }
    }

    if (pricing.cacheWrite !== null && pricing.cacheWrite !== undefined) {
      if (typeof pricing.cacheWrite !== 'number' || pricing.cacheWrite < 0) {
        throw new Error(`模型 ${modelKey} 的 Cache Write 价格必须是非负数或 null`);
      }
    }
  }
}

/**
 * 使用会话中 OpenClaw 写入的原始成本（账面价）
 * @param {Object} usage
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number, source: string }}
 */
function openclawCostFallback(usage) {
  return {
    input: usage.cost?.input || 0,
    output: usage.cost?.output || 0,
    cacheRead: usage.cost?.cacheRead || 0,
    cacheWrite: usage.cost?.cacheWrite || 0,
    total: usage.cost?.total || 0,
    source: 'openclaw',
  };
}

/**
 * 根据使用量计算成本
 * @param {Object} usage - 使用量对象 {input, output, cacheRead, cacheWrite, totalTokens, cost}
 * @param {string} provider - 提供商
 * @param {string} model - 模型名称
 * @param {Object|null} pricingConfig - 价格配置对象，null 表示使用 OpenClaw 原始成本
 * @returns {Object} 计算结果 {input, output, cacheRead, cacheWrite, total, source}
 */
export function calculateCostFromUsage(usage, provider, model, pricingConfig) {
  // 未加载配置或全局关闭自定义价：使用 OpenClaw 原始成本
  if (!pricingConfig || pricingConfig.enabled === false) {
    return openclawCostFallback(usage);
  }

  // 没有条目时：使用 OpenClaw 原始成本
  if (!pricingConfig.pricing || Object.keys(pricingConfig.pricing).length === 0) {
    return openclawCostFallback(usage);
  }

  const modelKey = `${provider}/${model}`;
  const pricing = pricingConfig.pricing[modelKey];

  // 未配置该模型或该条规则关闭：使用 OpenClaw 原始成本
  if (!pricing || pricing.enabled === false) {
    return openclawCostFallback(usage);
  }

  // 计算成本：价格（$/M） * 用量（tokens） / 1e6
  const inputCost = (pricing.input * (usage.input || 0)) / TOKENS_PER_UNIT;
  const outputCost = (pricing.output * (usage.output || 0)) / TOKENS_PER_UNIT;

  // 缓存单价留空：无单独缓存价，按 Input/Output 原价计算缓存 token 费用
  const cacheReadPrice = pricing.cacheRead ?? pricing.input;
  const cacheWritePrice = pricing.cacheWrite ?? pricing.output;

  const cacheReadCost = (cacheReadPrice * (usage.cacheRead || 0)) / TOKENS_PER_UNIT;
  const cacheWriteCost = (cacheWritePrice * (usage.cacheWrite || 0)) / TOKENS_PER_UNIT;

  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: total,
    source: 'custom'
  };
}

/**
 * 获取价格版本号
 * @param {Object} config - 价格配置对象
 * @returns {string} 版本号
 */
export function getPricingVersion(config) {
  return config?.version || 'none';
}
