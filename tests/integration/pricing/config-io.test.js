import { describe, it, expect, afterEach } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  existsSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  detectOpenClawDir,
  loadPricingConfig,
  savePricingConfig,
} from '../../../pricing.js';

// 说明：pricing.js 在调用时读取环境变量，无模块级缓存，
// 因此使用顶部静态 import 即可，无需 `?t=${Date.now()}` 这类破坏 ESM 缓存的做法。
// tests/setup.js 负责在每个 test 前后保存/还原 OPENCLAW_CONFIG_DIR / OPENCLAW_DIR。

// NOTE: detectOpenClawDir 还有另一分支——读取 ~/.openclaw/openclaw.json
// 中 agents.defaults.workspace 字段。由于该分支需要写用户真实 home 目录下的
// openclaw.json，这里暂不覆盖；env 变量路径是主路径，优先保障。

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

/**
 * pricing.js 中 loadPricingConfig 的回退逻辑会无条件探测真实 home 下的
 * ~/.openclaw/openclaw-usage-pricing.json（不受 OPENCLAW_DIR 影响）。
 * 为避免被用户本地旧文件"污染"，在个别需要默认分支的用例里临时将其改名
 * 挪开，测试结束由 disposables 安全还原。属于非破坏性的 rename。
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

describe('detectOpenClawDir', () => {
  it('honors OPENCLAW_DIR env', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    expect(await detectOpenClawDir()).toBe(ws.workspaceDir);
  });
});

describe('loadPricingConfig / savePricingConfig', () => {
  it('returns default shape when file absent', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    // 避免用户 home 下真实的旧价格文件触发 legacy 回退
    disposables.push(stashLegacyPricingFile());

    const cfg = await loadPricingConfig();
    expect(cfg.version).toBe('1.0');
    expect(cfg.pricing).toEqual({});
  });

  it('saves and loads round-trip', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    await savePricingConfig({
      version: '1.0',
      enabled: true,
      pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } },
    });

    const loaded = await loadPricingConfig();
    expect(loaded.pricing['openai/gpt-4o'].input).toBe(2.5);
    expect(loaded.enabled).toBe(true);
    expect(typeof loaded.updated).toBe('string');
  });

  it('persists file under OPENCLAW_DIR', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    await savePricingConfig({
      version: '1.0',
      enabled: true,
      pricing: {},
    });
    const persistedPath = join(ws.workspaceDir, 'openclaw-usage-pricing.json');
    expect(existsSync(persistedPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(persistedPath, 'utf-8'));
    expect(parsed.version).toBe('1.0');
  });
});

/**
 * 传统路径迁移测试会向用户真实 ~/.openclaw 目录写入（并在测试前备份 / 测试后还原），
 * 属于"破坏性"场景。默认跳过；本地冒烟时通过 RUN_LEGACY_MIGRATION=1 npm test 开启。
 */
const runLegacy = process.env.RUN_LEGACY_MIGRATION ? it : it.skip;

describe('legacy migration', () => {
  runLegacy('migrates from legacy ~/.openclaw path if new one missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const legacyDir = join(homedir(), '.openclaw');
    const legacyFile = join(legacyDir, 'openclaw-usage-pricing.json');
    const legacyBackup = `${legacyFile}.before-test-${Date.now()}`;
    let restoreLegacy = () => {};

    mkdirSync(legacyDir, { recursive: true });
    try {
      writeFileSync(legacyBackup, readFileSync(legacyFile));
      restoreLegacy = () => writeFileSync(legacyFile, readFileSync(legacyBackup));
    } catch {
      // 本地未存在旧文件，无需还原
    }
    disposables.push(async () => {
      try { restoreLegacy(); } catch {}
      try { rmSync(legacyBackup, { force: true }); } catch {}
    });

    writeFileSync(legacyFile, JSON.stringify({
      version: '1.0',
      pricing: { 'legacy/model': { input: 7, output: 7 } },
    }));

    const cfg = await loadPricingConfig();
    expect(cfg.pricing['legacy/model']).toBeTruthy();

    const migrated = JSON.parse(readFileSync(
      join(ws.workspaceDir, 'openclaw-usage-pricing.json'), 'utf-8',
    ));
    expect(migrated.pricing['legacy/model']).toBeTruthy();
  });
});
