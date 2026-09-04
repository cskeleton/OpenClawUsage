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
});
