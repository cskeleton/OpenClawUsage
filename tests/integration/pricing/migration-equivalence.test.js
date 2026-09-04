import { describe, it, expect } from 'vitest';
import { migratePricingConfigV1toV2, calculateCostFromUsage } from '../../../pricing.js';

// 以生产真实配置为蓝本（含 wildcard hack：*mimo-v2.5 无尾部 * 用于区分 mimo-v2.5-pro）
const v1 = {
  version: '1.0', enabled: true, updated: 'T',
  pricing: {
    '*deepseek-v4-flash*': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null, matchType: 'wildcard' },
    '*mimo-v2.5': { input: 0.14, output: 0.28, matchType: 'wildcard' },
    'openai/gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null },
  },
};

const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, totalTokens: 3e6, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 } };

describe('v1 → v2 migration equivalence', () => {
  it('migrated v2 config reproduces v1 pricing outcomes', () => {
    // v1 侧无法用变更前的旧 calculateCostFromUsage 跑对照，
    // 因此等价性通过「v2 迁移结果 + v2 计价」对照「v1 语义下的手工期望」断言：
    const v2 = migratePricingConfigV1toV2(v1);
    expect(calculateCostFromUsage(usage, 'bohe', 'deepseek-v4-flash', v2).total).toBeCloseTo(0.14 + 0.28 + 0.0028);
    expect(calculateCostFromUsage(usage, 'nvidia', 'deepseek-ai/deepseek-v4-flash', v2).total).toBeCloseTo(0.14 + 0.28 + 0.0028);
    expect(calculateCostFromUsage(usage, 'openai', 'gpt-5.5', v2).total).toBeCloseTo(5 + 30 + 0.5);
    expect(calculateCostFromUsage(usage, 'qwen', 'mimo-v2.5', v2).total).toBeCloseTo(0.14 + 0.28 + 0.14); // cacheRead null → input 原价
    expect(calculateCostFromUsage(usage, 'qwen', 'mimo-v2.5-pro', v2).source).toBe('openclaw');
    expect(calculateCostFromUsage(usage, 'anyrouter', 'claude-fable-5', v2).source).toBe('openclaw');
  });

  it('splits exact entries into rules and wildcard entries into patterns, preserving declaration order', () => {
    const v2 = migratePricingConfigV1toV2(v1);
    expect(Object.keys(v2.rules)).toEqual(['openai/gpt-5.5']);
    expect(Object.keys(v2.patterns)).toEqual(['*deepseek-v4-flash*', '*mimo-v2.5']);
    expect(v2.rules['openai/gpt-5.5'].source).toBe('manual');
    expect(v2.rules['openai/gpt-5.5'].matchType).toBeUndefined();
    expect(v2.patterns['*mimo-v2.5'].matchType).toBe('wildcard');

    // wildcard 命中经 patterns 区，source 透传为 'pattern'；exact 命中透传 rule.source
    expect(calculateCostFromUsage(usage, 'bohe', 'deepseek-v4-flash', v2).source).toBe('pattern');
    expect(calculateCostFromUsage(usage, 'openai', 'gpt-5.5', v2).source).toBe('manual');
  });
});
