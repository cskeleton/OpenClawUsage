/**
 * 模型名归一化候选生成。归一化产物是「候选名」而非断言：
 * 必须能在 alias/rules/models.dev catalog 之一中查到才算命中（见 pricing.js resolvePricingRule
 * 与 pricing-catalog-matcher.js），因此剥离规则保持保守——
 * -pro / -luna / -sol / -terra 等区分模型的后缀绝不出现在默认噪声清单中。
 */

/** 已知噪声后缀（推理档位标记），可在配置 matching.noiseSuffixes 中增删 */
export const DEFAULT_NOISE_SUFFIXES = Object.freeze(['-high', '-thinking', '-low', '-medium']);

/**
 * 按第一个 '/' 切分 provider/model；model 段可含 '/'
 * @param {string} key - 完整 `provider/model` 键
 * @returns {{ provider: string, model: string }}
 */
export function splitModelKey(key) {
  const idx = String(key).indexOf('/');
  if (idx < 0) return { provider: '', model: String(key) };
  return { provider: String(key).slice(0, idx), model: String(key).slice(idx + 1) };
}

/**
 * 生成归一化候选名（有序、去重）：
 * 原始 model → 小写 → 逐段剥渠道前缀（agy/x → x）→ 每个变体再剥噪声后缀
 * @param {string} provider
 * @param {string} model
 * @param {readonly string[]} [noiseSuffixes]
 * @returns {string[]}
 */
export function generateModelKeyCandidates(provider, model, noiseSuffixes = DEFAULT_NOISE_SUFFIXES) {
  const candidates = [];
  const push = (c) => { if (c && !candidates.includes(c)) candidates.push(c); };

  push(model);
  const lower = String(model).toLowerCase();
  push(lower);

  const segments = lower.split('/');
  for (let i = 1; i < segments.length; i++) {
    push(segments.slice(i).join('/'));
  }

  // 对每个已有变体尝试剥噪声后缀（可级联，如 x-high-thinking 假设场景）
  const suffixes = (noiseSuffixes || []).map((s) => String(s).toLowerCase());
  for (let i = 0; i < candidates.length; i++) {
    let variant = candidates[i];
    for (const suffix of suffixes) {
      if (suffix && variant.endsWith(suffix) && variant.length > suffix.length) {
        variant = variant.slice(0, -suffix.length);
        push(variant);
      }
    }
  }
  return candidates;
}
