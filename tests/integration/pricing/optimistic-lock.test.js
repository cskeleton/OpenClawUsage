import { describe, it, expect, afterEach } from 'vitest';
import { renameSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { loadPricingConfig, savePricingConfig, defaultPricingConfigV2 } from '../../../pricing.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

/**
 * 从 config-io.test.js 复制的非破坏性 stash：savePricingConfig 以外的读取分支
 * 会探测真实 home 下的 ~/.openclaw/openclaw-usage-pricing.json，为避免被用户
 * 本地旧文件"污染"，在需要干净初始状态的用例里临时改名挪开，测试结束由
 * disposables 安全还原。
 */
function stashLegacyPricingFile() {
  const legacyFile = join(homedir(), '.openclaw', 'openclaw-usage-pricing.json');
  const stashed = `${legacyFile}.stashed-by-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let restored = false;
  if (existsSync(legacyFile)) {
    renameSync(legacyFile, stashed);
    return async () => {
      if (restored) return;
      restored = true;
      try { renameSync(stashed, legacyFile); } catch {}
    };
  }
  return async () => {};
}

describe('pricing optimistic lock', () => {
  it('bumps revision on content change and refreshes updated', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const cfg = defaultPricingConfigV2();
    const r1 = await savePricingConfig(cfg);
    expect(r1.revision).toBe(1);
    cfg.rules['m'] = { input: 1, output: 2, source: 'manual' };
    const r2 = await savePricingConfig(cfg, { baseRevision: r1.revision });
    expect(r2.revision).toBe(2);
    expect(r2.updated >= r1.updated).toBe(true);
  });

  it('no-op save keeps revision and updated', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const cfg = defaultPricingConfigV2();
    const r1 = await savePricingConfig(cfg);
    const again = await loadPricingConfig();
    const r2 = await savePricingConfig(again);
    expect(r2.changed).toBe(false);
    expect(r2.revision).toBe(1);
    expect(r2.updated).toBe(r1.updated);
  });

  it('rejects stale baseRevision with PRICING_REVISION_CONFLICT and current config', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const r1 = await savePricingConfig(defaultPricingConfigV2());
    const cfg = defaultPricingConfigV2();
    cfg.rules['x'] = { input: 1, output: 1 };
    await savePricingConfig(cfg, { baseRevision: r1.revision }); // revision → 2
    await expect(savePricingConfig(cfg, { baseRevision: r1.revision }))
      .rejects.toMatchObject({ code: 'PRICING_REVISION_CONFLICT' });
  });

  it('first save against absent file accepts baseRevision 0', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    disposables.push(stashLegacyPricingFile()); // 从 config-io.test.js 复制
    const r = await savePricingConfig(defaultPricingConfigV2(), { baseRevision: 0 });
    expect(r.revision).toBe(1);
  });
});
