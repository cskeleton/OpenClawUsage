# OpenClawUsage 完整测试方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `OpenClawUsage` 建立基于真实脱敏样本 + 合成边界数据的完整测试体系（Vitest），覆盖后端核心逻辑、Express API、MCP 工具与前端纯逻辑模块，为后续 GitHub Actions CI 预留兼容。

**Architecture:** 采用 Vitest 作为统一框架，`projects` 分 Node + jsdom 两套 env；测试分 `unit/`（纯函数）与 `integration/`（走 tmpdir + 真实 fs + env 注入）；通过一次性 `scripts/extract-test-fixtures.js` 从本地 OpenClaw 抽取脱敏样本入库，合成数据仅补真实样本覆盖不到的边界。

**Tech Stack:** Node.js 20+ (ESM)、Vitest、@vitest/coverage-v8、supertest、jsdom；被测模块仍为纯 ESM JavaScript。

**Spec reference:** `docs/superpowers/specs/2026-04-20-complete-testing-strategy-design.md`

---

## Phase 1 — 测试基建与数据基线

### Task 1：安装依赖 + Vitest 配置

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `tests/setup.js`

- [ ] **Step 1：安装 devDependencies**

```bash
npm install --save-dev vitest @vitest/coverage-v8 supertest jsdom
```

- [ ] **Step 2：在 `package.json` 的 `scripts` 里追加测试命令**

```json
{
  "scripts": {
    "dev": "concurrently \"node server.js\" \"vite\"",
    "server": "node server.js",
    "mcp": "node mcp-server.js",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 3：创建 `vitest.config.js`（Node + jsdom 双 project）**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'aggregator.js',
        'pricing.js',
        'openclaw-config.js',
        'stats-service.js',
        'server.js',
        'mcp-server.js',
        'src/util.js',
        'src/i18n.js',
        'src/theme.js',
        'src/data-filter.js',
      ],
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
          exclude: ['tests/unit/frontend/**'],
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/unit/frontend/**/*.test.js'],
        },
      },
    ],
  },
});
```

- [ ] **Step 4：创建 `tests/setup.js`（全局清理 env）**

```js
import { afterEach, beforeEach } from 'vitest';

const ENV_KEYS = ['OPENCLAW_CONFIG_DIR', 'OPENCLAW_DIR'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
```

- [ ] **Step 5：运行一次以验证框架可启动（尚无测试，应该成功无用例）**

Run: `npm test`
Expected: `No test files found` 或 `0 tests passed`，框架装得对即可。

- [ ] **Step 6：提交**

```bash
git add package.json package-lock.json vitest.config.js tests/setup.js
git commit -m "chore(test): bootstrap vitest with node + jsdom projects"
```

---

### Task 2：测试 helper — `tmp-workspace` 与 `fixture-loader`

**Files:**
- Create: `tests/helpers/tmp-workspace.js`
- Create: `tests/helpers/fixture-loader.js`
- Create: `tests/unit/helpers/tmp-workspace.test.js`

- [ ] **Step 1：先写 helper 的测试**

Path: `tests/unit/helpers/tmp-workspace.test.js`

```js
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

describe('createTmpWorkspace', () => {
  it('creates sessions & workspace directories and injects env vars', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    expect(existsSync(ws.sessionsDir)).toBe(true);
    expect(existsSync(ws.agentDir)).toBe(true);
    expect(process.env.OPENCLAW_CONFIG_DIR).toBe(ws.configDir);
    expect(process.env.OPENCLAW_DIR).toBe(ws.workspaceDir);
  });

  it('writeSession writes files to sessions dir with given name', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    ws.writeSession('a.jsonl', '{"type":"message"}\n');
    expect(readFileSync(join(ws.sessionsDir, 'a.jsonl'), 'utf-8')).toBe('{"type":"message"}\n');
  });

  it('writeModelsJson writes models.json under agents/main/agent/', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    ws.writeModelsJson({ providers: {} });
    const path = join(ws.agentDir, 'models.json');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ providers: {} });
  });

  it('writePricingConfig writes openclaw-usage-pricing.json under workspace', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const cfg = { version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z', pricing: {} };
    ws.writePricingConfig(cfg);
    const path = join(ws.workspaceDir, 'openclaw-usage-pricing.json');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(cfg);
  });

  it('cleanup removes the workspace', async () => {
    const ws = await createTmpWorkspace();
    const root = ws.root;
    expect(existsSync(root)).toBe(true);
    await ws.cleanup();
    expect(existsSync(root)).toBe(false);
  });
});
```

- [ ] **Step 2：运行测试，确认失败**

Run: `npm test -- tests/unit/helpers/tmp-workspace.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3：实现 `tests/helpers/tmp-workspace.js`**

```js
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 创建一次性测试工作区：
 *   <root>/config/agents/main/sessions/
 *   <root>/config/agents/main/agent/
 *   <root>/workspace/
 * 并注入 OPENCLAW_CONFIG_DIR / OPENCLAW_DIR 环境变量。
 */
export async function createTmpWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-usage-test-'));
  const configDir = join(root, 'config');
  const agentDir = join(configDir, 'agents', 'main', 'agent');
  const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
  const workspaceDir = join(root, 'workspace');

  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  process.env.OPENCLAW_CONFIG_DIR = configDir;
  process.env.OPENCLAW_DIR = workspaceDir;

  return {
    root,
    configDir,
    agentDir,
    sessionsDir,
    workspaceDir,
    async writeSession(name, content) {
      await writeFile(join(sessionsDir, name), content, 'utf-8');
    },
    async writeModelsJson(json) {
      await writeFile(join(agentDir, 'models.json'), JSON.stringify(json, null, 2), 'utf-8');
    },
    async writePricingConfig(json) {
      await writeFile(
        join(workspaceDir, 'openclaw-usage-pricing.json'),
        JSON.stringify(json, null, 2),
        'utf-8'
      );
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
```

由于测试用的是同步读/写断言，把 `writeSession/writeModelsJson/writePricingConfig` 改为 **同步**：

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export async function createTmpWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-usage-test-'));
  const configDir = join(root, 'config');
  const agentDir = join(configDir, 'agents', 'main', 'agent');
  const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
  const workspaceDir = join(root, 'workspace');

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  process.env.OPENCLAW_CONFIG_DIR = configDir;
  process.env.OPENCLAW_DIR = workspaceDir;

  return {
    root,
    configDir,
    agentDir,
    sessionsDir,
    workspaceDir,
    writeSession(name, content) {
      writeFileSync(join(sessionsDir, name), content, 'utf-8');
    },
    writeModelsJson(json) {
      writeFileSync(join(agentDir, 'models.json'), JSON.stringify(json, null, 2), 'utf-8');
    },
    writePricingConfig(json) {
      writeFileSync(
        join(workspaceDir, 'openclaw-usage-pricing.json'),
        JSON.stringify(json, null, 2),
        'utf-8'
      );
    },
    async cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4：创建 `tests/helpers/fixture-loader.js`**

```js
import { readFileSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, '..', 'fixtures');

export function fixturePath(...parts) {
  return join(FIXTURES_ROOT, ...parts);
}

export function readFixtureJson(...parts) {
  return JSON.parse(readFileSync(fixturePath(...parts), 'utf-8'));
}

export function readFixtureText(...parts) {
  return readFileSync(fixturePath(...parts), 'utf-8');
}

/**
 * 把某个 fixtures 子目录下的全部文件拷贝进目标目录。
 */
export function copyFixtureDir(sourceSubdir, targetDir) {
  const src = fixturePath(sourceSubdir);
  if (!existsSync(src)) return 0;
  let n = 0;
  for (const name of readdirSync(src)) {
    copyFileSync(join(src, name), join(targetDir, name));
    n++;
  }
  return n;
}
```

- [ ] **Step 5：再跑测试，确认通过**

Run: `npm test -- tests/unit/helpers/tmp-workspace.test.js`
Expected: 5/5 PASS

- [ ] **Step 6：提交**

```bash
git add tests/helpers/ tests/unit/helpers/
git commit -m "test: add tmp-workspace and fixture-loader helpers"
```

---

### Task 3：编写真实样本抽取 / 脱敏脚本

**Files:**
- Create: `scripts/extract-test-fixtures.js`
- Create: `tests/fixtures/.gitkeep`

- [ ] **Step 1：先创建 fixtures 目录骨架并版本化**

```bash
mkdir -p tests/fixtures/sessions-real tests/fixtures/sessions-synth tests/fixtures/models tests/fixtures/pricing
touch tests/fixtures/sessions-real/.gitkeep tests/fixtures/sessions-synth/.gitkeep tests/fixtures/models/.gitkeep tests/fixtures/pricing/.gitkeep
```

- [ ] **Step 2：创建 `scripts/extract-test-fixtures.js`**

```js
#!/usr/bin/env node
/**
 * 一次性工具：从本机 OpenClaw 抓取会话样本 & models.json，脱敏后落入 tests/fixtures/。
 * 用法：
 *   node scripts/extract-test-fixtures.js [--limit 8] [--dry-run]
 * 注意：此脚本只在开发者本机运行，不在 CI / 测试运行时被调用。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const idx = args.indexOf(name);
  if (idx === -1) return def;
  const v = args[idx + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const LIMIT = Number(getFlag('--limit', 8));
const DRY = !!getFlag('--dry-run', false);

const CONFIG_DIR = process.env.OPENCLAW_CONFIG_DIR || join(homedir(), '.openclaw');
const SESSIONS_SRC = join(CONFIG_DIR, 'agents', 'main', 'sessions');
const MODELS_SRC = join(CONFIG_DIR, 'agents', 'main', 'agent', 'models.json');
const SESSIONS_DST = join(REPO_ROOT, 'tests', 'fixtures', 'sessions-real');
const MODELS_DST = join(REPO_ROOT, 'tests', 'fixtures', 'models', 'models.real.json');
const MANIFEST = join(REPO_ROOT, 'tests', 'fixtures', 'MANIFEST.json');

const REDACTED_TEXT = '<REDACTED_TEXT>';
const REDACTED_PATH = '<REDACTED_PATH>';

/**
 * 脱敏消息对象：只保留统计相关字段；消息内容、工具参数、路径替换为占位符。
 */
function redactMessage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.type !== 'message') return obj; // 非 message 行原样保留（统计时也不处理）

  const msg = obj.message;
  if (!msg) return obj;

  const redacted = {
    ...obj,
    message: {
      role: msg.role,
      provider: msg.provider,
      model: msg.model,
      usage: msg.usage,
      content: typeof msg.content === 'string' ? REDACTED_TEXT : undefined,
    },
  };

  // 删除潜在敏感字段
  return redacted;
}

function redactJsonlLine(line) {
  if (!line.trim()) return line;
  try {
    const parsed = JSON.parse(line);
    return JSON.stringify(redactMessage(parsed));
  } catch {
    return ''; // 脱敏阶段遇到坏行直接丢弃
  }
}

function redactModelsJson(raw) {
  // 深拷贝后剔除凭据字段
  const out = JSON.parse(JSON.stringify(raw));
  const providers = out.providers || out.models?.providers;
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers)) {
      if (!p || typeof p !== 'object') continue;
      for (const k of ['apiKey', 'apiSecret', 'token', 'authorization', 'headers']) {
        delete p[k];
      }
      if (p.baseUrl) p.baseUrl = 'https://example.invalid';
      if (p.endpoint) p.endpoint = 'https://example.invalid';
    }
  }
  return out;
}

function pickRepresentativeSessions(files) {
  // 目标：active / reset / deleted / checkpoint 各留 1-3 个；总数不超过 LIMIT
  const buckets = { active: [], reset: [], deleted: [], checkpoint: [] };
  for (const f of files) {
    if (f.includes('.checkpoint.')) buckets.checkpoint.push(f);
    else if (f.includes('.jsonl.reset.')) buckets.reset.push(f);
    else if (f.includes('.jsonl.deleted.')) buckets.deleted.push(f);
    else if (f.endsWith('.jsonl')) buckets.active.push(f);
  }
  const result = [
    ...buckets.active.slice(0, 3),
    ...buckets.reset.slice(0, 2),
    ...buckets.deleted.slice(0, 1),
    ...buckets.checkpoint.slice(0, 1),
  ];
  return result.slice(0, LIMIT);
}

function main() {
  if (!existsSync(SESSIONS_SRC)) {
    console.error(`未找到 sessions 目录：${SESSIONS_SRC}`);
    process.exit(1);
  }

  const files = readdirSync(SESSIONS_SRC);
  const picked = pickRepresentativeSessions(files);
  const manifest = { extractedAt: new Date().toISOString(), sessions: [] };

  if (!DRY) {
    rmSync(SESSIONS_DST, { recursive: true, force: true });
    mkdirSync(SESSIONS_DST, { recursive: true });
  }

  for (const name of picked) {
    const src = join(SESSIONS_SRC, name);
    const raw = readFileSync(src, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const redacted = lines.map(redactJsonlLine).filter(Boolean).join('\n') + '\n';
    const dst = join(SESSIONS_DST, name);
    if (!DRY) writeFileSync(dst, redacted, 'utf-8');
    manifest.sessions.push({ name, bytes: redacted.length, lineCount: lines.length });
  }

  if (existsSync(MODELS_SRC)) {
    const raw = JSON.parse(readFileSync(MODELS_SRC, 'utf-8'));
    const redacted = redactModelsJson(raw);
    if (!DRY) {
      mkdirSync(dirname(MODELS_DST), { recursive: true });
      writeFileSync(MODELS_DST, JSON.stringify(redacted, null, 2), 'utf-8');
    }
    manifest.modelsJson = { source: MODELS_SRC, redactedKeys: ['apiKey', 'apiSecret', 'token', 'authorization', 'headers'] };
  }

  if (!DRY) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(DRY ? '[dry-run] ' : '' + `抽取了 ${picked.length} 个 sessions，models.json: ${existsSync(MODELS_SRC)}`);
}

main();
```

- [ ] **Step 3：dry-run 验证脚本能跑**

Run: `node scripts/extract-test-fixtures.js --dry-run`
Expected: 打印「抽取了 N 个 sessions，models.json: true」；fixtures 目录不变。

- [ ] **Step 4：提交脚本**

```bash
git add scripts/extract-test-fixtures.js tests/fixtures/
git commit -m "chore(test): add fixture extraction & redaction script"
```

---

### Task 4：运行脚本、入库真实脱敏样本

**Files:**
- Modify: `tests/fixtures/sessions-real/*` (由脚本生成)
- Modify: `tests/fixtures/models/models.real.json` (由脚本生成)
- Modify: `tests/fixtures/MANIFEST.json`
- Create: `tests/fixtures/sessions-synth/edge-matrix.jsonl`
- Create: `tests/fixtures/pricing/wildcard-and-regex.json`

- [ ] **Step 1：正式运行抽取脚本**

Run: `node scripts/extract-test-fixtures.js --limit 8`
Expected: `tests/fixtures/sessions-real/` 下出现 ≥ 3 个 `.jsonl` / `.reset.*` / `.deleted.*` / `.checkpoint.*` 文件；`tests/fixtures/models/models.real.json` 生成；`tests/fixtures/MANIFEST.json` 生成。

- [ ] **Step 2：人工抽检**（只检查，不改代码）

```bash
head -n 3 tests/fixtures/sessions-real/*.jsonl | head -n 30
grep -E 'apiKey|apiSecret|authorization' tests/fixtures/models/models.real.json || echo "clean"
```

Expected: content 字段显示 `<REDACTED_TEXT>`；凭据字段检查结果为 `clean`。

- [ ] **Step 3：创建定向合成样本（边界 session）**

Path: `tests/fixtures/sessions-synth/edge-matrix.jsonl`

```jsonl
{"type":"message","timestamp":"2026-04-15T10:00:00.000Z","message":{"role":"assistant","provider":"openai","model":"gpt-4o","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"input":0.001,"output":0.002,"cacheRead":0,"cacheWrite":0,"total":0.003}}}}
{"type":"message","timestamp":"2026-04-15T10:01:00.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4","usage":{"input":200,"output":100,"cacheRead":500,"cacheWrite":1000,"totalTokens":1800,"cost":{"input":0.003,"output":0.004,"cacheRead":0.0001,"cacheWrite":0.0005,"total":0.0076}}}}
{"type":"message","timestamp":"2026-04-16T09:00:00.000Z","message":{"role":"assistant","provider":"openclaw","model":"gateway-internal","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}
not-a-json-line
{"type":"message","timestamp":"2026-04-16T09:01:00.000Z","message":{"role":"assistant","provider":"openai","model":"gpt-4o","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.0001,"output":0.0001,"cacheRead":0,"cacheWrite":0,"total":0.0002}}}}
```

- [ ] **Step 4：创建 pricing 合成配置样本**

Path: `tests/fixtures/pricing/wildcard-and-regex.json`

```json
{
  "version": "1.0",
  "enabled": true,
  "updated": "2026-04-20T00:00:00.000Z",
  "pricing": {
    "openai/gpt-4o": { "input": 2.5, "output": 10, "cacheRead": null, "cacheWrite": null },
    "anthropic/claude-*": {
      "matchType": "wildcard",
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "/^minimax\\/.*$/": {
      "matchType": "regex",
      "input": 1,
      "output": 1
    },
    "disabled/one": {
      "enabled": false,
      "input": 99,
      "output": 99
    }
  }
}
```

- [ ] **Step 5：提交脱敏样本**

```bash
git add tests/fixtures/
git commit -m "test(fixtures): add redacted real samples and synthetic edge data"
```

---

## Phase 2 — 核心纯函数单元测试

### Task 5：`pricing.wildcardToRegex` + `parseRegexEntry`

**Files:**
- Create: `tests/unit/pricing/wildcard-and-regex.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { wildcardToRegex, parseRegexEntry } from '../../../pricing.js';

describe('wildcardToRegex', () => {
  it('matches simple prefix with *', () => {
    const re = wildcardToRegex('anthropic/claude-*');
    expect(re.test('anthropic/claude-sonnet-4')).toBe(true);
    expect(re.test('anthropic/claude-')).toBe(true);
    expect(re.test('openai/gpt-4o')).toBe(false);
  });

  it('? matches exactly one character', () => {
    const re = wildcardToRegex('openai/gpt-?');
    expect(re.test('openai/gpt-4')).toBe(true);
    expect(re.test('openai/gpt-40')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    const re = wildcardToRegex('ns/a+b.c');
    expect(re.test('ns/a+b.c')).toBe(true);
    expect(re.test('ns/axbxc')).toBe(false);
  });

  it('throws on non-string input', () => {
    expect(() => wildcardToRegex(42)).toThrow(TypeError);
  });
});

describe('parseRegexEntry', () => {
  it('parses /pattern/flags form', () => {
    const re = parseRegexEntry('/^minimax\\/.*$/i');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('MINIMAX/abc')).toBe(true);
  });

  it('returns null when not starting with slash', () => {
    expect(parseRegexEntry('plain')).toBeNull();
  });

  it('returns null for malformed regex', () => {
    expect(parseRegexEntry('/(/')).toBeNull();
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/unit/pricing/wildcard-and-regex.test.js`
Expected: 7/7 PASS（`wildcardToRegex` / `parseRegexEntry` 已在 `pricing.js` 导出）

- [ ] **Step 3：提交**

```bash
git add tests/unit/pricing/wildcard-and-regex.test.js
git commit -m "test(pricing): cover wildcardToRegex and parseRegexEntry"
```

---

### Task 6：`pricing.validatePricingConfig`

**Files:**
- Create: `tests/unit/pricing/validate.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { validatePricingConfig } from '../../../pricing.js';

const base = (extra = {}) => ({
  version: '1.0',
  updated: '2026-04-20T00:00:00.000Z',
  pricing: {},
  ...extra,
});

describe('validatePricingConfig', () => {
  it('accepts a minimally valid config', () => {
    expect(() => validatePricingConfig(base())).not.toThrow();
  });

  it('rejects non-object root', () => {
    expect(() => validatePricingConfig(null)).toThrow(/对象/);
  });

  it('rejects missing version', () => {
    expect(() => validatePricingConfig({ pricing: {} })).toThrow(/version/);
  });

  it('rejects non-boolean enabled', () => {
    expect(() => validatePricingConfig(base({ enabled: 'yes' }))).toThrow(/enabled/);
  });

  it('requires exact key to contain "/"', () => {
    const cfg = base({
      pricing: { 'openaignpt-4o': { input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/provider\/model/);
  });

  it('rejects wildcard type without * or ?', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { matchType: 'wildcard', input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/wildcard/);
  });

  it('rejects negative price', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { input: -1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/非负/);
  });

  it('rejects invalid regex key', () => {
    const cfg = base({
      pricing: { '/(/': { matchType: 'regex', input: 1, output: 1 } },
    });
    expect(() => validatePricingConfig(cfg)).toThrow(/正则/);
  });

  it('accepts cacheRead/cacheWrite as null', () => {
    const cfg = base({
      pricing: { 'openai/gpt-4o': { input: 1, output: 1, cacheRead: null, cacheWrite: null } },
    });
    expect(() => validatePricingConfig(cfg)).not.toThrow();
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/unit/pricing/validate.test.js`
Expected: 9/9 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/pricing/validate.test.js
git commit -m "test(pricing): cover validatePricingConfig branches"
```

---

### Task 7：`pricing.findMatchingPricing`（含优先级）

**Files:**
- Create: `tests/unit/pricing/find-matching.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { findMatchingPricing } from '../../../pricing.js';

const entry = (input, output, extra = {}) => ({ input, output, ...extra });

describe('findMatchingPricing priority', () => {
  it('returns exact match first', () => {
    const map = {
      'openai/gpt-4o': entry(2.5, 10),
      'openai/*': { ...entry(99, 99), matchType: 'wildcard' },
    };
    expect(findMatchingPricing('openai/gpt-4o', map).input).toBe(2.5);
  });

  it('falls back to wildcard when exact missing', () => {
    const map = {
      'anthropic/claude-*': { ...entry(3, 15), matchType: 'wildcard' },
    };
    const hit = findMatchingPricing('anthropic/claude-sonnet-4', map);
    expect(hit.input).toBe(3);
  });

  it('uses regex when wildcard and exact both miss', () => {
    const map = {
      '/^minimax\\/.*$/': { ...entry(1, 1), matchType: 'regex' },
    };
    const hit = findMatchingPricing('minimax/abab6-chat', map);
    expect(hit.input).toBe(1);
  });

  it('skips disabled entries even if they match', () => {
    const map = {
      'openai/gpt-4o': { ...entry(99, 99), enabled: false },
      'openai/*': { ...entry(2.5, 10), matchType: 'wildcard' },
    };
    expect(findMatchingPricing('openai/gpt-4o', map).input).toBe(2.5);
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingPricing('weird/model', { 'a/b': entry(1, 1) })).toBeNull();
  });

  it('returns null for empty map', () => {
    expect(findMatchingPricing('x/y', {})).toBeNull();
    expect(findMatchingPricing('x/y', null)).toBeNull();
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/unit/pricing/find-matching.test.js`
Expected: 6/6 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/pricing/find-matching.test.js
git commit -m "test(pricing): cover findMatchingPricing priority rules"
```

---

### Task 8：`pricing.calculateCostFromUsage`

**Files:**
- Create: `tests/unit/pricing/calculate-cost.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { calculateCostFromUsage } from '../../../pricing.js';

const usage = {
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 1_000_000,
  totalTokens: 4_000_000,
  cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
};

describe('calculateCostFromUsage', () => {
  it('falls back to OpenClaw cost when pricingConfig is null', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', null);
    expect(r.total).toBe(100);
    expect(r.source).toBe('openclaw');
  });

  it('falls back when enabled=false', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      enabled: false,
      pricing: { 'openai/gpt-4o': { input: 1, output: 1 } },
    });
    expect(r.source).toBe('openclaw');
  });

  it('falls back when model not configured', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0', pricing: { 'other/m': { input: 1, output: 1 } },
    });
    expect(r.source).toBe('openclaw');
  });

  it('applies $/M rates when configured', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 5 } },
    });
    expect(r.input).toBeCloseTo(2);
    expect(r.output).toBeCloseTo(4);
    expect(r.cacheRead).toBeCloseTo(0.5);
    expect(r.cacheWrite).toBeCloseTo(5);
    expect(r.total).toBeCloseTo(11.5);
    expect(r.source).toBe('custom');
  });

  it('falls back cache price to input/output when null', () => {
    const r = calculateCostFromUsage(usage, 'openai', 'gpt-4o', {
      version: '1.0',
      pricing: { 'openai/gpt-4o': { input: 2, output: 4, cacheRead: null, cacheWrite: null } },
    });
    expect(r.cacheRead).toBeCloseTo(2);  // 按 input 单价
    expect(r.cacheWrite).toBeCloseTo(4); // 按 output 单价
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/unit/pricing/calculate-cost.test.js`
Expected: 5/5 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/pricing/calculate-cost.test.js
git commit -m "test(pricing): cover calculateCostFromUsage including cache fallback"
```

---

### Task 9：`aggregator.normalizeArchivedAt` + `parseSessionFile`

**Files:**
- Create: `tests/unit/aggregator/parse-session-file.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { normalizeArchivedAt, parseSessionFile } from '../../../aggregator.js';

describe('normalizeArchivedAt', () => {
  it('restores colons in the time portion only', () => {
    expect(normalizeArchivedAt('2026-04-15T13-05-48.786Z')).toBe('2026-04-15T13:05:48.786Z');
  });

  it('keeps date portion intact', () => {
    expect(normalizeArchivedAt('2026-04-15T00-00-00.000Z').startsWith('2026-04-15T')).toBe(true);
  });
});

describe('parseSessionFile', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef';

  it('parses active session', () => {
    expect(parseSessionFile(`${UUID}.jsonl`)).toEqual({
      sessionId: UUID, status: 'active', archivedAt: null, filename: `${UUID}.jsonl`,
    });
  });

  it('parses reset session with archived timestamp', () => {
    const r = parseSessionFile(`${UUID}.jsonl.reset.2026-04-15T13-05-48.786Z`);
    expect(r.status).toBe('reset');
    expect(r.archivedAt).toBe('2026-04-15T13:05:48.786Z');
  });

  it('parses deleted session', () => {
    const r = parseSessionFile(`${UUID}.jsonl.deleted.2026-04-15T13-05-48.786Z`);
    expect(r.status).toBe('deleted');
  });

  it('skips checkpoint variants', () => {
    expect(parseSessionFile(`${UUID}.checkpoint.abc.jsonl`)).toBeNull();
  });

  it('skips non-session files', () => {
    expect(parseSessionFile('sessions.json')).toBeNull();
    expect(parseSessionFile('probe-xyz.jsonl')).toBeNull();
    expect(parseSessionFile('readme.txt')).toBeNull();
  });

  it('skips filenames without UUID prefix', () => {
    expect(parseSessionFile('random.jsonl')).toBeNull();
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/unit/aggregator/parse-session-file.test.js`
Expected: 8/8 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/aggregator/parse-session-file.test.js
git commit -m "test(aggregator): cover filename parsing and timestamp normalization"
```

---

## Phase 3 — I/O 与集成测试

### Task 10：`pricing.detectOpenClawDir` + `loadPricingConfig` + `savePricingConfig`

**Files:**
- Create: `tests/integration/pricing/config-io.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

async function withFreshPricingModule() {
  // 确保 detectOpenClawDir / loadPricingConfig 使用当前 env
  const mod = await import(`../../../pricing.js?t=${Date.now()}`);
  return mod;
}

describe('pricing config I/O', () => {
  it('detectOpenClawDir honors OPENCLAW_DIR env', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const { detectOpenClawDir } = await withFreshPricingModule();
    expect(await detectOpenClawDir()).toBe(ws.workspaceDir);
  });

  it('loadPricingConfig returns default shape when file absent', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const { loadPricingConfig } = await withFreshPricingModule();
    const cfg = await loadPricingConfig();
    expect(cfg.version).toBe('1.0');
    expect(cfg.pricing).toEqual({});
  });

  it('savePricingConfig writes and loadPricingConfig reads it back', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    const { loadPricingConfig, savePricingConfig } = await withFreshPricingModule();
    await savePricingConfig({
      version: '1.0',
      enabled: true,
      pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } },
    });
    const loaded = await loadPricingConfig();
    expect(loaded.pricing['openai/gpt-4o'].input).toBe(2.5);
    expect(loaded.enabled).toBe(true);
    expect(typeof loaded.updated).toBe('string'); // savePricing 自动盖章
  });

  it('migrates from legacy ~/.openclaw path if new one missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    // 准备 legacy 路径：~/.openclaw/openclaw-usage-pricing.json
    const legacyDir = join(homedir(), '.openclaw');
    const legacyFile = join(legacyDir, 'openclaw-usage-pricing.json');
    const legacyBackup = `${legacyFile}.before-test-${Date.now()}`;
    let restoreLegacy = () => {};
    try {
      mkdirSync(legacyDir, { recursive: true });
      try {
        writeFileSync(legacyBackup, readFileSync(legacyFile));
        restoreLegacy = () => writeFileSync(legacyFile, readFileSync(legacyBackup));
      } catch { /* no pre-existing legacy file */ }
      writeFileSync(legacyFile, JSON.stringify({
        version: '1.0',
        pricing: { 'legacy/model': { input: 7, output: 7 } },
      }));

      const { loadPricingConfig } = await withFreshPricingModule();
      const cfg = await loadPricingConfig();
      expect(cfg.pricing['legacy/model']).toBeTruthy();

      // 新路径应出现迁移后文件
      const migrated = JSON.parse(readFileSync(
        join(ws.workspaceDir, 'openclaw-usage-pricing.json'), 'utf-8'
      ));
      expect(migrated.pricing['legacy/model']).toBeTruthy();
    } finally {
      try { rmSync(legacyBackup, { force: true }); } catch {}
      restoreLegacy();
    }
  });
});
```

> ⚠️ 迁移测试直接写用户真实 `~/.openclaw` 有副作用。实现时把迁移测试用 `describe.skipIf(process.env.CI)` 在 CI 上跳过，或改为仅在本机 opt-in：`describe.runIf(process.env.RUN_LEGACY_MIGRATION)`。下一任务里会提。

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/integration/pricing/config-io.test.js`
Expected: 3/3 PASS，legacy 用例在无环境变量时被标记跳过。

- [ ] **Step 3：把 legacy 测试改为 opt-in**

把上面 `it('migrates from legacy …')` 改成：

```js
const runLegacy = process.env.RUN_LEGACY_MIGRATION ? it : it.skip;
runLegacy('migrates from legacy ~/.openclaw path if new one missing', async () => { /* 同上 */ });
```

- [ ] **Step 4：再跑确认 skip 生效**

Run: `npm test -- tests/integration/pricing/config-io.test.js`
Expected: 3 passed / 1 skipped

- [ ] **Step 5：提交**

```bash
git add tests/integration/pricing/config-io.test.js
git commit -m "test(pricing): integration coverage for config I/O and legacy migration"
```

---

### Task 11：`openclaw-config.listOpenClawPricedModels` / `listUnpricedModels`

**Files:**
- Create: `tests/integration/openclaw-config/list-models.test.js`
- Create: `tests/fixtures/models/models.synth.json`

- [ ] **Step 1：创建合成边界 fixture**

Path: `tests/fixtures/models/models.synth.json`

```json
{
  "providers": {
    "openai": {
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "cost": { "input": 2.5, "output": 10 }, "contextWindow": 128000, "maxTokens": 16384 },
        { "id": "gpt-mini-unpriced", "name": "Unpriced model" }
      ]
    },
    "empty-provider": { "models": [] }
  }
}
```

- [ ] **Step 2：写测试**

```js
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

async function fresh() {
  return import(`../../../openclaw-config.js?t=${Date.now()}`);
}

describe('openclaw-config list*Models', () => {
  it('returns [] when models.json is missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const { listOpenClawPricedModels, listUnpricedModels } = await fresh();
    expect(await listOpenClawPricedModels()).toEqual([]);
    expect(await listUnpricedModels()).toEqual([]);
  });

  it('splits priced vs unpriced from synth fixture', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyFileSync(fixturePath('models', 'models.synth.json'), join(ws.agentDir, 'models.json'));

    const { listOpenClawPricedModels, listUnpricedModels } = await fresh();
    const priced = await listOpenClawPricedModels();
    const unpriced = await listUnpricedModels();

    expect(priced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-4o']);
    expect(unpriced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-mini-unpriced']);
  });

  it('uses real sanitized models.json without crashing and produces non-empty lists', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyFileSync(fixturePath('models', 'models.real.json'), join(ws.agentDir, 'models.json'));

    const { listOpenClawPricedModels, listUnpricedModels } = await fresh();
    const priced = await listOpenClawPricedModels();
    const unpriced = await listUnpricedModels();

    expect(Array.isArray(priced)).toBe(true);
    expect(Array.isArray(unpriced)).toBe(true);
    expect(priced.length + unpriced.length).toBeGreaterThan(0);
    for (const row of priced) {
      expect(typeof row.provider).toBe('string');
      expect(typeof row.model).toBe('string');
      expect(typeof row.cost.input).toBe('number');
    }
  });
});
```

- [ ] **Step 3：运行**

Run: `npm test -- tests/integration/openclaw-config/list-models.test.js`
Expected: 3/3 PASS

- [ ] **Step 4：提交**

```bash
git add tests/fixtures/models/models.synth.json tests/integration/openclaw-config/
git commit -m "test(openclaw-config): cover priced/unpriced split with real + synth fixtures"
```

---

### Task 12：`aggregator.aggregateStats` 集成测试

**Files:**
- Create: `tests/integration/aggregator/aggregate-stats.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

async function fresh() {
  return import(`../../../aggregator.js?t=${Date.now()}`);
}

function copyReal(ws) {
  const src = fixturePath('sessions-real');
  for (const name of readdirSync(src)) copyFileSync(join(src, name), join(ws.sessionsDir, name));
}

function copySynth(ws) {
  copyFileSync(
    fixturePath('sessions-synth', 'edge-matrix.jsonl'),
    join(ws.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
  );
}

describe('aggregateStats', () => {
  it('returns empty aggregate when sessions dir is empty', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const { aggregateStats } = await fresh();
    const data = await aggregateStats(null);

    expect(data.summary.totalSessions).toBe(0);
    expect(data.byProvider).toEqual({});
    expect(data.byDateProvider).toEqual({});
  });

  it('parses synthetic edge matrix correctly', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copySynth(ws);

    const { aggregateStats } = await fresh();
    const data = await aggregateStats(null);

    // edge-matrix 共 5 行：1 坏行 + 1 openclaw internal（被过滤）+ 3 有效 record
    expect(data.summary.totalRequests).toBe(3);
    expect(data.summary.totalSessions).toBe(1);
    expect(Object.keys(data.byProvider).sort()).toEqual(['anthropic', 'openai']); // openclaw 被过滤
    expect(data.byDateProvider['2026-04-15']).toBeDefined();
    expect(data.byDateProvider['2026-04-16']).toBeDefined();
  });

  it('skips checkpoint files while real sessions still aggregate', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyReal(ws);

    const { aggregateStats } = await fresh();
    const data = await aggregateStats(null);

    // 真实样本中的 checkpoint 不应被计入 totalSessions
    const checkpointCount = readdirSync(ws.sessionsDir).filter((n) => n.includes('.checkpoint.')).length;
    expect(checkpointCount).toBeGreaterThan(0);
    expect(data.summary.totalSessions).toBeLessThanOrEqual(
      readdirSync(ws.sessionsDir).length - checkpointCount,
    );
  });

  it('applies custom pricing when pricingConfig supplied', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copySynth(ws);

    const { aggregateStats } = await fresh();
    const data = await aggregateStats({
      version: '1.0',
      enabled: true,
      pricing: {
        'openai/gpt-4o': { input: 100, output: 100, cacheRead: null, cacheWrite: null },
        'anthropic/claude-*': { matchType: 'wildcard', input: 100, output: 100 },
      },
    });

    // 100 $/M 配上合成 fixture 的用量，totalCost 肯定 > OpenClaw 原始 cost 之和
    expect(data.summary.totalCost).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/integration/aggregator/aggregate-stats.test.js`
Expected: 4/4 PASS

- [ ] **Step 3：提交**

```bash
git add tests/integration/aggregator/
git commit -m "test(aggregator): integration coverage for aggregateStats with real+synth fixtures"
```

---

### Task 13：`stats-service` 缓存与失效行为

**Files:**
- Create: `tests/integration/stats-service/cache.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';

const disposables = [];
afterEach(async () => {
  vi.useRealTimers();
  while (disposables.length) await disposables.pop()();
});

async function fresh() {
  return import(`../../../stats-service.js?t=${Date.now()}`);
}

describe('stats-service cache', () => {
  it('returns cached value within TTL', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await ws.writePricingConfig({
      version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z', pricing: {},
    });

    const { getStats } = await fresh();
    const a = await getStats();
    const b = await getStats();
    expect(a).toBe(b); // 引用相等
  });

  it('rebuilds when pricing.updated changes', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await ws.writePricingConfig({
      version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z', pricing: {},
    });

    const { getStats } = await fresh();
    const a = await getStats();

    await ws.writePricingConfig({
      version: '1.0', enabled: true, updated: '2026-04-21T00:00:00.000Z', pricing: {},
    });

    const b = await getStats();
    expect(b).not.toBe(a);
    expect(b.pricingUpdated).toBe('2026-04-21T00:00:00.000Z');
  });

  it('rebuilds after TTL elapses', async () => {
    vi.useFakeTimers();
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await ws.writePricingConfig({
      version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z', pricing: {},
    });

    const { getStats } = await fresh();
    const a = await getStats();
    vi.advanceTimersByTime(31_000);
    const b = await getStats();
    expect(b).not.toBe(a);
  });

  it('forceFresh bypasses cache', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    await ws.writePricingConfig({
      version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z', pricing: {},
    });

    const { getStats } = await fresh();
    const a = await getStats();
    const b = await getStats({ forceFresh: true });
    expect(b).not.toBe(a);
  });
});
```

- [ ] **Step 2：运行测试**

Run: `npm test -- tests/integration/stats-service/cache.test.js`
Expected: 4/4 PASS

- [ ] **Step 3：提交**

```bash
git add tests/integration/stats-service/
git commit -m "test(stats-service): cover TTL, pricing.updated and forceFresh paths"
```

---

### Task 14：重构 `server.js` 导出 `createApp()`，再写 API 测试

**Files:**
- Modify: `server.js`（拆 app 与 listen）
- Create: `tests/integration/server/api.test.js`

- [ ] **Step 1：重构 `server.js`**

把 `server.js` 末尾改成两段导出：

```js
// server.js 末尾（把原 app.listen 前的所有路由注册包到 createApp）
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/stats', async (req, res) => { /* 原 body */ });
  // ... 复制现有全部路由 ...

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`OpenClaw Usage API running at http://localhost:${PORT}`);
    console.log(`Scanning sessions from: ${getSessionDir()}`);
  });
}
```

> 具体改法：把第 15–135 行的 `const app = express();` … 所有路由注册，整体搬进 `createApp()`，并在末尾 `return app`；主入口用 `import.meta.url === 'file://' + process.argv[1]` 判断仅当直接 `node server.js` 时才启动 listen。

- [ ] **Step 2：手动验证 dev 没坏**

Run: `node server.js`
Expected: 仍然输出 "OpenClaw Usage API running at http://localhost:3001"。立刻 `Ctrl+C` 停掉。

- [ ] **Step 3：写 API 测试**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';

let ws;
let app;

beforeEach(async () => {
  ws = await createTmpWorkspace();
  for (const name of readdirSync(fixturePath('sessions-real'))) {
    copyFileSync(fixturePath('sessions-real', name), join(ws.sessionsDir, name));
  }
  copyFileSync(fixturePath('models', 'models.real.json'), join(ws.agentDir, 'models.json'));
  await ws.writePricingConfig({
    version: '1.0', enabled: true, updated: new Date().toISOString(), pricing: {},
  });

  const { createApp } = await import(`../../../server.js?t=${Date.now()}`);
  // 让 stats-service 模块也拿到新 env（通过 import cache busting）
  app = createApp();
});

afterEach(async () => {
  await ws.cleanup();
});

describe('GET /api/stats', () => {
  it('returns aggregated stats with expected shape', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.byProvider).toBeDefined();
    expect(res.body.byDateProvider).toBeDefined();
    expect(typeof res.body.generatedAt).toBe('string');
  });
});

describe('GET /api/refresh', () => {
  it('returns ok and a fresh generatedAt', async () => {
    const res = await request(app).get('/api/refresh').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.generatedAt).toBeDefined();
  });
});

describe('/api/pricing CRUD', () => {
  it('GET returns current config', async () => {
    const res = await request(app).get('/api/pricing').expect(200);
    expect(res.body.version).toBe('1.0');
  });

  it('PUT validates and saves; invalid config returns 400', async () => {
    await request(app)
      .put('/api/pricing')
      .send({ version: '1.0', pricing: { 'openai/gpt-4o': { input: -1, output: 1 } } })
      .expect(400);

    const ok = await request(app)
      .put('/api/pricing')
      .send({
        version: '1.0', enabled: true,
        pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } },
      })
      .expect(200);
    expect(ok.body.ok).toBe(true);
  });

  it('POST /api/pricing/reset returns default config', async () => {
    const res = await request(app).post('/api/pricing/reset').expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('/api/openclaw/models', () => {
  it('returns priced + unpriced models from real models.json', async () => {
    const res = await request(app).get('/api/openclaw/models').expect(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(Array.isArray(res.body.unpricedModels)).toBe(true);
  });
});

describe('/api/pricing/models', () => {
  it('returns unique provider/model keys from stats', async () => {
    const res = await request(app).get('/api/pricing/models').expect(200);
    expect(Array.isArray(res.body.models)).toBe(true);
  });
});
```

- [ ] **Step 4：运行测试**

Run: `npm test -- tests/integration/server/api.test.js`
Expected: 6/6 PASS

- [ ] **Step 5：提交**

```bash
git add server.js tests/integration/server/
git commit -m "refactor(server): export createApp; test: cover all Express endpoints"
```

---

### Task 15：重构 `mcp-server.js` 导出 `createMcpServer()`，再写工具测试

**Files:**
- Modify: `mcp-server.js`
- Create: `tests/integration/mcp/tools.test.js`

- [ ] **Step 1：重构 `mcp-server.js`**

改为：

```js
// mcp-server.js（顶部保留原 imports）
export function createMcpServer() {
  const server = new Server(/* 原参数 */);

  server.setRequestHandler(ListToolsRequestSchema, async () => { /* 原 body */ });
  server.setRequestHandler(CallToolRequestSchema, async (request) => { /* 原 body */ });

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OpenClaw Usage MCP server running on stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error('Fatal:', error); process.exit(1); });
}
```

> 额外在 `createMcpServer` 返回前，把 handler 引用暴露为 `server.__handlers = { listTools, callTool }` 便于测试直接调用（或使用 `Server` 实例内部 Map，但 SDK 版本间可能变；显式导出更稳）。改法：

```js
export function createMcpServer() {
  const server = new Server(/* ... */);

  const listToolsHandler = async () => ({ tools: [/* 原清单 */] });
  const callToolHandler = async (request) => { /* 原 switch */ };

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);

  server.__handlers = { listTools: listToolsHandler, callTool: callToolHandler };
  return server;
}
```

- [ ] **Step 2：手动验证 `npm run mcp` 仍可启动**

Run: `npm run mcp` 然后立即 Ctrl+C
Expected: stderr 看到 "OpenClaw Usage MCP server running on stdio"

- [ ] **Step 3：写 MCP 测试**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';

let ws;
let handlers;

beforeEach(async () => {
  ws = await createTmpWorkspace();
  for (const name of readdirSync(fixturePath('sessions-real'))) {
    copyFileSync(fixturePath('sessions-real', name), join(ws.sessionsDir, name));
  }
  await ws.writePricingConfig({
    version: '1.0', enabled: true, updated: new Date().toISOString(), pricing: {},
  });

  const { createMcpServer } = await import(`../../../mcp-server.js?t=${Date.now()}`);
  const server = createMcpServer();
  handlers = server.__handlers;
});

afterEach(async () => {
  await ws.cleanup();
});

function call(name, args = {}) {
  return handlers.callTool({ params: { name, arguments: args } });
}

describe('MCP tools', () => {
  it('listTools returns 8 tool descriptors', async () => {
    const res = await handlers.listTools();
    expect(res.tools.length).toBe(8);
    const names = res.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_total_usage', 'get_usage_by_provider', 'get_usage_by_model',
      'list_recent_sessions', 'get_session_stats',
      'get_pricing_config', 'update_pricing_config', 'refresh_stats_cache',
    ]));
  });

  it('get_total_usage returns JSON summary text', async () => {
    const res = await call('get_total_usage');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toHaveProperty('totalTokens');
  });

  it('get_session_stats returns 404-style isError when unknown UUID', async () => {
    const res = await call('get_session_stats', { sessionId: '00000000-0000-0000-0000-000000000000' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
  });

  it('update_pricing_config + refresh_stats_cache reflect the change', async () => {
    await call('update_pricing_config', {
      config: { version: '1.0', enabled: true, pricing: { 'openai/gpt-4o': { input: 999, output: 999 } } },
    });
    const refreshRes = await call('refresh_stats_cache');
    expect(JSON.parse(refreshRes.content[0].text).ok).toBe(true);

    const pricingRes = await call('get_pricing_config');
    expect(JSON.parse(pricingRes.content[0].text).pricing['openai/gpt-4o'].input).toBe(999);
  });

  it('list_recent_sessions respects limit', async () => {
    const res = await call('list_recent_sessions', { limit: 2 });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 4：运行测试**

Run: `npm test -- tests/integration/mcp/tools.test.js`
Expected: 5/5 PASS

- [ ] **Step 5：提交**

```bash
git add mcp-server.js tests/integration/mcp/
git commit -m "refactor(mcp): export createMcpServer; test: cover all 8 tools"
```

---

## Phase 4 — 前端纯逻辑测试

### Task 16：抽出 `src/data-filter.js`（来自 `main.js`）

**Files:**
- Create: `src/data-filter.js`
- Modify: `src/main.js`（删除被抽走的函数，改为 import）

- [ ] **Step 1：创建 `src/data-filter.js`**

把 `main.js` 第 91–214 行的 `emptyBucket` / `mergeInto` / `collapseCrossTable` / `filterDataByDateRange` 原样搬进去并 `export`：

```js
/**
 * 按日期区间重切聚合数据。
 * 从 main.js 抽离以便独立单元测试。
 */

export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
}

export function mergeInto(dst, src) {
  dst.input += src.input || 0;
  dst.output += src.output || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheWrite += src.cacheWrite || 0;
  dst.totalTokens += src.totalTokens || 0;
  dst.totalCost += src.totalCost || 0;
  dst.requests += src.requests || 0;
}

export function collapseCrossTable(crossTable, from, to) {
  const result = {};
  for (const [date, keyMap] of Object.entries(crossTable)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    for (const [key, stats] of Object.entries(keyMap)) {
      if (!result[key]) result[key] = emptyBucket();
      mergeInto(result[key], stats);
    }
  }
  return result;
}

export function filterDataByDateRange(fullData, from, to) {
  /* 原 main.js 第 130–214 行内容原样保留 */
}
```

- [ ] **Step 2：在 `main.js` 顶部加 import，删掉本地定义**

```js
import { emptyBucket, mergeInto, collapseCrossTable, filterDataByDateRange } from './data-filter.js';
```

同时删除 `main.js` 第 91–214 行的本地定义。

- [ ] **Step 3：手动验证前端构建不坏**

Run: `npm run build`
Expected: Vite 构建成功，无 `filterDataByDateRange is not defined` 之类错误。

- [ ] **Step 4：提交**

```bash
git add src/data-filter.js src/main.js
git commit -m "refactor(frontend): extract data-filter module from main.js for testability"
```

---

### Task 17：`data-filter` 测试

**Files:**
- Create: `tests/unit/frontend/data-filter.test.js`

- [ ] **Step 1：写测试**

```js
import { describe, it, expect } from 'vitest';
import { filterDataByDateRange } from '../../../src/data-filter.js';

const bucket = (input, output) => ({
  input, output, cacheRead: 0, cacheWrite: 0,
  totalTokens: input + output, totalCost: input / 100 + output / 100, requests: 1,
});

const fullData = {
  summary: {},
  byDate: {
    '2026-04-15': bucket(100, 50),
    '2026-04-16': bucket(200, 100),
    '2026-04-17': bucket(300, 150),
  },
  byDateProvider: {
    '2026-04-15': { openai: bucket(100, 50) },
    '2026-04-16': { anthropic: bucket(200, 100) },
    '2026-04-17': { openai: bucket(300, 150) },
  },
  byDateModel: {
    '2026-04-15': { 'openai/gpt-4o': bucket(100, 50) },
    '2026-04-16': { 'anthropic/claude-sonnet-4': bucket(200, 100) },
    '2026-04-17': { 'openai/gpt-4o': bucket(300, 150) },
  },
  sessions: [
    { id: 's1', byDate: { '2026-04-15': bucket(100, 50) }, lastTimestamp: '2026-04-15T00:00:00Z' },
    { id: 's2', byDate: { '2026-04-17': bucket(300, 150) }, lastTimestamp: '2026-04-17T00:00:00Z' },
  ],
  generatedAt: '2026-04-20T00:00:00Z',
};

describe('filterDataByDateRange', () => {
  it('returns original data when no range', () => {
    expect(filterDataByDateRange(fullData, null, null)).toBe(fullData);
  });

  it('filters by from only', () => {
    const r = filterDataByDateRange(fullData, '2026-04-16', null);
    expect(Object.keys(r.byDate)).toEqual(['2026-04-16', '2026-04-17']);
    expect(r.summary.totalInput).toBe(500);
  });

  it('filters by to only', () => {
    const r = filterDataByDateRange(fullData, null, '2026-04-15');
    expect(Object.keys(r.byDate)).toEqual(['2026-04-15']);
  });

  it('collapses byDateProvider into byProvider over range', () => {
    const r = filterDataByDateRange(fullData, '2026-04-15', '2026-04-16');
    expect(r.byProvider).toHaveProperty('openai');
    expect(r.byProvider).toHaveProperty('anthropic');
    expect(r.byProvider.openai.input).toBe(100);
  });

  it('collapses byDateModel into byModel with provider/model split', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.byModel['openai/gpt-4o'].provider).toBe('openai');
    expect(r.byModel['openai/gpt-4o'].model).toBe('gpt-4o');
    expect(r.byModel['openai/gpt-4o'].input).toBe(300);
  });

  it('filters sessions and recomputes totals when byDate present', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(r.sessions[0].totalInput).toBe(300);
    expect(r.summary.totalSessions).toBe(1);
  });
});
```

- [ ] **Step 2：运行**

Run: `npm test -- tests/unit/frontend/data-filter.test.js`
Expected: 6/6 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/frontend/data-filter.test.js
git commit -m "test(frontend): cover filterDataByDateRange branches"
```

---

### Task 18：`src/util.js`（jsdom）

**Files:**
- Create: `tests/unit/frontend/util.test.js`

- [ ] **Step 1：写测试**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escapeHtml, escapeAttr, showToast } from '../../../src/util.js';

describe('escapeHtml', () => {
  it('escapes < > & and quotes via textContent', () => {
    expect(escapeHtml('<b>"a"&b</b>')).toBe('&lt;b&gt;"a"&amp;b&lt;/b&gt;');
  });

  it('handles null and undefined as empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('escapeAttr', () => {
  it('escapes double quotes and brackets', () => {
    expect(escapeAttr('a "b" <c>')).toBe('a &quot;b&quot; &lt;c&gt;');
  });
});

describe('showToast', () => {
  let el;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    el.id = 'pricing-toast';
    el.hidden = true;
    document.body.appendChild(el);
  });

  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it('shows message and auto-hides after duration', () => {
    showToast('hi', { duration: 500 });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('hi');
    vi.advanceTimersByTime(500);
    expect(el.hidden).toBe(true);
  });

  it('applies variant class', () => {
    showToast('err', { variant: 'error' });
    expect(el.classList.contains('pricing-toast--error')).toBe(true);
  });

  it('silently returns when toast element is absent', () => {
    el.remove();
    expect(() => showToast('noop')).not.toThrow();
  });
});
```

- [ ] **Step 2：运行**

Run: `npm test -- tests/unit/frontend/util.test.js`
Expected: 6/6 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/frontend/util.test.js
git commit -m "test(frontend): cover util.js (escapeHtml/escapeAttr/showToast)"
```

---

### Task 19：`src/i18n.js`（jsdom）

**Files:**
- Create: `tests/unit/frontend/i18n.test.js`

- [ ] **Step 1：写测试**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

async function freshI18n() {
  return import(`../../../src/i18n.js?t=${Date.now()}`);
}

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('defaults to zh-CN', async () => {
    const { getLocale } = await freshI18n();
    expect(getLocale()).toBe('zh-CN');
  });

  it('setLocale persists and normalizes unsupported', async () => {
    const { setLocale, getLocale } = await freshI18n();
    setLocale('fr-FR');
    expect(getLocale()).toBe('zh-CN'); // 回退
    setLocale('en-US');
    expect(getLocale()).toBe('en-US');
    expect(localStorage.getItem('openclaw-locale')).toBe('en-US');
  });

  it('t returns key when missing in both dictionaries', async () => {
    const { t } = await freshI18n();
    expect(t('totally.bogus.key')).toBe('totally.bogus.key');
  });

  it('t interpolates {param} templates', async () => {
    const { t, setLocale } = await freshI18n();
    setLocale('zh-CN');
    // 从现有 dashboard.summaryRequests：'{count} 次请求'
    expect(t('dashboard.summaryRequests', { count: '3' })).toMatch('3');
  });

  it('translateStaticElements applies data-i18n text', async () => {
    const { translateStaticElements, setLocale } = await freshI18n();
    setLocale('zh-CN');
    document.body.innerHTML = '<span data-i18n="common.save"></span>';
    translateStaticElements(document);
    const txt = document.querySelector('span').textContent;
    expect(txt.length).toBeGreaterThan(0);
    expect(txt).not.toBe('common.save');
  });
});
```

- [ ] **Step 2：运行**

Run: `npm test -- tests/unit/frontend/i18n.test.js`
Expected: 5/5 PASS（若 `common.save` 在当前词典里不存在，替换为任何一个已存在 key，如 `dashboard.summaryTotalTokens`）

- [ ] **Step 3：提交**

```bash
git add tests/unit/frontend/i18n.test.js
git commit -m "test(frontend): cover i18n locale selection, fallback and interpolation"
```

---

### Task 20：`src/theme.js`（jsdom）

**Files:**
- Create: `tests/unit/frontend/theme.test.js`

- [ ] **Step 1：写测试**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

async function loadTheme() {
  // theme.js 是 IIFE，import 时会立即执行并挂载到 window.OpenClawTheme
  await import(`../../../src/theme.js?t=${Date.now()}`);
  return window.OpenClawTheme;
}

function stubMatchMedia(dark) {
  window.matchMedia = (q) => ({
    matches: dark && q.includes('dark'),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

describe('theme.js', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.themeMode;
    delete document.documentElement.dataset.themeResolved;
    stubMatchMedia(false);
  });

  it('defaults to system mode resolved to light when prefers-color-scheme is light', async () => {
    const api = await loadTheme();
    expect(api.getMode()).toBe('system');
    expect(api.getResolved()).toBe('light');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
  });

  it('setTheme("dark") persists and applies theme-dark class', async () => {
    const api = await loadTheme();
    api.setTheme('dark');
    expect(api.getMode()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(localStorage.getItem('openclaw-theme')).toBe('dark');
  });

  it('setTheme ignores invalid mode', async () => {
    const api = await loadTheme();
    api.setTheme('fuchsia');
    expect(['light', 'dark', 'system']).toContain(api.getMode());
  });

  it('system mode tracks matchMedia dark preference', async () => {
    stubMatchMedia(true);
    const api = await loadTheme();
    expect(api.getResolved()).toBe('dark');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });
});
```

- [ ] **Step 2：运行**

Run: `npm test -- tests/unit/frontend/theme.test.js`
Expected: 4/4 PASS

- [ ] **Step 3：提交**

```bash
git add tests/unit/frontend/theme.test.js
git commit -m "test(frontend): cover theme light/dark/system resolution"
```

---

## 最终验证

- [ ] **Step 1：跑全量测试**

Run: `npm test`
Expected: 所有 projects（node + jsdom）passed；大约 20 个测试文件、60+ 个用例全绿。

- [ ] **Step 2：跑覆盖率**

Run: `npm run test:coverage`
Expected: 看到核心模块行覆盖率 ≥ 80%（非强制门槛，仅检查）；覆盖率报告生成到 `coverage/`。

- [ ] **Step 3：`.gitignore` 补充 `coverage/`**

```gitignore
coverage/
```

- [ ] **Step 4：同步审计 & 更新 spec 状态**

```bash
# 对照 docs/superpowers/specs/2026-04-20-complete-testing-strategy-design.md 验收标准逐条打勾
```

如果发现任何实现偏离 spec，现在更新 spec 为"已实施"并记录差异。

- [ ] **Step 5：最后一次提交**

```bash
git add .gitignore docs/superpowers/specs/2026-04-20-complete-testing-strategy-design.md
git commit -m "docs: mark testing strategy spec as implemented"
```

---

## Self-Review Checklist（计划完成后自查）

- [x] **Spec 覆盖**：
  - 后端核心模块 → Tasks 5–13 ✓
  - Express API → Task 14 ✓
  - MCP 工具 → Task 15 ✓
  - 前端纯逻辑 → Tasks 17–20 ✓
  - 真实样本 + 合成边界 → Tasks 3, 4, 11, 12 ✓
  - 环境隔离（tmpdir + env 注入）→ Task 2 helper，之后每个 integration 任务使用 ✓
  - Vitest 双 env + supertest → Task 1 ✓
  - `models.json` 脱敏入库 → Task 3, 4 ✓
  - GitHub Actions 前置兼容（`npm test` 命令、fixture 版本化）→ Task 1, 4 ✓

- [x] **Placeholder 扫描**：每个测试 Step 都给出真实可运行代码；每个 Run 都声明 expected；未留 TBD。

- [x] **类型/签名一致**：
  - `createTmpWorkspace()` 在所有 integration 任务中调用一致 ✓
  - `createApp()` / `createMcpServer()` 在重构任务和测试任务中一致 ✓
  - `fixturePath()` 函数签名一致 ✓

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-04-20-complete-testing-strategy.md`. Two execution options:**

1. **Subagent-Driven（推荐）** - 每个 Task 派发独立 subagent 执行，每次完成后 review，迭代快、上下文干净
2. **Inline Execution** - 在当前会话中按任务顺序执行，带 checkpoint 批量 review

**Which approach?**
