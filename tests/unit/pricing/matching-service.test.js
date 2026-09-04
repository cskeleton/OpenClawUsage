import { describe, it, expect, afterEach } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { loadPricingConfig, savePricingConfig, defaultPricingConfigV2 } from '../../../pricing.js';
import { loadCandidates, saveCandidates } from '../../../pricing-candidates-store.js';
import { rematchObservedKeys, applyCandidateResolutions } from '../../../pricing-matching-service.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

const fakeCatalog = {
  deepseek: { models: { 'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } } } },
};

describe('rematchObservedKeys', () => {
  it('unique matches become models.dev rules; ambiguous go to candidates file', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await savePricingConfig(defaultPricingConfigV2());
    const r = await rematchObservedKeys(['cpa/agy/deepseek-v4-flash', 'qwen/unknown-zzz'], { fetchImpl: async () => fakeCatalog });
    expect(r.matched).toBe(1);
    const cfg = await loadPricingConfig();
    expect(cfg.rules['deepseek-v4-flash']).toMatchObject({ source: 'models.dev', input: 0.14 });
  });

  it('skips keys already covered by rules/aliases', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const cfg = defaultPricingConfigV2();
    cfg.rules['deepseek-v4-flash'] = { input: 9, output: 9, source: 'manual' };
    await savePricingConfig(cfg);
    const r = await rematchObservedKeys(['bohe/deepseek-v4-flash'], { fetchImpl: async () => fakeCatalog });
    expect(r.matched).toBe(0);
    expect(r.scanned).toBe(0);
    expect((await loadPricingConfig()).rules['deepseek-v4-flash'].input).toBe(9); // 不被覆盖
  });

  it('reports catalogUnavailable when catalog fetch fails', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await savePricingConfig(defaultPricingConfigV2());
    const r = await rematchObservedKeys(['x/y'], { fetchImpl: async () => { throw new Error('network down'); } });
    expect(r.catalogUnavailable).toBe(true);
  });

  it('does not overwrite a disabled manual rule found only at write step', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const cfg = defaultPricingConfigV2();
    // enabled:false 的条目对 resolvePricingRule 不可见（被跳过）→ observed 键判定为 uncovered；
    // 但 unique 命中的写入目标恰是该 manual 键 → 必须跳过写入、不计 matched
    cfg.rules['deepseek-v4-flash'] = { input: 9, output: 9, source: 'manual', enabled: false };
    await savePricingConfig(cfg);
    const catalog = {
      deepseek: { models: {
        'deepseek-v4-flash': { cost: { input: 0.14, output: 0.28 } },
        'deepseek-v4-pro': { cost: { input: 1, output: 2 } },
      } },
    };
    const r = await rematchObservedKeys(['cpa/zzz/deepseek-v4-flash', 'cpa/agy/deepseek-v4-pro'], { fetchImpl: async () => catalog });
    expect(r.scanned).toBe(2);
    expect(r.matched).toBe(1); // 只计 deepseek-v4-pro
    const loaded = await loadPricingConfig();
    expect(loaded.rules['deepseek-v4-flash']).toMatchObject({ input: 9, source: 'manual', enabled: false }); // 未被覆盖/复活
    expect(loaded.rules['deepseek-v4-pro']).toMatchObject({ input: 1, source: 'models.dev' });
  });

  it('rematch preserves dismissed on previously dismissed entries', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await savePricingConfig(defaultPricingConfigV2());
    // 两个 provider 同名模型、均非官方启发式命中 → exact-multi-provider 歧义
    const ambiguousCatalog = {
      aaa: { models: { 'shared-model-x': { cost: { input: 1, output: 2 } } } },
      bbb: { models: { 'shared-model-x': { cost: { input: 3, output: 4 } } } },
    };
    const fetchImpl = async () => ambiguousCatalog;
    const r1 = await rematchObservedKeys(['cpa/shared-model-x'], { fetchImpl });
    expect(r1.queued).toBe(1);
    await applyCandidateResolutions([{ observedKey: 'cpa/shared-model-x', action: 'dismiss' }]);
    expect((await loadCandidates()).candidates[0].dismissed).toBe(true);
    const r2 = await rematchObservedKeys(['cpa/shared-model-x'], { fetchImpl });
    expect(r2.queued).toBe(1);
    const state = await loadCandidates();
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0].dismissed).toBe(true); // 用户决议不被 rematch 复活
    expect(state.candidates[0].candidates).toHaveLength(2); // 候选已刷新
  });
});

describe('applyCandidateResolutions', () => {
  it('accept writes alias + models.dev rule; dismiss marks dismissed', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await savePricingConfig(defaultPricingConfigV2());
    // 手工种一条候选
    await saveCandidates({ candidates: [{
      observedKey: 'cpa/justwoker/claude-opus-5-thinking',
      candidates: [{ catalogKey: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, score: 0.9, reason: 'shared-model-tokens' }],
      lastSeenAt: 'T', dismissed: false,
    }]});
    const r = await applyCandidateResolutions([
      { observedKey: 'cpa/justwoker/claude-opus-5-thinking', action: 'accept', catalogId: 'claude-opus-5' },
    ]);
    expect(r.applied).toBe(1);
    const cfg = await loadPricingConfig();
    expect(cfg.aliases['cpa/justwoker/claude-opus-5-thinking']).toBe('claude-opus-5');
    expect(cfg.rules['claude-opus-5']).toMatchObject({ input: 5, source: 'models.dev' });
    expect((await loadCandidates()).candidates[0].dismissed).toBe(true); // 已处理即移出待办

    const r2 = await applyCandidateResolutions([{ observedKey: 'cpa/x', action: 'dismiss' }]);
    expect(r2.applied).toBe(0); // 不存在的 key 计入 failed
    expect(r2.failed[0].observedKey).toBe('cpa/x');
  });

  it('accept keeps an existing manual rule but still writes alias and dismisses', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const cfg = defaultPricingConfigV2();
    cfg.rules['claude-opus-5'] = { input: 99, output: 199, source: 'manual' };
    await savePricingConfig(cfg);
    await saveCandidates({ candidates: [{
      observedKey: 'cpa/x/claude-opus-5-thinking',
      candidates: [{ catalogKey: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, score: 0.9, reason: 'shared-model-tokens' }],
      lastSeenAt: 'T', dismissed: false,
    }]});
    const r = await applyCandidateResolutions([
      { observedKey: 'cpa/x/claude-opus-5-thinking', action: 'accept', catalogId: 'anthropic/claude-opus-5' },
    ]);
    expect(r.applied).toBe(1);
    const loaded = await loadPricingConfig();
    expect(loaded.aliases['cpa/x/claude-opus-5-thinking']).toBe('claude-opus-5');
    expect(loaded.rules['claude-opus-5']).toMatchObject({ input: 99, output: 199, source: 'manual' }); // manual 不被覆盖
    expect((await loadCandidates()).candidates[0].dismissed).toBe(true);
  });

  it('catalogId matches catalogKey first, then model (shared model id picks first)', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await savePricingConfig(defaultPricingConfigV2());
    await saveCandidates({ candidates: [{
      observedKey: 'cpa/y/shared-llm',
      candidates: [
        { catalogKey: 'anthropic/shared-llm', provider: 'anthropic', model: 'shared-llm', prices: { input: 5, output: 25, cacheRead: null, cacheWrite: null }, score: 0.8, reason: 'exact-multi-provider' },
        { catalogKey: 'bedrock/shared-llm', provider: 'bedrock', model: 'shared-llm', prices: { input: 7, output: 35, cacheRead: null, cacheWrite: null }, score: 0.8, reason: 'exact-multi-provider' },
      ],
      lastSeenAt: 'T', dismissed: false,
    }]});
    // catalogKey 精确命中第二条
    const r1 = await applyCandidateResolutions([{ observedKey: 'cpa/y/shared-llm', action: 'accept', catalogId: 'bedrock/shared-llm' }]);
    expect(r1.applied).toBe(1);
    expect((await loadPricingConfig()).rules['shared-llm']).toMatchObject({ input: 7, source: 'models.dev' });
    // 共享 model id 命中第一条（文档化行为）
    const r2 = await applyCandidateResolutions([{ observedKey: 'cpa/y/shared-llm', action: 'accept', catalogId: 'shared-llm' }]);
    expect(r2.applied).toBe(1);
    expect((await loadPricingConfig()).rules['shared-llm']).toMatchObject({ input: 5, source: 'models.dev' });
  });
});
