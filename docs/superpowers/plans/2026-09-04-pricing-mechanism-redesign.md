# 价格机制重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将价格机制升级为「归一化匹配管线 + models.dev 自动填价 + 官方价/真实成本双口径」，并顺带完成读时校验、乐观锁、路径统一、失效治理与成本来源透传。

**Architecture:** 查询时归一化（方案 1）：贡献缓存保持原始 `provider/model`，merge 阶段（`stats-contribution.js`）执行匹配管线（别名 → 原始键精确 → 归一化候选 → legacy pattern → 账面回退）；models.dev 匹配器对未覆盖模型自动填价（唯一命中）或进确认队列（歧义），候选存独立文件。配置升级 v2（rules/aliases/patterns/matching + revision 乐观锁）。

**Tech Stack:** Node ≥ 24（`node:sqlite`、zstd）、原生 ESM、Express、Vitest 双 project（Node + jsdom）、无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-04-pricing-mechanism-redesign-design.md`（实施前必读；spec 为准，偏差在实施后回写 spec）

## Global Constraints

- Node ≥ 24；全部文件为原生 ESM（`import`/`export`），**禁止新增 package.json 依赖**。
- 测试：Vitest 双 project。单测运行 `npx vitest run <file>`；全量 `npm test`。Node 测 jsdom 测试分别落在 `tests/unit/**`（除 frontend）与 `tests/unit/frontend/**`。
- 测试隔离陷阱：`pricing.js` 路径解析读取 env；`tests/setup.js` 自动保存/还原 `OPENCLAW_CONFIG_DIR` / `OPENCLAW_DIR`（新增 `OPENCLAW_USAGE_PRICING_PATH` 须同步加入 setup.js 的保存/还原列表）。涉及「文件不存在」分支时参考 `tests/integration/pricing/config-io.test.js` 的 `stashLegacyPricingFile()` 模式。
- 所有面向用户的新增文案（UI、README）中英双语：词典 `src/locales/zh-CN.js` 与 `src/locales/en-US.js` 同步加 key；`README.md` ↔ `README_EN.md` 同步。
- 写接口全部过 `server.js` 的 `writeRequestGuard`（同源 Origin + JSON Content-Type），新端点挂在 `/api` 下自动获得防护。
- 价格展示单位统一 `$/M`；`cacheRead`/`cacheWrite` 为 `null`/缺省 = 按该规则 input 原价（显式 0 就是 0）。
- UI 风格与现有页面一致（布局、间距、按钮尺寸沿用 pricing.html 现有 class），不引入新视觉样式。
- 每任务完成后按该任务的 commit 步骤提交（conventional commit，如 `feat(pricing): ...`）。
- 完成后须做 Post-Implementation Sync Audit：把实现与 spec 的偏差回写 `docs/superpowers/specs/2026-09-04-pricing-mechanism-redesign-design.md`，并更新 `AGENTS.md` 相关条目。

## File Structure

**新建：**

- `pricing-normalize.js` — 归一化候选生成：`DEFAULT_NOISE_SUFFIXES`、`generateModelKeyCandidates(provider, model, noiseSuffixes)`、`splitModelKey(key)`
- `pricing-catalog-matcher.js` — models.dev 匹配器：`buildCatalogIndex(models)`、`matchObservedKey(provider, model, options)`、打分函数
- `pricing-candidates-store.js` — 确认队列文件 IO：`loadCandidates()`、`saveCandidates(state)`、`upsertCandidateEntry(state, entry)`
- `pricing-matching-service.js` — 自动匹配编排：`rematchObservedKeys(keys, options)`、`applyCandidateResolutions(resolutions)`
- 测试：`tests/unit/pricing/{normalize,pipeline,migrate-v2,catalog-matcher,candidates-store,matching-service}.test.js`、`tests/unit/frontend/pricing-v2-ui.test.js`、`tests/integration/pricing/{optimistic-lock,path-resolution,candidates-api,migration-equivalence}.test.js`

**修改：**

- `pricing.js` — v2 schema（迁移/校验/读写/乐观锁/no-op 保存）、`resolvePricingRule`、`applyPricingResolution`、路径统一
- `stats-cache-store.js` — `buildPricingFingerprint` 改 `{version, enabled, updated, revision}`
- `stats-contribution.js` — `costForBucket` 透传完整成本对象；byModel 行增加 `canonical`/`costSource`/`costBreakdown`；summary 增加 `costBySource`；`STATS_SHAPE_VERSION` 3→4；匹配结果 memo
- `stats-service.js` — `updatePricingConfig(config, {baseRevision})`、`getPricingConfigDetailed()`、stats 侧坏配置回退、自动 rematch 钩子
- `server.js` — `PUT /api/pricing` 信封 + 409/422；`GET /api/pricing` 附 `validationErrors`；新增 candidates/rematch 三端点；`attachCustomRule` 改用 resolver
- `mcp-server.js` — `update_pricing_config` 增加 `baseRevision` 入参；冲突结构化错误
- `src/pricing.js` + `pricing.html` — 确认队列区（批量操作）、ignoreProvider 开关、噪声后缀管理、source 徽标、409 处理
- `src/main.js` + `src/charts.js` + `index.html` — canonical 分组视图、来源徽标、成本构成图
- `src/locales/{zh-CN,en-US}.js`、`README.md`、`README_EN.md`、`pricing.json.example`、`tests/setup.js`、`AGENTS.md`

---

### Task 1: 配置 v2 schema——迁移、校验、读写

**Files:**
- Modify: `pricing.js`（`loadPricingConfig`/`savePricingConfig`/`validatePricingConfig` 重写；新增 `migratePricingConfigV1toV2`、`defaultPricingConfigV2`、`loadPricingConfigDetailed`、`stablePricingStringify`）
- Test: `tests/unit/pricing/migrate-v2.test.js`（新建）、`tests/unit/pricing/validate.test.js`（补充 v2 用例）

**Interfaces:**
- Produces（后续任务依赖）：
  - `PRICING_SCHEMA_VERSION = '2.0'`
  - `defaultPricingConfigV2()` → `{ version:'2.0', enabled:true, updated:'0001-01-01T00:00:00.000Z', revision:0, matching:{ ignoreProvider:true, noiseSuffixes:[...] }, rules:{}, aliases:{}, patterns:{} }`
  - `migratePricingConfigV1toV2(v1)` → v2 配置对象
  - `loadPricingConfigDetailed()` → `{ config, validationErrors: string[] }`
  - `loadPricingConfig()` → 配置对象（保持旧签名，= detailed 的 config）
  - `validatePricingConfig(config)` → 非法时 throw（消息含字段路径）
  - `stablePricingStringify(obj)` → 键排序后的稳定序列化字符串

注意：本任务暂不改路径解析（仍用现有 `getPricingConfigPath`，Task 2 替换）与 revision 语义（Task 3 实现冲突检测；本任务仅读写 `revision` 字段原样透传）。`DEFAULT_NOISE_SUFFIXES` 由 Task 4 的 `pricing-normalize.js` 提供，本任务在 `defaultPricingConfigV2` 中先内联字面量 `['-high','-thinking','-low','-medium']`，Task 4 改为 import。

- [ ] **Step 1: 写失败测试**

`tests/unit/pricing/migrate-v2.test.js`：

```js
import { describe, it, expect } from 'vitest';
import {
  migratePricingConfigV1toV2,
  defaultPricingConfigV2,
  validatePricingConfig,
} from '../../../pricing.js';

describe('migratePricingConfigV1toV2', () => {
  it('moves exact entries to rules with source manual, patterns to patterns', () => {
    const v2 = migratePricingConfigV1toV2({
      version: '1.0',
      enabled: true,
      updated: '2026-09-01T00:00:00.000Z',
      pricing: {
        'openai/gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null },
        '*deepseek-v4-pro*': { input: 0.435, output: 0.87, matchType: 'wildcard', enabled: true },
        '/gpt-5\\.6.*/i': { input: 2, output: 12, matchType: 'regex' },
      },
    });
    expect(v2.version).toBe('2.0');
    expect(v2.revision).toBe(1);
    expect(v2.rules['openai/gpt-5.5']).toMatchObject({ input: 5, output: 30, source: 'manual' });
    expect(v2.rules['openai/gpt-5.5'].matchType).toBeUndefined();
    expect(v2.patterns['*deepseek-v4-pro*']).toMatchObject({ matchType: 'wildcard' });
    expect(v2.patterns['/gpt-5\\.6.*/i']).toMatchObject({ matchType: 'regex' });
    expect(v2.aliases).toEqual({});
    expect(v2.matching.ignoreProvider).toBe(true);
    expect(v2.matching.noiseSuffixes).toContain('-thinking');
    expect(v2.updated).toBe('2026-09-01T00:00:00.000Z'); // 保留旧时间戳
    expect(() => validatePricingConfig(v2)).not.toThrow();
  });

  it('preserves enabled=false and empty pricing', () => {
    const v2 = migratePricingConfigV1toV2({ version: '1.0', enabled: false, pricing: {} });
    expect(v2.enabled).toBe(false);
    expect(v2.rules).toEqual({});
  });
});

describe('defaultPricingConfigV2', () => {
  it('is valid and stable', () => {
    const cfg = defaultPricingConfigV2();
    expect(cfg.updated).toBe('0001-01-01T00:00:00.000Z');
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });
});
```

`tests/unit/pricing/validate.test.js` 追加 describe：

```js
describe('validatePricingConfig v2', () => {
  const base = () => defaultPricingConfigV2();

  it('rejects rules entry with negative input', () => {
    const cfg = base();
    cfg.rules['m'] = { input: -1, output: 1 };
    expect(() => validatePricingConfig(cfg)).toThrow(/rules\.m/);
  });

  it('rejects invalid source value', () => {
    const cfg = base();
    cfg.rules['m'] = { input: 1, output: 1, source: 'upstream' };
    expect(() => validatePricingConfig(cfg)).toThrow(/source/);
  });

  it('rejects alias with empty target', () => {
    const cfg = base();
    cfg.aliases['cpa/agy/x'] = '';
    expect(() => validatePricingConfig(cfg)).toThrow(/aliases/);
  });

  it('rejects non-boolean matching.ignoreProvider', () => {
    const cfg = base();
    cfg.matching.ignoreProvider = 'yes';
    expect(() => validatePricingConfig(cfg)).toThrow(/ignoreProvider/);
  });

  it('accepts explicit zero cache prices (configured ≠ unset)', () => {
    const cfg = base();
    cfg.rules['m'] = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });

  it('still validates pattern entries (wildcard needs * or ?, regex must compile)', () => {
    const cfg = base();
    cfg.patterns['no-wildcard-here'] = { input: 1, output: 1, matchType: 'wildcard' };
    expect(() => validatePricingConfig(cfg)).toThrow(/wildcard/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pricing/migrate-v2.test.js tests/unit/pricing/validate.test.js`
Expected: FAIL（`migratePricingConfigV1toV2 is not a function` / `defaultPricingConfigV2 is not a function`）

- [ ] **Step 3: 实现**

`pricing.js` 中：

```js
export const PRICING_SCHEMA_VERSION = '2.0';

const DEFAULT_NOISE_SUFFIXES_INLINE = ['-high', '-thinking', '-low', '-medium'];

export function defaultPricingConfigV2() {
  return {
    version: PRICING_SCHEMA_VERSION,
    enabled: true,
    updated: '0001-01-01T00:00:00.000Z',
    revision: 0,
    matching: { ignoreProvider: true, noiseSuffixes: [...DEFAULT_NOISE_SUFFIXES_INLINE] },
    rules: {},
    aliases: {},
    patterns: {},
  };
}

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
    matching: { ignoreProvider: true, noiseSuffixes: [...DEFAULT_NOISE_SUFFIXES_INLINE] },
    rules,
    aliases: {},
    patterns,
  };
}

export function stablePricingStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stablePricingStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stablePricingStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
```

`validatePricingConfig` 重写为 v2：校验 `version` 为字符串；`enabled` 布尔；`matching.ignoreProvider` 布尔（若存在）、`matching.noiseSuffixes` 为字符串数组；`rules`/`patterns` 为对象且逐条校验（抽出共用的 `validateRuleEntry(fieldPath, entry)`：input/output 非负数、cacheRead/cacheWrite 为 null/undefined/非负数、enabled 布尔——错误消息统一带 `rules.<key>` / `patterns.<key>` 前缀）；`rules` 条目 `source`（若存在）仅允许 `'manual' | 'models.dev'`、不得含 `matchType`；`patterns` 条目沿用现有 matchType/wildcard/regex 校验；`aliases` 为「非空字符串 → 非空字符串」映射。

`loadPricingConfigDetailed` / `loadPricingConfig` / `savePricingConfig`：

```js
export async function loadPricingConfigDetailed() {
  const configPath = await getPricingConfigPath();
  let raw = null;
  try {
    raw = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      // legacy 回退（保留现有 LEGACY_PRICING_PATH 迁移逻辑，Task 2 扩展）
      try {
        raw = JSON.parse(await readFile(LEGACY_PRICING_PATH, 'utf-8'));
      } catch { /* 不存在 */ }
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
      await savePricingConfig(config);
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

export async function loadPricingConfig() {
  return (await loadPricingConfigDetailed()).config;
}

export async function savePricingConfig(config) {
  validatePricingConfig(config);
  config.updated = new Date().toISOString();
  const configPath = await getPricingConfigPath();
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
```

注意 `savePricingConfig` 本任务保持旧签名（Task 3 扩展为带 `{ baseRevision }` 与返回值）。同时删除死代码 `getPricingVersion`（先 Grep 确认无调用方）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/pricing/`
Expected: PASS（含既有 calculate-cost / find-matching / wildcard-and-regex 不回归）

- [ ] **Step 5: Commit**

```bash
git add pricing.js tests/unit/pricing/migrate-v2.test.js tests/unit/pricing/validate.test.js
git commit -m "feat(pricing): v2 config schema with migration and validation"
```

---

### Task 2: 配置路径统一与迁移

**Files:**
- Modify: `pricing.js`（新增 `resolvePricingConfigPath`、`legacyPricingPathCandidates`；`loadPricingConfigDetailed`/`savePricingConfig` 改用新路径；`detectOpenClawDir` 标注 deprecated 并保留为 legacy 候选来源）
- Modify: `tests/setup.js`（env 保存/还原列表加 `OPENCLAW_USAGE_PRICING_PATH`）
- Test: `tests/integration/pricing/path-resolution.test.js`（新建）；`tests/integration/pricing/config-io.test.js`（按新语义修正）

**Interfaces:**
- Produces：
  - `resolvePricingConfigPath()` → `Promise<string>`，优先级：`OPENCLAW_USAGE_PRICING_PATH` env > `$OPENCLAW_CONFIG_DIR/openclaw-usage-pricing.json` > `$OPENCLAW_DIR/openclaw-usage-pricing.json`（deprecated alias）> `~/.openclaw/openclaw-usage-pricing.json`
  - `legacyPricingPathCandidates()` → `Promise<string[]>`：依次为 workspace 探测路径（现 `detectOpenClawDir` 逻辑的目录 + `/openclaw-usage-pricing.json`）、`~/.openclaw/openclaw-usage-pricing.json`（去重、且不含新规范路径本身）

- [ ] **Step 1: 写失败测试**

`tests/integration/pricing/path-resolution.test.js`（沿用 `config-io.test.js` 的 `createTmpWorkspace` + `disposables` + `stashLegacyPricingFile` 模式）：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { loadPricingConfig, savePricingConfig, defaultPricingConfigV2 } from '../../../pricing.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

describe('pricing path resolution', () => {
  it('honors OPENCLAW_USAGE_PRICING_PATH over everything', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const explicit = join(ws.workspaceDir, 'custom-pricing.json');
    process.env.OPENCLAW_USAGE_PRICING_PATH = explicit;
    await savePricingConfig(defaultPricingConfigV2());
    expect(existsSync(explicit)).toBe(true);
    delete process.env.OPENCLAW_USAGE_PRICING_PATH;
  });

  it('uses OPENCLAW_CONFIG_DIR as the canonical location', async () => {
    const ws = await createTmpWorkspace(); // createTmpWorkspace 同时设置 OPENCLAW_CONFIG_DIR / OPENCLAW_DIR 指向临时目录
    disposables.push(ws.cleanup);
    disposables.push(stashLegacyPricingFile());
    await savePricingConfig(defaultPricingConfigV2());
    expect(existsSync(join(ws.configDir, 'openclaw-usage-pricing.json'))).toBe(true);
  });

  it('migrates a v1 file found at the workspace-detected legacy path', async () => {
    // 构造：OPENCLAW_CONFIG_DIR 指向空目录 A；workspace 探测目录 B（经 openclaw.json agents.defaults.workspace 指向 B）下存在 v1 旧文件
    // 断言：loadPricingConfig 返回迁移后的 v2（rules/patterns 拆分正确），且新规范路径已写入 v2 文件
  });
});
```

第三个用例的完整实现参考 `config-io.test.js` 现有 legacy 迁移用例（`tests/integration/pricing/config-io.test.js` 后半部分），将断言目标从「写回 workspace 探测路径」改为「写回 OPENCLAW_CONFIG_DIR 新路径」。`stashLegacyPricingFile` 从 `config-io.test.js` 复制（测试内重复定义，不抽公共模块）。

注：`createTmpWorkspace()` 返回 `{ workspaceDir, configDir, cleanup }`——实现前读 `tests/helpers/tmp-workspace.js` 确认字段名，若仅有 `workspaceDir` 则用 `process.env.OPENCLAW_CONFIG_DIR` 取 configDir。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/pricing/path-resolution.test.js`
Expected: FAIL（`resolvePricingConfigPath is not exported` / 路径断言失败）

- [ ] **Step 3: 实现**

`pricing.js`：

```js
/**
 * 定价配置文件规范路径。
 * 优先级：OPENCLAW_USAGE_PRICING_PATH > OPENCLAW_CONFIG_DIR > OPENCLAW_DIR（deprecated alias）> ~/.openclaw
 */
export async function resolvePricingConfigPath() {
  const explicit = process.env.OPENCLAW_USAGE_PRICING_PATH;
  if (explicit) return explicit;
  const dir = process.env.OPENCLAW_CONFIG_DIR
    || process.env.OPENCLAW_DIR
    || join(homedir(), '.openclaw');
  return join(dir, 'openclaw-usage-pricing.json');
}

/** legacy 候选（迁移来源），按优先级；不含规范路径自身 */
export async function legacyPricingPathCandidates() {
  const canonical = await resolvePricingConfigPath();
  const candidates = [];
  const detected = await detectOpenClawDir(); // 保留现有 workspace 探测逻辑
  candidates.push(join(detected, 'openclaw-usage-pricing.json'));
  candidates.push(join(homedir(), '.openclaw', 'openclaw-usage-pricing.json'));
  return [...new Set(candidates)].filter((p) => p !== canonical);
}
```

`loadPricingConfigDetailed` 的读取逻辑改为：先读 `resolvePricingConfigPath()`；ENOENT 时按 `legacyPricingPathCandidates()` 顺序找到第一个可读文件作为 `raw`，并在后续迁移/保存时写回**规范路径**（即完成迁移）。`savePricingConfig` 写 `resolvePricingConfigPath()`。`detectOpenClawDir` 注释改为「deprecated：仅为 legacy 迁移候选保留」。删除 `LEGACY_PRICING_PATH` 常量（由 candidates 覆盖）。

`tests/setup.js`：env 保存/还原列表加入 `OPENCLAW_USAGE_PRICING_PATH`。

`config-io.test.js` 中与新语义冲突的用例（如「写回 workspace 探测路径」）按新路径断言修正。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/pricing/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pricing.js tests/setup.js tests/integration/pricing/
git commit -m "feat(pricing): unify config path under OPENCLAW_CONFIG_DIR with legacy migration"
```

---

### Task 3: revision 乐观锁、no-op 保存与指纹规范化

**Files:**
- Modify: `pricing.js`（`savePricingConfig(config, { baseRevision })` → `{ revision, updated, changed }`；冲突错误 `code: 'PRICING_REVISION_CONFLICT'`）
- Modify: `stats-cache-store.js`（`buildPricingFingerprint`）
- Modify: `stats-service.js`（`updatePricingConfig(config, { baseRevision } = {})` → `{ ok, revision, updated }`）
- Test: `tests/integration/pricing/optimistic-lock.test.js`（新建）；`tests/unit/pricing/fingerprint.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 `stablePricingStringify`、`defaultPricingConfigV2`；Task 2 `resolvePricingConfigPath`
- Produces：
  - `savePricingConfig(config, { baseRevision } = {})` → `Promise<{ revision: number, updated: string, changed: boolean }>`；冲突时 throw `err.code === 'PRICING_REVISION_CONFLICT'` 且 `err.current` 为磁盘当前配置
  - `updatePricingConfig(config, { baseRevision } = {})` → `{ ok: true, revision, updated }`
  - `buildPricingFingerprint(config)` → `{ version, enabled, updated, revision }`

- [ ] **Step 1: 写失败测试**

`tests/integration/pricing/optimistic-lock.test.js`：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { loadPricingConfig, savePricingConfig, defaultPricingConfigV2 } from '../../../pricing.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

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
```

`tests/unit/pricing/fingerprint.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { buildPricingFingerprint, fingerprintsEqual } from '../../../stats-cache-store.js';

describe('buildPricingFingerprint', () => {
  it('is key-order insensitive (revision/updated capture content)', () => {
    const a = { version: '2.0', enabled: true, updated: 'T1', revision: 3, rules: { a: { input: 1 }, b: { input: 2 } } };
    const b = { revision: 3, updated: 'T1', enabled: true, version: '2.0', rules: { b: { input: 2 }, a: { input: 1 } } };
    expect(fingerprintsEqual(buildPricingFingerprint(a), buildPricingFingerprint(b))).toBe(true);
  });

  it('differs when revision or updated differ', () => {
    const a = buildPricingFingerprint({ version: '2.0', updated: 'T1', revision: 1 });
    const b = buildPricingFingerprint({ version: '2.0', updated: 'T2', revision: 2 });
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/pricing/optimistic-lock.test.js tests/unit/pricing/fingerprint.test.js`
Expected: FAIL（savePricingConfig 无返回值 / 指纹含 pricing 字段）

- [ ] **Step 3: 实现**

`pricing.js`：

```js
function stripPricingMeta(config) {
  const { updated, revision, ...rest } = config || {};
  return rest;
}

/**
 * 保存价格配置（乐观锁 + no-op 检测）。
 * @param {Object} config - v2 配置
 * @param {{ baseRevision?: number }} [options] - 提供时与磁盘当前 revision 比较，不符则冲突
 * @returns {Promise<{ revision: number, updated: string, changed: boolean }>}
 */
export async function savePricingConfig(config, { baseRevision } = {}) {
  validatePricingConfig(config);
  const configPath = await resolvePricingConfigPath();
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
    await writeFile(configPath, JSON.stringify(next, null, 2), 'utf-8');
  }
  return { revision: next.revision, updated: next.updated, changed };
}
```

注意 Task 1 的迁移路径调用 `savePricingConfig(config)`（无 baseRevision，内部写入，允许强制）。

`stats-cache-store.js` 的 `buildPricingFingerprint` 替换为：

```js
/**
 * 构建定价指纹。savePricingConfig 保证「内容实质变化 ⇔ updated/revision 变化」，
 * 因此指纹只需这四个字段，天然键序不敏感。candidates 文件不参与。
 */
export function buildPricingFingerprint(pricingConfig) {
  return {
    version: pricingConfig?.version || 'none',
    enabled: pricingConfig?.enabled !== false,
    updated: pricingConfig?.updated || '',
    revision: typeof pricingConfig?.revision === 'number' ? pricingConfig.revision : 0,
  };
}
```

`stats-service.js` 的 `updatePricingConfig`：

```js
export async function updatePricingConfig(config, { baseRevision } = {}) {
  validatePricingConfig(config);
  const { revision, updated } = await savePricingConfig(config, { baseRevision });
  invalidateStatsCache();
  return { ok: true, revision, updated };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/pricing/optimistic-lock.test.js tests/unit/pricing/fingerprint.test.js tests/integration/stats-service/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pricing.js stats-cache-store.js stats-service.js tests/integration/pricing/optimistic-lock.test.js tests/unit/pricing/fingerprint.test.js
git commit -m "feat(pricing): revision-based optimistic locking and content-aware invalidation"
```

---

### Task 4: 归一化候选生成模块

**Files:**
- Create: `pricing-normalize.js`
- Modify: `pricing.js`（`defaultPricingConfigV2`/`migratePricingConfigV1toV2` 改为 import `DEFAULT_NOISE_SUFFIXES`，删除 Task 1 内联字面量）
- Test: `tests/unit/pricing/normalize.test.js`

**Interfaces:**
- Produces：
  - `DEFAULT_NOISE_SUFFIXES = ['-high', '-thinking', '-low', '-medium']`
  - `generateModelKeyCandidates(provider, model, noiseSuffixes = DEFAULT_NOISE_SUFFIXES)` → `string[]`（有序、去重；首元素为原始 `model`）
  - `splitModelKey(key)` → `{ provider, model }`（按**第一个** `/` 切分，model 段可含 `/`，如 `cpa/agy/gemini-3.8-flash` → `{ provider: 'cpa', model: 'agy/gemini-3.8-flash' }`）

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NOISE_SUFFIXES,
  generateModelKeyCandidates,
  splitModelKey,
} from '../../../pricing-normalize.js';

describe('splitModelKey', () => {
  it('splits on the first slash only', () => {
    expect(splitModelKey('cpa/agy/gemini-3.8-flash-high'))
      .toEqual({ provider: 'cpa', model: 'agy/gemini-3.8-flash-high' });
    expect(splitModelKey('deepseek/deepseek-v4-pro'))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });
});

describe('generateModelKeyCandidates', () => {
  it('strips channel prefix segments and noise suffixes', () => {
    const c = generateModelKeyCandidates('cpa', 'agy/gemini-3.8-flash-high');
    expect(c[0]).toBe('agy/gemini-3.8-flash-high');
    expect(c).toContain('gemini-3.8-flash-high');
    expect(c).toContain('gemini-3.8-flash');
  });

  it('strips nested catalog-style prefixes', () => {
    expect(generateModelKeyCandidates('nvidia', 'deepseek-ai/deepseek-v4-flash'))
      .toContain('deepseek-v4-flash');
  });

  it('lowercases variants', () => {
    expect(generateModelKeyCandidates('minimax-portal', 'MiniMax-M3'))
      .toContain('minimax-m3');
  });

  it('does NOT strip distinctive suffixes (-pro is not noise)', () => {
    const c = generateModelKeyCandidates('cpa', 'mimo-v2.5-pro');
    expect(c).not.toContain('mimo-v2.5');
  });

  it('does NOT strip model-family suffixes like -luna/-sol/-terra', () => {
    const c = generateModelKeyCandidates('openai', 'gpt-5.6-luna');
    expect(c).not.toContain('gpt-5.6');
  });

  it('strips -thinking but keeps the base model', () => {
    expect(generateModelKeyCandidates('cpa', 'justwoker/claude-opus-5-thinking'))
      .toContain('claude-opus-5');
  });

  it('respects custom noiseSuffixes', () => {
    const c = generateModelKeyCandidates('cpa', 'x/y-0731', ['-0731']);
    expect(c).toContain('y');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pricing/normalize.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`pricing-normalize.js`：

```js
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
```

`pricing.js`：`import { DEFAULT_NOISE_SUFFIXES } from './pricing-normalize.js';`，替换 `DEFAULT_NOISE_SUFFIXES_INLINE` 两处。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/pricing/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pricing-normalize.js pricing.js tests/unit/pricing/normalize.test.js
git commit -m "feat(pricing): model name normalization candidate generator"
```

---

### Task 5: 匹配管线 resolver（别名 → 原始键 → 归一化 → pattern）

**Files:**
- Modify: `pricing.js`（新增 `resolvePricingRule`、`applyPricingResolution`；`calculateCostFromUsage` 改为二者组合；`findMatchingPricing` 保留仅服务 patterns）
- Test: `tests/unit/pricing/pipeline.test.js`（新建）

**Interfaces:**
- Consumes: Task 4 `generateModelKeyCandidates`、`DEFAULT_NOISE_SUFFIXES`
- Produces：
  - `resolvePricingRule(provider, model, config)` → `null | { rule: object, canonical: string, matchedKey: string, via: 'alias'|'exact'|'normalized'|'pattern' }`。**跳过 `enabled === false` 的条目并继续查找**（与 v1 `findMatchingPricing` 的 pattern 循环语义一致）
  - `applyPricingResolution(usage, resolution)` → `{ input, output, cacheRead, cacheWrite, total, source, canonical }`；`source ∈ 'manual' | 'models.dev' | 'pattern' | 'openclaw'`
  - `calculateCostFromUsage(usage, provider, model, config)` → 同上形状（签名不变，内部 = resolve + apply）

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import { resolvePricingRule, calculateCostFromUsage } from '../../../pricing.js';

const baseConfig = () => ({
  version: '2.0',
  enabled: true,
  updated: 'T',
  revision: 1,
  matching: { ignoreProvider: true, noiseSuffixes: ['-high', '-thinking'] },
  rules: {},
  aliases: {},
  patterns: {},
});

const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, totalTokens: 3e6, cost: { total: 99, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

describe('resolvePricingRule priority chain', () => {
  it('alias wins over everything', () => {
    const cfg = baseConfig();
    cfg.aliases['cpa/agy/gemini-3.8-flash-high'] = 'gemini-3.8-flash';
    cfg.rules['gemini-3.8-flash'] = { input: 0.5, output: 3, source: 'manual' };
    cfg.rules['agy/gemini-3.8-flash-high'] = { input: 9, output: 9, source: 'manual' };
    const r = resolvePricingRule('cpa', 'agy/gemini-3.8-flash-high', cfg);
    expect(r).toMatchObject({ via: 'alias', canonical: 'gemini-3.8-flash' });
    expect(r.rule.input).toBe(0.5);
  });

  it('raw exact key hit preserves v1 semantics regardless of ignoreProvider', () => {
    const cfg = baseConfig();
    cfg.rules['openai/gpt-5.5'] = { input: 5, output: 30, source: 'manual' };
    const r = resolvePricingRule('openai', 'gpt-5.5', cfg);
    expect(r).toMatchObject({ via: 'exact', matchedKey: 'openai/gpt-5.5' });
  });

  it('normalized candidate hits canonical rule across messy prefixes/suffixes', () => {
    const cfg = baseConfig();
    cfg.rules['deepseek-v4-flash'] = { input: 0.14, output: 0.28, source: 'models.dev' };
    for (const [p, m] of [
      ['cpa', 'agy/deepseek-v4-flash'],
      ['nvidia', 'deepseek-ai/deepseek-v4-flash'],
      ['bohe', 'deepseek-v4-flash'],
    ]) {
      const r = resolvePricingRule(p, m, cfg);
      expect(r, `${p}/${m}`).toMatchObject({ via: 'normalized', canonical: 'deepseek-v4-flash' });
    }
  });

  it('mimo-v2.5 rule does NOT match mimo-v2.5-pro', () => {
    const cfg = baseConfig();
    cfg.rules['mimo-v2.5'] = { input: 0.14, output: 0.28, source: 'manual' };
    expect(resolvePricingRule('cpa', 'mimo-v2.5-pro', cfg)).toBeNull();
    expect(resolvePricingRule('cpa', 'mimo-v2.5', cfg)).toMatchObject({ via: 'normalized' });
  });

  it('ignoreProvider=false prefers provider-qualified rule, then bare canonical', () => {
    const cfg = baseConfig();
    cfg.matching.ignoreProvider = false;
    cfg.rules['deepseek-v4-pro'] = { input: 0.435, output: 0.87, source: 'manual' };
    cfg.rules['fireworks/deepseek-v4-pro'] = { input: 3, output: 9, source: 'manual' };
    expect(resolvePricingRule('fireworks', 'deepseek-v4-pro', cfg).rule.input).toBe(3);
    expect(resolvePricingRule('deepseek', 'deepseek-v4-pro', cfg).rule.input).toBe(0.435);
  });

  it('ignoreProvider=true skips provider-qualified rules entirely', () => {
    const cfg = baseConfig();
    cfg.rules['fireworks/deepseek-v4-pro'] = { input: 3, output: 9, source: 'manual' };
    cfg.rules['deepseek-v4-pro'] = { input: 0.435, output: 0.87, source: 'manual' };
    expect(resolvePricingRule('fireworks', 'deepseek-v4-pro', cfg).rule.input).toBe(0.435);
  });

  it('disabled entries are skipped and search continues', () => {
    const cfg = baseConfig();
    cfg.rules['gpt-5.5'] = { input: 5, output: 30, enabled: false, source: 'manual' };
    cfg.patterns['*gpt-5.5*'] = { input: 1, output: 2, matchType: 'wildcard' };
    const r = resolvePricingRule('openai', 'gpt-5.5', cfg);
    expect(r).toMatchObject({ via: 'pattern' });
    expect(r.rule.input).toBe(1);
  });

  it('falls back to patterns then null', () => {
    const cfg = baseConfig();
    cfg.patterns['*gpt-5.4*'] = { input: 2.5, output: 15, matchType: 'wildcard' };
    expect(resolvePricingRule('anyrouter', 'claude-fable-5', cfg)).toBeNull();
    expect(resolvePricingRule('x', 'gpt-5.4-mini', cfg)).toMatchObject({ via: 'pattern' });
  });
});

describe('calculateCostFromUsage source labeling', () => {
  it('returns source models.dev for synced rules', () => {
    const cfg = baseConfig();
    cfg.rules['deepseek-v4-flash'] = { input: 0.14, output: 0.28, source: 'models.dev' };
    const r = calculateCostFromUsage(usage, 'bohe', 'deepseek-v4-flash', cfg);
    expect(r.source).toBe('models.dev');
    expect(r.canonical).toBe('deepseek-v4-flash');
    expect(r.input).toBeCloseTo(0.14);
    expect(r.cacheRead).toBeCloseTo(0.14); // cacheRead null → input 原价
  });

  it('returns source pattern for legacy wildcard hits', () => {
    const cfg = baseConfig();
    cfg.patterns['*luna*'] = { input: 0.2, output: 1.2, matchType: 'wildcard' };
    expect(calculateCostFromUsage(usage, 'openai', 'gpt-5.6-luna', cfg).source).toBe('pattern');
  });

  it('returns source openclaw when nothing matches', () => {
    const r = calculateCostFromUsage(usage, 'qwen', 'qwen3.8-max-preview', baseConfig());
    expect(r.source).toBe('openclaw');
    expect(r.total).toBe(99);
  });

  it('returns source openclaw when globally disabled', () => {
    const cfg = baseConfig();
    cfg.enabled = false;
    cfg.rules['qwen3.8-max-preview'] = { input: 1, output: 1 };
    expect(calculateCostFromUsage(usage, 'qwen', 'qwen3.8-max-preview', cfg).source).toBe('openclaw');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pricing/pipeline.test.js`
Expected: FAIL（`resolvePricingRule is not exported`）

- [ ] **Step 3: 实现**

`pricing.js` 追加（`findMatchingPricing` 保留，仅用于 patterns 查找与 `attachCustomRule` 过渡期）：

```js
import { DEFAULT_NOISE_SUFFIXES, generateModelKeyCandidates } from './pricing-normalize.js';

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

  const direct = rules[rawKey];
  if (direct && direct.enabled !== false) {
    return { rule: direct, canonical: model, matchedKey: rawKey, via: 'exact' };
  }

  const noiseSuffixes = config.matching?.noiseSuffixes || DEFAULT_NOISE_SUFFIXES;
  for (const candidate of generateModelKeyCandidates(provider, model, noiseSuffixes)) {
    if (candidate === model) continue; // 原始键精确已覆盖
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
 */
export function applyPricingResolution(usage, resolution) {
  if (!resolution) return openclawCostFallback(usage);
  const pricing = resolution.rule;
  const inputCost = (pricing.input * (usage.input || 0)) / TOKENS_PER_UNIT;
  const outputCost = (pricing.output * (usage.output || 0)) / TOKENS_PER_UNIT;
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
```

`calculateCostFromUsage` 重写为组合（保留签名与「配置为 null / 全局关闭 → 账面价」行为；空 rules+patterns 时 resolve 自然返回 null，同样回退）：

```js
export function calculateCostFromUsage(usage, provider, model, pricingConfig) {
  if (!pricingConfig || pricingConfig.enabled === false) {
    return openclawCostFallback(usage);
  }
  return applyPricingResolution(usage, resolvePricingRule(provider, model, pricingConfig));
}
```

`openclawCostFallback` 返回值增加 `canonical: model`？——fallback 处拿不到 model 参数。改为：`openclawCostFallback(usage, model)` 增加可选第二参，`canonical: model ?? null`。调用方（calculateCostFromUsage、applyPricingResolution、stats-contribution）传入。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/pricing/`
Expected: PASS（既有用例不回归；注意既有 calculate-cost.test.js 的 v1 形状 `{ pricing: {...} }` 将失配——v2 后 `calculateCostFromUsage` 读 `rules`/`patterns`，需把既有用例的 config 迁移为 v2 形状：exact 条目放 `rules`、wildcard 放 `patterns`。同步更新 `tests/unit/pricing/find-matching.test.js` 与 `wildcard-and-regex.test.js`：`findMatchingPricing` 行为不变应直接通过，若有构造 v1 config 调用 `calculateCostFromUsage` 的用例同样迁移。）

- [ ] **Step 5: Commit**

```bash
git add pricing.js tests/unit/pricing/
git commit -m "feat(pricing): matching pipeline resolver with alias/normalization/provider scoping"
```

---

### Task 6: merge 透传 canonical/costSource/costBreakdown + memo

**Files:**
- Modify: `stats-contribution.js`（`costForBucket` 返回完整成本对象；`mergeFileContributions` 增加 memo 与输出字段；`STATS_SHAPE_VERSION` 3→4；`buildEmptyStats` 同步）
- Test: `tests/unit/stats/cost-passthrough.test.js`（新建；目录不存在则建，沿用现有 contribution 测试的构造方式——先 Grep `mergeFileContributions` 找到现有测试文件参考其 fixture 构造）

**Interfaces:**
- Consumes: Task 5 `resolvePricingRule`、`applyPricingResolution`
- Produces（merge 输出形状，前端与 MCP 依赖）：
  - `byModel[key]` 增加：`canonical: string|null`、`costSource: 'manual'|'models.dev'|'pattern'|'openclaw'`（混合来源时取该 key 下占比最高 bucket 的来源？——不，单 key 单来源：bucket 级来源相同，直接取）、`costBreakdown: { input, output, cacheRead, cacheWrite }`
  - `summary.costBySource: { manual: number, 'models.dev': number, pattern: number, openclaw: number }`
  - `byHourModel`/`byDateModel` 的 cell 增加 `costSource`、`canonical`
  - `STATS_SHAPE_VERSION = 4`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import { mergeFileContributions, STATS_SHAPE_VERSION } from '../../../stats-contribution.js';

const config = {
  version: '2.0', enabled: true, updated: 'T', revision: 1,
  matching: { ignoreProvider: true, noiseSuffixes: ['-high', '-thinking'] },
  rules: { 'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null, source: 'models.dev' } },
  aliases: {},
  patterns: { '*gpt-5.4*': { input: 2.5, output: 15, matchType: 'wildcard' } },
};

function contributionOf(provider, model, usage) {
  return {
    session: { id: 's1', status: 'done', archivedAt: null },
    buckets: [{
      date: '2026-09-03T10', provider, model,
      usage: { totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, ...usage },
      openclawCost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      requests: 1,
    }],
    hasRecords: true,
    firstTimestamp: '2026-09-03T10:00:00Z',
    lastTimestamp: '2026-09-03T10:05:00Z',
  };
}

describe('merge passthrough', () => {
  it('byModel rows carry canonical/costSource/costBreakdown', () => {
    const stats = mergeFileContributions({
      a: contributionOf('nvidia', 'deepseek-ai/deepseek-v4-flash', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }),
      b: contributionOf('x', 'gpt-5.4-mini', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
      c: contributionOf('qwen', 'qwen3.8-max-preview', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }, config);
    const flash = stats.byModel['nvidia/deepseek-ai/deepseek-v4-flash'];
    expect(flash.canonical).toBe('deepseek-v4-flash');
    expect(flash.costSource).toBe('models.dev');
    expect(flash.costBreakdown.input).toBeCloseTo(0.14);
    expect(flash.costBreakdown.cacheRead).toBeCloseTo(0.0028);
    expect(stats.byModel['x/gpt-5.4-mini'].costSource).toBe('pattern');
    const miss = stats.byModel['qwen/qwen3.8-max-preview'];
    expect(miss.costSource).toBe('openclaw');
    expect(miss.totalCost).toBe(10); // 账面价
  });

  it('summary carries costBySource totals', () => {
    const stats = mergeFileContributions({
      a: contributionOf('bohe', 'deepseek-v4-flash', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
      c: contributionOf('qwen', 'qwen3.8-max-preview', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }, config);
    expect(stats.summary.costBySource['models.dev']).toBeCloseTo(0.14);
    expect(stats.summary.costBySource.openclaw).toBe(10);
  });

  it('shape version bumped to 4', () => {
    expect(STATS_SHAPE_VERSION).toBe(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/stats/cost-passthrough.test.js`
Expected: FAIL（无 `canonical` 等字段）

- [ ] **Step 3: 实现**

`stats-contribution.js`：

- `STATS_SHAPE_VERSION` 改为 `4`，文件头注释追加 `v4：merge 输出新增 canonical/costSource/costBreakdown/costBySource（贡献结构不变，读盘形状不匹配时从 files 重合并）`
- `costForBucket(bucket, pricingConfig, resolutionCache)`：

```js
function costForBucket(bucket, pricingConfig, resolutionCache) {
  const cacheKey = `${bucket.provider}\0${bucket.model}`;
  let resolution;
  if (resolutionCache.has(cacheKey)) {
    resolution = resolutionCache.get(cacheKey);
  } else {
    resolution = pricingConfig ? resolvePricingRule(bucket.provider, bucket.model, pricingConfig) : null;
    resolutionCache.set(cacheKey, resolution);
  }
  const usageForCost = {
    input: bucket.usage.input, output: bucket.usage.output,
    cacheRead: bucket.usage.cacheRead, cacheWrite: bucket.usage.cacheWrite,
    totalTokens: bucket.usage.totalTokens, cost: bucket.openclawCost,
  };
  const cost = pricingConfig && pricingConfig.enabled !== false
    ? applyPricingResolution(usageForCost, resolution)
    : openclawFallbackViaCalculate(usageForCost, bucket.model); // 直接调 calculateCostFromUsage 亦可，保证 enabled=false 分支一致
  if (!cost || typeof cost.total !== 'number' || !Number.isFinite(cost.total) || cost.total < 0) {
    throw new Error('unsafe statistics aggregate value: totalCost');
  }
  return cost;
}
```

简化：memo 缓存 resolution；成本计算仍走 `calculateCostFromUsage` 会破坏 memo（它内部再 resolve 一次）。因此正确做法是：`calculateCostFromUsage` 内部重构为可选第三形态——`applyPricingResolution` 接受 usage + resolution；`costForBucket` 直接用 `applyPricingResolution`（config null/enabled=false 时 resolution 必为 null → fallback），`calculateCostFromUsage` 保留为「无 memo」便捷封装。确保 `applyPricingResolution(null)` 路径返回带 `canonical: bucket.model` 的 fallback（Task 5 已让 `openclawCostFallback(usage, model)` 支持）。

- `mergeFileContributions`：`const resolutionCache = new Map();`，bucket 循环里 `const cost = costForBucket(bucket, pricingConfig, resolutionCache);`；`byModel` 行初始化与累加：

```js
if (!Object.hasOwn(byModel, modelKey)) {
  byModel[modelKey] = {
    provider: bucket.provider, model: bucket.model,
    canonical: cost.canonical ?? bucket.model,
    costSource: cost.source,
    costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...emptyBucket(),
  };
}
const m = byModel[modelKey];
// ...原有 addAggregate 累加后：
m.costBreakdown.input += cost.input;
m.costBreakdown.output += cost.output;
m.costBreakdown.cacheRead += cost.cacheRead;
m.costBreakdown.cacheWrite += cost.cacheWrite;
```

- `summary.costBySource`：初始化 `{ manual: 0, 'models.dev': 0, pattern: 0, openclaw: 0 }`，每个 bucket `summary.costBySource[cost.source] += cost.total`（用普通 += 与 finite 检查，不走 addAggregate 的字段名约束）。
- `addToCrossTable` 增加可选 `meta` 参数（`{ costSource, canonical }`），调用处（byHourModel、byDateModel）传入；cell 初始化时挂上 meta。`byDateProvider`/`byDate`/sessionStats 不传。
- `buildEmptyStats` 的 summary 同步加 `costBySource: { manual: 0, 'models.dev': 0, pattern: 0, openclaw: 0 }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/stats/ tests/integration/stats-service/`
Expected: PASS（注意既有 stats-service 缓存测试可能持久化了 v3 shape——若有 shape 断言失败的用例，按 v4 更新其期望）

- [ ] **Step 5: Commit**

```bash
git add stats-contribution.js tests/unit/stats/
git commit -m "feat(stats): pass through canonical/costSource/costBreakdown in merged stats"
```

---

### Task 7: HTTP 与 MCP 写契约（信封、409/422、validationErrors）

**Files:**
- Modify: `stats-service.js`（`getPricingConfigDetailed()` 导出；stats 加载路径用「安全配置」）
- Modify: `server.js`（`GET /api/pricing`、`PUT /api/pricing`、`POST /api/pricing/reset`）
- Modify: `mcp-server.js`（`update_pricing_config` 入参与冲突处理；description 双语更新）
- Test: `tests/integration/server/pricing-api.test.js`（新建，沿用 `tests/integration/server/api.test.js` 的 app 启动/请求模式——先读该文件确认是用 supertest 还是 fetch）

**Interfaces:**
- Consumes: Task 1 `loadPricingConfigDetailed`；Task 3 `updatePricingConfig(config, { baseRevision })`
- Produces：
  - `GET /api/pricing` → `{ ...config, validationErrors?: string[] }`（顶层含 `revision`）
  - `PUT /api/pricing` body `{ config, baseRevision }` → 200 `{ ok, revision, updated }` / 409 `{ code:'PRICING_REVISION_CONFLICT', error, current }` / 422 `{ code:'PRICING_VALIDATION_FAILED', error }` / 400 `{ code:'PRICING_BAD_REQUEST' }`
  - `POST /api/pricing/reset` → `{ ok, revision, updated }`（默认 v2 空配置，无条件写入）
  - MCP `update_pricing_config` 入参 `{ config, baseRevision? }`；冲突时 `isError: true`，text 为 `JSON.stringify({ code:'PRICING_REVISION_CONFLICT', current })`
  - stats-service `getPricingConfigDetailed()` → `{ config, validationErrors }`

- [ ] **Step 1: 写失败测试**

```js
// tests/integration/server/pricing-api.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { createApp } from '../../../server.js';
// 请求方式沿用 api.test.js（supertest 或 node fetch + ephemeral listen）

describe('pricing write contract', () => {
  it('GET /api/pricing returns v2 config with revision', async () => {
    // 临时 workspace；GET → expect(body.version).toBe('2.0'); expect(body.revision).toBe(0);
  });

  it('PUT without envelope → 400', async () => {
    // PUT body = 裸 config → 400 { code: 'PRICING_BAD_REQUEST' }
  });

  it('PUT round-trip then stale baseRevision → 409 with current', async () => {
    // GET 拿 revision → PUT { config, baseRevision } → 200 且 revision+1
    // 再用旧 baseRevision PUT → 409，body.current.revision 为最新
  });

  it('PUT invalid config → 422 with field path in error', async () => {
    // config.rules['m'] = { input: -1 } → 422，error 含 'rules.m'
  });

  it('GET surfaces validationErrors when on-disk config is corrupt', async () => {
    // 直接 writeFileSync 一个 JSON 语法错误的配置文件 → GET 200 且 validationErrors 非空，
    // 且 GET /api/stats 不 500（stats 回退账面价）
  });
});
```

实现前把每个注释用例补全为完整代码（请求助手从 `api.test.js` 复制）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/server/pricing-api.test.js`
Expected: FAIL（400/409/422 行为未实现）

- [ ] **Step 3: 实现**

`server.js`：

```js
  // GET /api/pricing - 获取当前价格配置（含 revision 与可选 validationErrors）
  app.get('/api/pricing', async (req, res) => {
    try {
      const { config, validationErrors } = await getPricingConfigDetailed();
      res.json(validationErrors.length ? { ...config, validationErrors } : config);
    } catch (err) {
      console.error('Error loading pricing config:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/pricing - 信封 { config, baseRevision }，乐观锁
  app.put('/api/pricing', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object'
          || typeof body.baseRevision !== 'number') {
        return res.status(400).json({ code: 'PRICING_BAD_REQUEST', error: '请求体须为 { config, baseRevision }' });
      }
      const result = await updatePricingConfig(body.config, { baseRevision: body.baseRevision });
      res.json(result);
    } catch (err) {
      if (err.code === 'PRICING_REVISION_CONFLICT') {
        return res.status(409).json({ code: err.code, error: err.message, current: err.current });
      }
      console.error('Error updating pricing config:', err);
      res.status(422).json({ code: 'PRICING_VALIDATION_FAILED', error: err.message });
    }
  });
```

`POST /api/pricing/reset`：默认配置改为 `defaultPricingConfigV2()`，`updatePricingConfig(defaultConfig)`（不传 baseRevision，强制），返回其结果。import 从 `stats-service.js` 增加 `getPricingConfigDetailed`，从 `pricing.js` 增加 `defaultPricingConfigV2`。

`stats-service.js`：

```js
export async function getPricingConfigDetailed() {
  return loadPricingConfigDetailed();
}
```

stats 加载路径（`ensureLoaded` 内当前 `loadPricingConfig()` 调用点——Grep 定位）：改为 `loadPricingConfigDetailed()`，`validationErrors.length > 0` 时 `console.warn('价格配置校验失败，统计回退账面价:', ...)` 并以 `null` 作为 pricingConfig（`calculateCostFromUsage` 对 null 回退账面价；`buildPricingFingerprint(null)` 已有防御）。

`mcp-server.js`：`update_pricing_config` 的 inputSchema `properties` 增加 `baseRevision: { type: "number", description: "Optimistic-lock revision from get_pricing_config / 来自 get_pricing_config 的乐观锁 revision" }`；handler：

```js
        case "update_pricing_config": {
          try {
            const result = await updatePricingConfig(args.config, { baseRevision: args.baseRevision });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } catch (error) {
            if (error.code === "PRICING_REVISION_CONFLICT") {
              return {
                content: [{ type: "text", text: JSON.stringify({ code: error.code, current: error.current }, null, 2) }],
                isError: true,
              };
            }
            throw error;
          }
        }
```

注意 `updatePricingConfig` 当前在 mcp-server.js 顶部从 stats-service import（确认现有 import 名不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/server/ tests/integration/mcp/`
Expected: PASS（`tests/integration/mcp/tools.test.js` 中 update_pricing_config 既有用例若无 baseRevision 应仍成功——可选语义）

- [ ] **Step 5: Commit**

```bash
git add server.js stats-service.js mcp-server.js tests/integration/server/pricing-api.test.js
git commit -m "feat(pricing): write envelope with optimistic lock, validation errors surfacing"
```

---

### Task 8: models.dev 目录匹配器

**Files:**
- Create: `pricing-catalog-matcher.js`
- Test: `tests/unit/pricing/catalog-matcher.test.js`（catalog fixture 内联构造，不打网络）

**Interfaces:**
- Consumes: Task 4 `generateModelKeyCandidates`；`models-dev.js` 的 catalog 条目形状 `{ key, provider, model, cost: { input, output, cacheRead, cacheWrite } }`
- Produces：
  - `buildCatalogIndex(models)` → `{ byModelId: Map<lowerModelId, entry[]> }`
  - `matchObservedKey(provider, model, { index, noiseSuffixes, ignoreProvider })` →
    `{ status: 'unique', match: { catalogKey, provider, model, prices: { input, output, cacheRead, cacheWrite } } }`
    | `{ status: 'ambiguous', candidates: [{ catalogKey, provider, model, prices, score, reason }] }`（≤8 条，按 score 降序）
    | `{ status: 'none' }`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import { buildCatalogIndex, matchObservedKey } from '../../../pricing-catalog-matcher.js';

const catalogModels = [
  { key: 'deepseek/deepseek-v4-flash', provider: 'deepseek', model: 'deepseek-v4-flash', cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null } },
  { key: 'fireworks/deepseek-v4-flash', provider: 'fireworks', model: 'deepseek-v4-flash', cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: null } },
  { key: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { key: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: null } },
];
const index = buildCatalogIndex(catalogModels);

describe('matchObservedKey', () => {
  it('unique: messy key normalizes to catalog model id; official entry preferred when ignoreProvider=true', () => {
    const r = matchObservedKey('cpa', 'agy/deepseek-v4-flash', { index, ignoreProvider: true });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('deepseek'); // 官方条目（provider token 出现在模型 id）
    expect(r.match.prices.input).toBe(0.14);
  });

  it('ignoreProvider=false prefers the observed provider entry when present in catalog', () => {
    const r = matchObservedKey('fireworks', 'deepseek-v4-flash', { index, ignoreProvider: false });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('fireworks');
    expect(r.match.prices.input).toBe(0.5);
  });

  it('ignoreProvider=false falls back to official entry when provider not in catalog', () => {
    const r = matchObservedKey('bohe', 'deepseek-v4-flash', { index, ignoreProvider: false });
    expect(r.status).toBe('unique');
    expect(r.match.provider).toBe('deepseek');
  });

  it('exact multi-provider without official heuristic → ambiguous', () => {
    // catalog 中同一 model id 两个 provider 且都不满足官方启发式
    const idx2 = buildCatalogIndex([
      { key: 'a/foo-9', provider: 'a', model: 'foo-9', cost: { input: 1, output: 1, cacheRead: null, cacheWrite: null } },
      { key: 'b/foo-9', provider: 'b', model: 'foo-9', cost: { input: 2, output: 2, cacheRead: null, cacheWrite: null } },
    ]);
    const r = matchObservedKey('x', 'foo-9', { index: idx2, ignoreProvider: true });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].reason).toBe('exact-multi-provider');
  });

  it('fuzzy: -thinking suffix strips to a unique catalog entry', () => {
    const r = matchObservedKey('cpa', 'justwoker/claude-opus-5-thinking', { index, ignoreProvider: true });
    expect(r.status).toBe('unique');
    expect(r.match.model).toBe('claude-opus-5');
  });

  it('none: nothing above weak threshold', () => {
    const r = matchObservedKey('x', 'totally-unknown-model-zzz', { index, ignoreProvider: true });
    expect(r.status).toBe('none');
  });

  it('fuzzy ambiguity queues top candidates with scores and reasons', () => {
    const idx3 = buildCatalogIndex([
      { key: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', cost: { input: 2, output: 12, cacheRead: null, cacheWrite: null } },
      { key: 'openai/gpt-5.6-codex', provider: 'openai', model: 'gpt-5.6-codex', cost: { input: 2, output: 12, cacheRead: null, cacheWrite: null } },
    ]);
    const r = matchObservedKey('cpa', 'gpt-5.6-codex-mini', { index: idx3, ignoreProvider: true });
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBeLessThanOrEqual(8);
    expect(r.candidates[0].score).toBeGreaterThanOrEqual(0.34);
    expect(r.candidates[0]).toHaveProperty('reason');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pricing/catalog-matcher.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`pricing-catalog-matcher.js`：

```js
import { generateModelKeyCandidates } from './pricing-normalize.js';

const SCORE_THRESHOLD = 0.55;   // 唯一自动生效阈值
const WEAK_THRESHOLD = 0.34;    // 弱召回：进入确认队列
const MAX_CANDIDATES = 8;

export function buildCatalogIndex(models) {
  const byModelId = new Map();
  for (const entry of models || []) {
    if (!entry || typeof entry.model !== 'string') continue;
    const id = entry.model.toLowerCase();
    if (!byModelId.has(id)) byModelId.set(id, []);
    byModelId.get(id).push(entry);
  }
  return { byModelId };
}

function tokenize(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenJaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function editSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** 候选打分：token Jaccard × 0.86 与编辑相似度 × 0.82 取大（参考 CPAMP） */
export function scoreCandidate(observed, catalogId) {
  return Math.max(tokenJaccard(observed, catalogId) * 0.86, editSimilarity(observed, catalogId) * 0.82);
}

/** 官方条目启发式：provider id 作为 token 出现在模型 id 中（deepseek/deepseek-v4-flash） */
function isOfficialEntry(entry) {
  return tokenize(entry.model).includes(String(entry.provider).toLowerCase());
}

function toPrices(cost) {
  return {
    input: cost?.input ?? null,
    output: cost?.output ?? null,
    cacheRead: cost?.cacheRead ?? null,
    cacheWrite: cost?.cacheWrite ?? null,
  };
}

function toCandidate(entry, score, reason) {
  return {
    catalogKey: entry.key,
    provider: entry.provider,
    model: entry.model,
    prices: toPrices(entry.cost),
    score,
    reason,
  };
}

/** 在精确命中的同 id 条目集合中按口径选择 */
function selectFromExactEntries(entries, provider, ignoreProvider) {
  if (!ignoreProvider) {
    const own = entries.filter((e) => e.provider === provider);
    if (own.length === 1) return { status: 'unique', match: toCandidate(own[0], 1, 'exact-own-provider') };
    if (own.length > 1) return { status: 'ambiguous', candidates: own.map((e) => toCandidate(e, 1, 'exact-own-provider-multi')) };
  }
  const official = entries.filter(isOfficialEntry);
  const pool = official.length ? official : entries;
  const reason = official.length ? 'exact-official' : 'exact-multi-provider';
  if (pool.length === 1 && official.length) return { status: 'unique', match: toCandidate(pool[0], 1, reason) };
  return { status: 'ambiguous', candidates: pool.map((e) => toCandidate(e, 1, reason)) };
}

/**
 * 对 observed provider/model 跑目录匹配。
 * @returns {{ status: 'unique', match: object } | { status: 'ambiguous', candidates: object[] } | { status: 'none' }}
 */
export function matchObservedKey(provider, model, { index, noiseSuffixes, ignoreProvider = true }) {
  // 1. 归一化候选逐个精确查 model id
  for (const candidate of generateModelKeyCandidates(provider, model, noiseSuffixes)) {
    const entries = index.byModelId.get(candidate.toLowerCase());
    if (entries?.length) return selectFromExactEntries(entries, provider, ignoreProvider);
  }
  // 2. 模糊：用最短候选（归一化程度最高）对全目录打分
  const candidates = generateModelKeyCandidates(provider, model, noiseSuffixes);
  const probe = candidates[candidates.length - 1].toLowerCase();
  const scored = [];
  for (const [id, entries] of index.byModelId) {
    const score = scoreCandidate(probe, id);
    if (score >= WEAK_THRESHOLD) {
      // 模糊命中同样 provider 感知
      const sub = selectFromExactEntries(entries, provider, ignoreProvider);
      const picked = sub.status === 'unique' ? sub.match : sub.candidates[0];
      scored.push({ ...picked, score, reason: score >= SCORE_THRESHOLD ? 'shared-model-tokens' : 'weak-recall' });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_CANDIDATES);
  if (top.length && top[0].score >= SCORE_THRESHOLD && (top.length === 1 || top[0].score > top[1].score)) {
    return { status: 'unique', match: top[0] };
  }
  if (top.length) return { status: 'ambiguous', candidates: top };
  return { status: 'none' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/pricing/catalog-matcher.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pricing-catalog-matcher.js tests/unit/pricing/catalog-matcher.test.js
git commit -m "feat(pricing): models.dev catalog matcher with provider-aware selection"
```

---

### Task 9: 确认队列存储与匹配编排服务

**Files:**
- Create: `pricing-candidates-store.js`、`pricing-matching-service.js`
- Test: `tests/unit/pricing/candidates-store.test.js`、`tests/unit/pricing/matching-service.test.js`

**Interfaces:**
- Consumes: Task 2 `resolvePricingConfigPath`；Task 3 `savePricingConfig`；Task 5 `resolvePricingRule`；Task 8 `buildCatalogIndex`、`matchObservedKey`；`models-dev.js` `getModelsDevCatalog({ fetchImpl })`
- Produces：
  - `loadCandidates()` → `{ candidates: CandidateEntry[] }`（文件缺失/损坏 → 空态，不抛错）
  - `saveCandidates(state)` → `Promise<void>`
  - `upsertCandidateEntry(state, entry)` → 就地更新（按 `observedKey` 去重，刷新 `lastSeenAt`）
  - `rematchObservedKeys(keys, { fetchImpl } = {})` → `{ scanned, matched, queued, catalogUnavailable? }`
  - `applyCandidateResolutions(resolutions)` → `{ applied: number, failed: [{ observedKey, error }] }`；`resolutions: [{ observedKey, action: 'accept'|'dismiss', catalogId? }]`
  - `CandidateEntry = { observedKey, candidates: [{ catalogKey, provider, model, prices, score, reason }], lastSeenAt, dismissed }`

- [ ] **Step 1: 写失败测试**

`tests/unit/pricing/candidates-store.test.js`：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import {
  loadCandidates,
  saveCandidates,
  upsertCandidateEntry,
} from '../../../pricing-candidates-store.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

describe('candidates store', () => {
  it('returns empty state when file missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    expect(await loadCandidates()).toEqual({ candidates: [] });
  });

  it('returns empty state on corrupt file (machine artifact, rebuildable)', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    writeFileSync(join(ws.configDir, 'openclaw-usage-pricing-candidates.json'), '{broken', 'utf-8');
    expect(await loadCandidates()).toEqual({ candidates: [] });
  });

  it('upsert dedupes by observedKey and refreshes lastSeenAt', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const state = { candidates: [] };
    upsertCandidateEntry(state, { observedKey: 'cpa/x', candidates: [], lastSeenAt: 'T1', dismissed: false });
    upsertCandidateEntry(state, { observedKey: 'cpa/x', candidates: [{ catalogKey: 'a/b' }], lastSeenAt: 'T2', dismissed: false });
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0].lastSeenAt).toBe('T2');
  });

  it('save/load round-trip', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await saveCandidates({ candidates: [{ observedKey: 'cpa/x', candidates: [], lastSeenAt: 'T', dismissed: false }] });
    expect((await loadCandidates()).candidates).toHaveLength(1);
  });
});
```

`tests/unit/pricing/matching-service.test.js`（fetchImpl 注入假 catalog，路径走 `createTmpWorkspace` env）：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { loadPricingConfig, savePricingConfig, defaultPricingConfigV2 } from '../../../pricing.js';
import { loadCandidates } from '../../../pricing-candidates-store.js';
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
    await rematchObservedKeys([], { fetchImpl: async () => fakeCatalog }); // 确保 store 文件路径就绪
    // 手工种一条候选
    const { saveCandidates } = await import('../../../pricing-candidates-store.js');
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
```

注意：测试前确认 `createTmpWorkspace()` 是否同时设置 `OPENCLAW_CONFIG_DIR`（`candidates` 与 pricing 文件同目录依赖它）；若只设 `OPENCLAW_DIR`，本任务实现的路径解析已将其作为 deprecated alias 覆盖，测试同样成立——以 `tmp-workspace.js` 实际行为为准调整断言路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pricing/candidates-store.test.js tests/unit/pricing/matching-service.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`pricing-candidates-store.js`：

```js
import { readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolvePricingConfigPath } from './pricing.js';

async function getCandidatesPath() {
  return join(dirname(await resolvePricingConfigPath()), 'openclaw-usage-pricing-candidates.json');
}

/** 读取确认队列。机器产物：缺失/损坏均返回空态（可由 rematch 再生成） */
export async function loadCandidates() {
  try {
    const parsed = JSON.parse(await readFile(await getCandidatesPath(), 'utf-8'));
    if (!parsed || !Array.isArray(parsed.candidates)) return { candidates: [] };
    return parsed;
  } catch {
    return { candidates: [] };
  }
}

export async function saveCandidates(state) {
  await writeFile(await getCandidatesPath(), JSON.stringify(state, null, 2), 'utf-8');
}

/** 按 observedKey 去重 upsert，刷新 lastSeenAt */
export function upsertCandidateEntry(state, entry) {
  const idx = state.candidates.findIndex((c) => c.observedKey === entry.observedKey);
  if (idx >= 0) state.candidates.splice(idx, 1);
  state.candidates.push(entry);
}
```

`pricing-matching-service.js`：

```js
import { loadPricingConfig, savePricingConfig } from './pricing.js';
import { resolvePricingRule } from './pricing.js';
import { splitModelKey } from './pricing-normalize.js';
import { buildCatalogIndex, matchObservedKey } from './pricing-catalog-matcher.js';
import { getModelsDevCatalog } from './models-dev.js';
import { loadCandidates, saveCandidates, upsertCandidateEntry } from './pricing-candidates-store.js';

/**
 * 对 observed keys 批量跑 models.dev 匹配：唯一命中写入 rules（source: models.dev），
 * 歧义进确认队列。已被 rules/aliases/patterns 覆盖的键跳过。
 * @param {string[]} keys - `provider/model` 列表
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ scanned: number, matched: number, queued: number, catalogUnavailable?: true }>}
 */
export async function rematchObservedKeys(keys, { fetchImpl } = {}) {
  const config = await loadPricingConfig();
  if (config.enabled === false) return { scanned: 0, matched: 0, queued: 0 };
  const uncovered = [...new Set(keys)].filter((key) => {
    const { provider, model } = splitModelKey(key);
    return !resolvePricingRule(provider, model, config);
  });
  if (!uncovered.length) return { scanned: 0, matched: 0, queued: 0 };

  let catalog;
  try {
    catalog = await getModelsDevCatalog({ fetchImpl });
  } catch {
    return { scanned: uncovered.length, matched: 0, queued: 0, catalogUnavailable: true };
  }
  const index = buildCatalogIndex(catalog.models);
  const candidatesState = await loadCandidates();
  const ignoreProvider = config.matching?.ignoreProvider !== false;
  const noiseSuffixes = config.matching?.noiseSuffixes;
  let matched = 0;
  let queued = 0;

  for (const key of uncovered) {
    const { provider, model } = splitModelKey(key);
    const result = matchObservedKey(provider, model, { index, noiseSuffixes, ignoreProvider });
    if (result.status === 'unique') {
      const { model: catalogModel, prices } = result.match;
      if (prices.input == null || prices.output == null) continue; // 无价目不入库
      config.rules[catalogModel] = {
        input: prices.input,
        output: prices.output,
        cacheRead: prices.cacheRead,
        cacheWrite: prices.cacheWrite,
        enabled: true,
        source: 'models.dev',
        syncedAt: catalog.fetchedAt,
      };
      matched++;
    } else if (result.status === 'ambiguous') {
      upsertCandidateEntry(candidatesState, {
        observedKey: key,
        candidates: result.candidates,
        lastSeenAt: new Date().toISOString(),
        dismissed: false,
      });
      queued++;
    }
  }
  if (matched > 0) await savePricingConfig(config);
  if (queued > 0) await saveCandidates(candidatesState);
  return { scanned: uncovered.length, matched, queued };
}

/**
 * 应用确认队列决议（批量）。
 * @param {Array<{ observedKey: string, action: 'accept'|'dismiss', catalogId?: string }>} resolutions
 */
export async function applyCandidateResolutions(resolutions) {
  const state = await loadCandidates();
  const config = await loadPricingConfig();
  let applied = 0;
  const failed = [];
  let configDirty = false;

  for (const r of resolutions || []) {
    const entry = state.candidates.find((c) => c.observedKey === r?.observedKey);
    if (!entry) {
      failed.push({ observedKey: r?.observedKey ?? '', error: 'candidate not found' });
      continue;
    }
    if (r.action === 'dismiss') {
      entry.dismissed = true;
      applied++;
      continue;
    }
    if (r.action === 'accept') {
      const chosen = entry.candidates.find((c) => c.model === r.catalogId || c.catalogKey === r.catalogId);
      if (!chosen || chosen.prices.input == null || chosen.prices.output == null) {
        failed.push({ observedKey: r.observedKey, error: 'catalogId not in candidates or missing prices' });
        continue;
      }
      config.aliases[entry.observedKey] = chosen.model;
      if (!config.rules[chosen.model] || config.rules[chosen.model].source !== 'manual') {
        config.rules[chosen.model] = {
          input: chosen.prices.input,
          output: chosen.prices.output,
          cacheRead: chosen.prices.cacheRead,
          cacheWrite: chosen.prices.cacheWrite,
          enabled: true,
          source: 'models.dev',
          syncedAt: new Date().toISOString(),
        };
      }
      entry.dismissed = true;
      configDirty = true;
      applied++;
      continue;
    }
    failed.push({ observedKey: r.observedKey, error: `unknown action: ${r.action}` });
  }

  if (configDirty) await savePricingConfig(config);
  await saveCandidates(state);
  return { applied, failed };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/pricing/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pricing-candidates-store.js pricing-matching-service.js tests/unit/pricing/candidates-store.test.js tests/unit/pricing/matching-service.test.js
git commit -m "feat(pricing): candidates store and auto-matching orchestration"
```

---

### Task 10: candidates/rematch HTTP 端点

**Files:**
- Modify: `server.js`（新增三端点）
- Test: `tests/integration/pricing/candidates-api.test.js`（请求模式沿用 `tests/integration/server/api.test.js`）

**Interfaces:**
- Consumes: Task 9 `rematchObservedKeys`、`applyCandidateResolutions`、`loadCandidates`
- Produces：
  - `GET /api/pricing/candidates` → `{ candidates: CandidateEntry[] }`（含 dismissed，由前端过滤）
  - `POST /api/pricing/candidates/resolve` body `{ resolutions: [...] }` → `{ ok, applied, failed }`；body 非法 → 400
  - `POST /api/pricing/rematch` body `{}` → `{ ok, scanned, matched, queued, catalogUnavailable? }`（keys 取自 `getStats().byModel`）

- [ ] **Step 1: 写失败测试**

```js
// tests/integration/pricing/candidates-api.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { createApp } from '../../../server.js';
// 请求助手从 tests/integration/server/api.test.js 复制（含 Content-Type: application/json）

describe('candidates API', () => {
  it('GET /api/pricing/candidates returns empty list initially', async () => {
    // → 200 { candidates: [] }
  });

  it('POST /api/pricing/candidates/resolve rejects non-array body → 400', async () => {
    // → 400
  });

  it('resolve accept writes alias+rule and round-trips through GET /api/pricing', async () => {
    // 先直接写 candidates 文件（saveCandidates），再 POST resolve accept，
    // 断言 GET /api/pricing 的 aliases/rules 已更新
  });

  it('write endpoints reject text/plain content type → 415 (writeRequestGuard)', async () => {
    // POST resolve 带 text/plain → 415
  });
});
```

`POST /api/pricing/rematch` 的集成断言依赖 stats 数据，放在 Task 11（与自动钩子一起测）；本任务只测参数与空态：`POST rematch` 在空 stats 下返回 `{ ok: true, scanned: 0, matched: 0, queued: 0 }`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/pricing/candidates-api.test.js`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`server.js`（import 区追加 `rematchObservedKeys`、`applyCandidateResolutions` 自 `pricing-matching-service.js`，`loadCandidates` 自 `pricing-candidates-store.js`）：

```js
  // GET /api/pricing/candidates - 确认队列（含 dismissed，前端过滤）
  app.get('/api/pricing/candidates', async (req, res) => {
    try {
      res.json(await loadCandidates());
    } catch (err) {
      console.error('Error loading pricing candidates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pricing/candidates/resolve - 批量决议 { resolutions: [{ observedKey, action, catalogId? }] }
  app.post('/api/pricing/candidates/resolve', async (req, res) => {
    try {
      const resolutions = req.body?.resolutions;
      if (!Array.isArray(resolutions)) {
        return res.status(400).json({ code: 'PRICING_BAD_REQUEST', error: '请求体须为 { resolutions: [...] }' });
      }
      const result = await applyCandidateResolutions(resolutions);
      invalidateStatsCache(); // accept 会改 rules/aliases → 触发 re-merge
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error resolving pricing candidates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pricing/rematch - 对 stats 中未覆盖模型批量重扫 models.dev
  app.post('/api/pricing/rematch', async (req, res) => {
    try {
      const data = await getStats();
      const keys = Object.keys(data.byModel || {});
      const result = await rematchObservedKeys(keys);
      if (result.matched > 0) invalidateStatsCache();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error rematching pricing:', err);
      res.status(500).json({ error: err.message });
    }
  });
```

`invalidateStatsCache` 若尚未 import 则加入 server.js 顶部 stats-service import 列表（Grep 确认现有 import）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/pricing/candidates-api.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.js tests/integration/pricing/candidates-api.test.js
git commit -m "feat(pricing): candidates and rematch HTTP endpoints"
```

---

### Task 11: stats-service 自动 rematch 钩子（惰性匹配）

**Files:**
- Modify: `stats-service.js`（merge 完成后对未覆盖模型自动触发一次 rematch；matched>0 → invalidate 触发 re-merge）
- Test: `tests/integration/stats-service/auto-rematch.test.js`

**Interfaces:**
- Consumes: Task 9 `rematchObservedKeys`；Task 6 merge 输出的 `costSource`
- Produces：
  - stats-service 内部 `maybeAutoRematch(stats)`：fire-and-forget、进程内 inflight 守卫、catalog 不可用静默跳过；`resetStatsServiceForTests` 重置该守卫
  - 触发条件：merge 产出 stats 后，存在 `costSource === 'openclaw'` 的 byModel 行 且 配置 `enabled !== false`

- [ ] **Step 1: 写失败测试**

```js
// tests/integration/stats-service/auto-rematch.test.js
import { describe, it, expect, afterEach } from 'vitest';
// 用 tests/helpers/tmp-workspace.js 的 copyFixtureDb() 准备 SQLite fixture，
// 注入 models.dev fetchImpl（fetchImpl 注入目前只在 models-dev.js 的 getModelsDevCatalog 层面，
// 自动钩子需接受 fetchImpl 透传——见实现注记），断言：
// 1. getStats() 首次返回后，自动 rematch 在后台把唯一命中模型写入 rules（source: models.dev）
// 2. 再次 getStats() 时该模型 costSource 变为 'models.dev'
// 3. catalog 不可用时 getStats 正常返回（不抛错、不阻塞）
```

实现注记：为可测试，`stats-service.js` 增加 `__setAutoRematchFetchImplForTests(fn)`（或让 `maybeAutoRematch` 接受依赖注入参数并挂到模块级可覆写变量，模式参照 `models-dev.js` 的 `activeFetchImpl`）。测试间用 `resetStatsServiceForTests()` 清理。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/stats-service/auto-rematch.test.js`
Expected: FAIL（钩子不存在）

- [ ] **Step 3: 实现**

`stats-service.js`：

```js
import { rematchObservedKeys } from './pricing-matching-service.js';

let inflightAutoRematch = null;
let autoRematchFetchImpl = null;

/** 测试辅助：注入 models.dev fetch 实现 */
export function __setAutoRematchFetchImplForTests(fn) {
  autoRematchFetchImpl = fn;
}

/**
 * merge 产出 stats 后的惰性自动匹配：对账面回退（未覆盖）的模型后台跑一次 rematch。
 * fire-and-forget；matched>0 时 invalidate 使下次 getStats 以新价 re-merge。
 * 每次 merge 周期至多触发一轮（inflight 守卫 + 触发后短期内新规则使 uncovered 收敛）。
 */
function maybeAutoRematch(stats, pricingConfig) {
  if (inflightAutoRematch) return;
  if (!pricingConfig || pricingConfig.enabled === false) return;
  const uncovered = Object.keys(stats?.byModel || {}).filter(
    (k) => stats.byModel[k].costSource === 'openclaw'
  );
  if (!uncovered.length) return;
  inflightAutoRematch = (async () => {
    try {
      const result = await rematchObservedKeys(uncovered, autoRematchFetchImpl ? { fetchImpl: autoRematchFetchImpl } : {});
      if (result.matched > 0) invalidateStatsCache();
    } catch (err) {
      console.warn('自动价格匹配失败:', err?.message || err);
    } finally {
      inflightAutoRematch = null;
    }
  })();
}
```

在 merge 产出 stats 的位置（`ensureLoaded`/`runRefresh` 内 `memory.stats` 赋值后）调用 `maybeAutoRematch(memory.stats, <本次使用的 pricingConfig>)`——Grep 定位 `mergeFileContributions` 调用点，把当时持有的 pricingConfig 一并传入。`resetStatsServiceForTests` 中重置 `inflightAutoRematch = null; autoRematchFetchImpl = null;`。

防循环：invalidate 后下次 merge 若仍有未覆盖模型会再触发一轮——正常收敛（每轮要么 matched 增长要么为 0 后不再 invalidate；catalog 不可用时 matched=0 不 invalidate）。rematchObservedKeys 内部已跳过有规则覆盖的键。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/integration/stats-service/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add stats-service.js tests/integration/stats-service/auto-rematch.test.js
git commit -m "feat(pricing): lazy auto-rematch hook after stats merge"
```

---

### Task 12: pricing 页 UI——确认队列、口径开关、source 徽标、409

**Files:**
- Modify: `pricing.html`（新增确认队列区 markup、头部口径开关、噪声后缀管理入口）
- Modify: `src/pricing.js`（v2 适配 + 新交互）
- Modify: `src/locales/zh-CN.js`、`src/locales/en-US.js`（新增 key 双语）
- Test: `tests/unit/frontend/pricing-v2-ui.test.js`（沿用 `tests/unit/frontend/models-dev-modal.test.js` 的 jsdom 模式与 fetch mock 方式——先读该文件复刻其 harness）

**Interfaces:**
- Consumes: Task 7 的 GET/PUT 契约；Task 10 的三个端点
- Produces：
  - `persistPricingConfigToServer()` 改为信封 `{ config, baseRevision: currentRevision }`；409 → `alert(t('pricing.conflictReload'))` 后 `loadData()`
  - 模块级 `currentRevision`（`loadData` 时从 GET 响应记录）
  - `renderCandidatesQueue(candidates)` / `resolveCandidatesBatch(resolutions)` / `rematchAll()`
  - `renderRulesTable()` 合并渲染 `rules`（徽标 手动/models.dev）与 `patterns`（徽标 高级规则），行内编辑/删除/开关保留

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/frontend/pricing-v2-ui.test.js（jsdom project）
// harness 复刻 models-dev-modal.test.js：构造 pricing.html 关键 DOM、mock fetch 路由表
describe('pricing v2 UI', () => {
  it('PUT sends envelope with baseRevision from last GET', async () => {
    // mock GET /api/pricing 返回 { version:'2.0', revision: 7, ... }
    // 触发一次行内编辑保存 → 断言 PUT body = { config, baseRevision: 7 }
  });

  it('409 conflict alerts and reloads', async () => {
    // PUT 返回 409 → 断言再次发起 GET /api/pricing
  });

  it('renders confirmation queue sorted and supports batch accept-unique', async () => {
    // mock GET /api/pricing/candidates 返回 3 条（2 条单候选、1 条多候选、1 条 dismissed）
    // 断言 dismissed 不显示；「采纳所有唯一候选」POST resolve 且 body.resolutions 长度为 2
  });

  it('ignoreProvider toggle persists matching.ignoreProvider', async () => {
    // 切换开关 → PUT 的 config.matching.ignoreProvider 翻转
  });

  it('rule rows show source badge (models.dev / 高级规则)', async () => {
    // GET 返回 rules 含 source:'models.dev' 与 patterns 各一条 → 断言徽标文案/i18n key 渲染
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/frontend/pricing-v2-ui.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`pricing.html`：在「已配置价格表」上方插入确认队列区（复用现有区块 class 与折叠交互）：

```html
<section id="candidates-section" class="card" hidden>
  <div class="card-header">
    <h2 data-i18n="pricing.candidatesTitle">待确认匹配</h2>
    <div class="actions">
      <button id="btn-accept-all-unique" class="btn btn-sm" data-i18n="pricing.acceptAllUnique">采纳所有唯一候选</button>
      <button id="btn-dismiss-all" class="btn btn-sm btn-secondary" data-i18n="pricing.dismissAll">忽略全部</button>
      <button id="btn-rematch" class="btn btn-sm btn-secondary" data-i18n="pricing.rematch">重新扫描匹配</button>
    </div>
  </div>
  <div id="candidates-list"></div>
</section>
```

头部全局 enabled 开关旁加：

```html
<label class="switch-label">
  <input type="checkbox" id="ignore-provider-toggle">
  <span data-i18n="pricing.ignoreProvider">忽略 Provider（官方价口径）</span>
</label>
<button id="btn-noise-suffixes" class="btn btn-sm btn-secondary" data-i18n="pricing.noiseSuffixes">噪声后缀</button>
```

`src/pricing.js` 关键改动（对照现有 `loadData` :573 / `persistPricingConfigToServer` :58 / 行内编辑三件套 :464-:490 改造）：

```js
let currentRevision = 0;

async function persistPricingConfigToServer(config) {
  const res = await fetch('/api/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, baseRevision: currentRevision }),
  });
  if (res.status === 409) {
    alert(t('pricing.conflictReload'));
    await loadData();
    return false;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('pricing.saveFailed'));
    return false;
  }
  const result = await res.json();
  currentRevision = result.revision;
  return true;
}
```

- `loadData()`：`GET /api/pricing` 响应记录 `currentRevision = body.revision ?? 0`；`validationErrors` 存在时页面顶部 banner 逐条展示；并行 `GET /api/pricing/candidates` 渲染队列（过滤 `dismissed`）
- 确认队列行：observedKey + 候选列表（每条显示 catalogKey、provider、score、价格四项）+ 行内按钮「采纳」(单候选直接采纳/多候选展开选择)「手动填价」（预填现有添加表单）「忽略」；`resolveCandidatesBatch(resolutions)` POST `/api/pricing/candidates/resolve` 后 `loadData()`
- 「采纳所有唯一候选」：对 `candidates.filter(c => !c.dismissed && c.candidates.length === 1)` 批量构造 accept resolutions
- 「重新扫描匹配」：POST `/api/pricing/rematch`，结果 `matched/queued/catalogUnavailable` 用 `alert` 或内联提示展示（i18n）
- ignoreProvider toggle：读写 `config.matching.ignoreProvider` 并 persist；噪声后缀按钮：prompt/小弹窗编辑逗号分隔列表写回 `config.matching.noiseSuffixes`（沿用页面现有简易交互，不引新组件）
- 规则表：`rules` 与 `patterns` 合并渲染，`source === 'models.dev'` 显示同步徽标、patterns 行显示「高级规则」徽标；编辑 `source:'models.dev'` 行保存时把 `source` 改为 `'manual'`；删除 `syncedAt`
- models.dev 手动搜索弹窗保留不动（兜底入口）
- `attachCustomRule` 在 server.js 仍用旧 `findMatchingPricing`（Task 12 不改；见 Task 14 清理项说明）——**更正**：server.js 的 `attachCustomRule` 需要能看到 v2 规则，本任务一并改为基于 `resolvePricingRule`：

```js
function attachCustomRule(row, config) {
  const hit = resolvePricingRule(row.provider, row.model, config);
  const rule = hit?.rule ?? null;
  const custom = rule ? {
    input: rule.input, output: rule.output,
    cacheRead: rule.cacheRead ?? null, cacheWrite: rule.cacheWrite ?? null,
    enabled: rule.enabled !== false,
  } : null;
  return { key: `${row.provider}/${row.model}`, provider: row.provider, model: row.model,
    displayName: row.displayName, cost: row.cost, contextWindow: row.contextWindow,
    maxTokens: row.maxTokens, custom };
}
```

调用处（`/api/openclaw/models`）从 `pricingConfig.pricing || {}` 改为直接传完整 `pricingConfig`。

- i18n 新增 key（双语，示例）：`pricing.candidatesTitle`、`pricing.acceptAllUnique`、`pricing.dismissAll`、`pricing.rematch`、`pricing.ignoreProvider`、`pricing.noiseSuffixes`、`pricing.conflictReload`（“配置已被其他入口修改，已重新加载 / Pricing was modified elsewhere; reloaded.”）、`pricing.sourceManual`/`pricing.sourceModelsDev`/`pricing.sourcePattern`、`pricing.validationErrorsTitle`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/frontend/`
Expected: PASS

- [ ] **Step 5: 构建并人工冒烟**

Run: `npm run build`（若 package.json 中为其他构建脚本名以实际为准）后 `node server.js`，浏览器打开 `/pricing.html` 走一遍：确认队列出现 → 批量采纳 → 规则表徽标 → 口径开关切换后 stats 页金额变化。此步可由主会话 review 时执行。

- [ ] **Step 6: Commit**

```bash
git add pricing.html src/pricing.js src/locales/ server.js tests/unit/frontend/pricing-v2-ui.test.js
git commit -m "feat(pricing-ui): candidates queue, pricing mode toggle, source badges, conflict handling"
```

---

### Task 13: 统计页 UI——canonical 分组、来源徽标、成本构成

**Files:**
- Modify: `index.html`、`src/main.js`、`src/charts.js`
- Modify: `src/locales/zh-CN.js`、`src/locales/en-US.js`
- Test: `tests/unit/frontend/stats-canonical-view.test.js`

**Interfaces:**
- Consumes: Task 6 merge 输出（`byModel[].canonical/costSource/costBreakdown`、`summary.costBySource`）
- Produces：
  - byModel 表格行尾新增来源徽标（`costSource` → i18n 文案）；`canonical !== model` 时在模型名旁小字显示 canonical
  - 「按 canonical 分组」toggle：展示层把同 canonical 的行聚合（tokens/cost 求和），不动数据结构
  - 成本构成区块：基于 `summary.costBySource` 的占比条/甜甜圈（沿用 `src/charts.js` 现有图表工具，若无合适工具则用纯 CSS 占比条，与现有风格一致）

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/frontend/stats-canonical-view.test.js（jsdom）
describe('stats canonical view', () => {
  it('groups byModel rows by canonical when toggle is on', () => {
    // 构造含 nvidia/deepseek-ai/deepseek-v4-flash 与 bohe/deepseek-v4-flash
    // （canonical 均为 deepseek-v4-flash）的 stats，渲染分组视图 → 断言合并为一行且 cost 求和
  });

  it('renders cost source badge per row', () => {
    // costSource 'models.dev' 行出现对应徽标文本
  });

  it('renders cost-by-source breakdown from summary.costBySource', () => {
    // summary.costBySource = { manual: 2, 'models.dev': 6, pattern: 0, openclaw: 2 }
    // 断言占比条渲染且 openclaw 部分有「账面价」标注
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/frontend/stats-canonical-view.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main.js` 中找到 byModel 渲染处（Grep `byModel`），：

- 行模板增加徽标：`<span class="badge badge-source badge-${costSource}">${t('pricing.source' + ...)}</span>`；canonical 小字 `<span class="canonical-name">${canonical}</span>`（仅当 `canonical && canonical !== model`）
- 新增 `groupByCanonical` 状态 + toggle 按钮；开启时用：

```js
function groupModelsByCanonical(byModel) {
  const groups = new Map();
  for (const [key, row] of Object.entries(byModel)) {
    const gk = row.canonical || row.model;
    if (!groups.has(gk)) {
      groups.set(gk, { ...row, costBreakdown: { ...row.costBreakdown }, members: [key] });
    } else {
      const g = groups.get(gk);
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'totalCost', 'requests']) g[f] += row[f];
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) g.costBreakdown[f] += row.costBreakdown[f];
      g.members.push(key);
    }
  }
  return [...groups.values()].sort((a, b) => b.totalCost - a.totalCost);
}
```

- 成本构成区块读 `stats.summary.costBySource`，过滤 0 值，渲染占比条；i18n key：`stats.groupByCanonical`、`stats.costBySourceTitle`、`pricing.sourceOpenclaw`（账面价）等

`index.html` 增加对应容器（沿用现有 section/card class）。`src/charts.js` 仅在复用现有工具时修改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/frontend/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.html src/main.js src/charts.js src/locales/ tests/unit/frontend/stats-canonical-view.test.js
git commit -m "feat(stats-ui): canonical grouping, cost source badges and breakdown"
```

---

### Task 14: 迁移等价性测试 + 文档与清理

**Files:**
- Test: `tests/integration/pricing/migration-equivalence.test.js`（新建）
- Modify: `README.md`、`README_EN.md`（价格章节重写：v2 schema、口径开关、自动匹配与确认队列、路径变更）
- Modify: `pricing.json.example`（v2 示例）、`pricing.html` 帮助文案（`models.json` → `openclaw.json` 的 `models.providers`）
- Modify: `AGENTS.md`（更新价格机制相关条目：v2 schema、路径解析链、source 透传、新端点、指纹语义）
- Delete: 仓库根 `pricing.json`（gitignored 遗留物；先 Grep 确认无代码引用）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 迁移等价性测试**

```js
// tests/integration/pricing/migration-equivalence.test.js
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
});
```

（wildcard `*mimo-v2.5` 迁移后在 `patterns` 区以相同声明顺序匹配，语义不变；`*deepseek-v4-flash*` 对 `nvidia/deepseek-ai/deepseek-v4-flash` 的命中在 v1/v2 同为 wildcard 整串匹配。）

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run tests/integration/pricing/migration-equivalence.test.js`
Expected: PASS

- [ ] **Step 3: 文档与清理**

- `pricing.json.example` 替换为 v2 示例（含 rules/aliases/patterns/matching 注释）
- README.md / README_EN.md 价格章节同步重写：配置路径（`$OPENCLAW_CONFIG_DIR/openclaw-usage-pricing.json`）、双口径、自动匹配/确认队列、v1 自动迁移说明
- `pricing.html` 帮助 tooltip 中 `agents/main/agent/models.json` 改为 `openclaw.json` 的 `models.providers`
- `AGENTS.md`：更新「自定义单价存放」「价格参考 API」「MCP 缓存失效」条目为 v2 事实；删除关于 legacy 硬编码路径陷阱的条目（已修复），改为 `OPENCLAW_USAGE_PRICING_PATH` 覆盖说明
- `pricing.json`（根目录）：Grep 全仓确认无引用后删除本地文件（gitignored，不影响仓库）
- `getPricingVersion` 死代码若 Task 1 未删，此处删除并 Grep 确认

- [ ] **Step 4: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A README.md README_EN.md pricing.json.example pricing.html AGENTS.md tests/integration/pricing/migration-equivalence.test.js
git commit -m "docs(pricing): v2 mechanism docs, examples and cleanup"
```

---

### Task 15: 收尾——全量回归与 Post-Implementation Sync Audit

- [ ] **Step 1: 全量回归**

Run: `npm test && npm run build`
Expected: 全部通过

- [ ] **Step 2: 人工冒烟（主会话 review 执行）**

`node server.js` 起服务，pricing 页：v1 配置自动迁移提示、确认队列批量采纳、口径开关切换后统计页金额变化、409 冲突提示。MCP 侧 `get_pricing_config` / `update_pricing_config`（带/不带 baseRevision）各调一次。

- [ ] **Step 3: Sync Audit 回写**

对照 `docs/superpowers/specs/2026-09-04-pricing-mechanism-redesign-design.md` 逐节核对实现，把偏差（已知候选：`STATS_SHAPE_VERSION` 升 4；惰性匹配实际落在 merge 后异步钩子而非 merge 内；`attachCustomRule` 改签名）回写 spec，并在被取代的旧 spec 头部标注 `已被 2026-09-04 价格机制重构取代` 的范围说明。提交：

```bash
git add docs/superpowers/specs/ AGENTS.md
git commit -m "docs(specs): sync pricing redesign spec with implementation"
```

---

## Self-Review 记录

- **Spec 覆盖**：匹配管线（T5）✓、归一化（T4）✓、schema v2/迁移/读时校验（T1）✓、路径统一（T2）✓、乐观锁/失效治理（T3、T7）✓、catalog 匹配器（T8）✓、候选队列与批量（T9、T10、T12）✓、惰性+批量双入口（T10、T11）✓、成本透传（T6、T13）✓、错误处理（T1 校验回退、T7 validationErrors、T9 catalogUnavailable）✓、文档清理（T14）✓、迁移等价性（T14）✓。MCP candidates 工具为非目标 ✓。
- **已知占位说明**：T7/T10/T11/T12 的测试骨架中含「实现前补全」注释的用例，是因为请求 harness 需复制自 `tests/integration/server/api.test.js`、DOM harness 复制自 `tests/unit/frontend/models-dev-modal.test.js`——实施第一步是读这两个文件复刻模式，属有意指引而非占位。
- **类型一致性**：`resolvePricingRule(provider, model, config)` 签名在 T5/T9 一致；`savePricingConfig(config, {baseRevision})` 在 T3/T9 一致（T9 内部保存不传 baseRevision，允许强制——已在 T3 注明）；`CandidateEntry` 形状在 T9/T10/spec 一致；`costSource` 取值集合 `'manual'|'models.dev'|'pattern'|'openclaw'` 在 T5/T6/T13 一致。
