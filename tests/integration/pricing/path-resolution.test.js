import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  loadPricingConfig,
  savePricingConfig,
  defaultPricingConfigV2,
  resolvePricingConfigPath,
  legacyPricingPathCandidates,
} from '../../../pricing.js';

// 说明：pricing.js 在调用时读取环境变量，无模块级缓存；
// tests/setup.js 负责在每个 test 前后保存/还原
// OPENCLAW_CONFIG_DIR / OPENCLAW_DIR / OPENCLAW_USAGE_PRICING_PATH。

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

// 双保险：tests/setup.js 已在每个 test 后还原 env（vitest.config.js 将
// setupFiles 挂在各 project 下，projects 模式下顶层 setupFiles 不生效），
// 本文件凡改动 OPENCLAW_USAGE_PRICING_PATH 的用例仍通过 disposables 自行还原。
function setPricingPathEnv(value) {
  const prev = process.env.OPENCLAW_USAGE_PRICING_PATH;
  if (value === undefined) delete process.env.OPENCLAW_USAGE_PRICING_PATH;
  else process.env.OPENCLAW_USAGE_PRICING_PATH = value;
  disposables.push(async () => {
    if (prev === undefined) delete process.env.OPENCLAW_USAGE_PRICING_PATH;
    else process.env.OPENCLAW_USAGE_PRICING_PATH = prev;
  });
}

/**
 * 与 config-io.test.js 相同的非破坏性 stash：legacy 候选会无条件探测真实 home 下的
 * ~/.openclaw/openclaw-usage-pricing.json，为避免被用户本地旧文件"污染"，
 * 在需要干净读取分支的用例里临时改名挪开，测试结束由 disposables 还原。
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

describe('resolvePricingConfigPath', () => {
  it('honors OPENCLAW_USAGE_PRICING_PATH over everything', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const explicit = join(ws.workspaceDir, 'custom-pricing.json');
    setPricingPathEnv(explicit);

    expect(await resolvePricingConfigPath()).toBe(explicit);
    await savePricingConfig(defaultPricingConfigV2());
    expect(existsSync(explicit)).toBe(true);
  });

  it('prefers OPENCLAW_CONFIG_DIR over OPENCLAW_DIR (deprecated alias)', async () => {
    // createTmpWorkspace 同时设置两者：OPENCLAW_CONFIG_DIR=configDir, OPENCLAW_DIR=workspaceDir
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    expect(await resolvePricingConfigPath()).toBe(
      join(ws.configDir, 'openclaw-usage-pricing.json'),
    );
  });

  it('falls back to OPENCLAW_DIR when OPENCLAW_CONFIG_DIR is unset', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const prevConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    delete process.env.OPENCLAW_CONFIG_DIR;
    disposables.push(async () => {
      if (prevConfigDir === undefined) delete process.env.OPENCLAW_CONFIG_DIR;
      else process.env.OPENCLAW_CONFIG_DIR = prevConfigDir;
    });
    expect(await resolvePricingConfigPath()).toBe(
      join(ws.workspaceDir, 'openclaw-usage-pricing.json'),
    );
  });
});

describe('legacyPricingPathCandidates', () => {
  it('lists workspace-detected dir then ~/.openclaw, excluding the canonical path', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const candidates = await legacyPricingPathCandidates();
    expect(candidates).toEqual([
      join(ws.workspaceDir, 'openclaw-usage-pricing.json'),
      join(homedir(), '.openclaw', 'openclaw-usage-pricing.json'),
    ]);
    expect(candidates).not.toContain(await resolvePricingConfigPath());
  });

  it('dedups when the workspace-detected dir is ~/.openclaw', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    process.env.OPENCLAW_DIR = join(homedir(), '.openclaw');
    const candidates = await legacyPricingPathCandidates();
    expect(candidates).toEqual([
      join(homedir(), '.openclaw', 'openclaw-usage-pricing.json'),
    ]);
  });
});

describe('pricing path resolution', () => {
  it('honors OPENCLAW_USAGE_PRICING_PATH over everything', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const explicit = join(ws.workspaceDir, 'custom-pricing.json');
    setPricingPathEnv(explicit);
    await savePricingConfig(defaultPricingConfigV2());
    expect(existsSync(explicit)).toBe(true);
  });

  it('uses OPENCLAW_CONFIG_DIR as the canonical location', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    disposables.push(stashLegacyPricingFile());
    await savePricingConfig(defaultPricingConfigV2());
    expect(existsSync(join(ws.configDir, 'openclaw-usage-pricing.json'))).toBe(true);
  });

  it('savePricingConfig 原子写：内容完整且无 tmp 残留', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    disposables.push(stashLegacyPricingFile());
    await savePricingConfig(defaultPricingConfigV2());
    const leftovers = readdirSync(ws.configDir).filter((f) => f.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
    const parsed = JSON.parse(readFileSync(join(ws.configDir, 'openclaw-usage-pricing.json'), 'utf-8'));
    expect(parsed.version).toBe('2.0');
  });

  it('migrates a v1 file found at the workspace-detected legacy path', async () => {
    // 构造：OPENCLAW_CONFIG_DIR 指向空目录 configDir；workspace 探测目录
    // （detectOpenClawDir 经 OPENCLAW_DIR → workspaceDir）下存在 v1 旧文件
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    disposables.push(stashLegacyPricingFile());

    writeFileSync(
      join(ws.workspaceDir, 'openclaw-usage-pricing.json'),
      JSON.stringify({
        enabled: true,
        pricing: {
          'openai/gpt-4o': { input: 2.5, output: 10 },
          'anthropic/*': { input: 3, output: 15, matchType: 'wildcard' },
        },
      }),
      'utf-8',
    );

    const cfg = await loadPricingConfig();
    expect(cfg.version).toBe('2.0');
    // rules / patterns 拆分正确
    expect(cfg.rules['openai/gpt-4o']).toMatchObject({ input: 2.5, output: 10, source: 'manual' });
    expect(cfg.rules['openai/gpt-4o'].matchType).toBeUndefined();
    expect(cfg.patterns['anthropic/*']).toMatchObject({ input: 3, output: 15, matchType: 'wildcard' });

    // 迁移结果写回规范路径（OPENCLAW_CONFIG_DIR），而非 legacy 来源路径
    const canonicalPath = join(ws.configDir, 'openclaw-usage-pricing.json');
    expect(existsSync(canonicalPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(canonicalPath, 'utf-8'));
    expect(persisted.version).toBe('2.0');
    expect(persisted.rules['openai/gpt-4o']).toBeTruthy();
    expect(persisted.patterns['anthropic/*']).toBeTruthy();
  });
});
