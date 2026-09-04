import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import {
  getStats,
  resetStatsServiceForTests,
  __setAutoRematchFetchImplForTests,
} from '../../../stats-service.js';
import {
  defaultPricingConfigV2,
  loadPricingConfig,
  savePricingConfig,
} from '../../../pricing.js';

const disposables = [];

afterEach(async () => {
  resetStatsServiceForTests();
  while (disposables.length) await disposables.pop()();
});

const FIXTURE_DB = fixturePath('db', 'openclaw-agent.sqlite');

// 样本库中仅 bohe/kimi-k3 能在该目录精确命中，且其余模型 id 与 kimi-k3 相似度低于弱召回阈值：
// 预期唯一命中写入 rules['kimi-k3']（source: 'models.dev'），其余模型不产生候选
const fakeCatalog = {
  moonshotai: { models: { 'kimi-k3': { name: 'Kimi K3', cost: { input: 0.5, output: 2 } } } },
};

async function setupWorkspace(fetchImpl) {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  ws.copyFixtureDb(FIXTURE_DB);
  await savePricingConfig(defaultPricingConfigV2());
  __setAutoRematchFetchImplForTests(fetchImpl);
  return ws;
}

/** 等待后台 rematch 把唯一命中写入 rules */
async function waitForMatchedRule() {
  await vi.waitFor(async () => {
    expect((await loadPricingConfig()).rules['kimi-k3']?.source).toBe('models.dev');
  });
}

/**
 * 目录拉取闸门：fetchImpl 立即返回时，后台 rematch 可能抢在 getStats 组装响应的
 * 第二次读配置之前完成写入，使「首次返回」的断言变成竞态；先闸住目录即可确定时序。
 */
function gatedCatalog() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { await gate; return fakeCatalog; };
  return { fetchImpl, release: () => release() };
}

describe('stats-service lazy auto-rematch hook', () => {
  it('writes the unique catalog hit into rules after the first getStats merge', async () => {
    const { fetchImpl, release } = gatedCatalog();
    await setupWorkspace(fetchImpl);

    const first = await getStats();
    expect(first.byModel['bohe/kimi-k3'].costSource).toBe('openclaw');

    release();
    await waitForMatchedRule();
    const cfg = await loadPricingConfig();
    expect(cfg.rules['kimi-k3']).toMatchObject({
      input: 0.5,
      output: 2,
      enabled: true,
      source: 'models.dev',
    });
  });

  it('re-prices the matched model on the next getStats', async () => {
    const { fetchImpl, release } = gatedCatalog();
    await setupWorkspace(fetchImpl);

    await getStats();
    release();
    await waitForMatchedRule();

    const after = await getStats();
    expect(after.byModel['bohe/kimi-k3'].costSource).toBe('models.dev');
  });

  it('returns normally when the catalog is unavailable', async () => {
    await setupWorkspace(async () => {
      throw new Error('network down');
    });

    const data = await getStats();
    expect(data.summary.totalRequests).toBeGreaterThan(0);

    // 给后台钩子留完成窗口：catalog 不可用应静默跳过（不写规则、不失效缓存）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Object.keys((await loadPricingConfig()).rules)).toHaveLength(0);

    const again = await getStats();
    expect(again.byModel['bohe/kimi-k3'].costSource).toBe('openclaw');
  });

  // 回归：2026-09-04 本机 ~/.openclaw 配置被后台写打穿的根因之一是
  // fire-and-forget 落盘晚于测试 afterEach 还原 env，写到了还原后的路径。
  it('pins the config path at trigger time so background writes survive env changes', async () => {
    const { fetchImpl, release } = gatedCatalog();
    const ws = await setupWorkspace(fetchImpl);

    await getStats(); // 触发后台 rematch，目录拉取被闸住（尚未写盘）

    // 模拟下一个测试建 workspace：env 指向全新目录
    const ws2 = await createTmpWorkspace();
    disposables.push(ws2.cleanup);

    release();
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(join(ws.configDir, 'openclaw-usage-pricing.json'), 'utf-8'));
      expect(raw.rules['kimi-k3']?.source).toBe('models.dev');
    });

    // 写必须落在触发时的 ws，不得漂移到 env 切换后的 ws2
    expect(existsSync(join(ws2.configDir, 'openclaw-usage-pricing.json'))).toBe(false);
    expect(existsSync(join(ws2.configDir, 'openclaw-usage-pricing-candidates.json'))).toBe(false);
  });
});
