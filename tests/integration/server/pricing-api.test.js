import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { createApp } from '../../../server.js';
import { resetStatsServiceForTests } from '../../../stats-service.js';

const disposables = [];
let app;
let ws;

/** 定价配置规范路径（OPENCLAW_CONFIG_DIR 下） */
function pricingPath() {
  return join(ws.configDir, 'openclaw-usage-pricing.json');
}

function writeCanonicalPricing(json) {
  writeFileSync(pricingPath(), JSON.stringify(json, null, 2), 'utf-8');
}

function v2Config(overrides = {}) {
  return {
    version: '2.0',
    enabled: true,
    updated: '0001-01-01T00:00:00.000Z',
    revision: 0,
    matching: { ignoreProvider: true, noiseSuffixes: [] },
    rules: {},
    aliases: {},
    patterns: {},
    ...overrides,
  };
}

beforeEach(async () => {
  resetStatsServiceForTests();
  ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);

  ws.copyFixtureDb(fixturePath('db', 'openclaw-agent.sqlite'));
  ws.writeModelsJson(JSON.parse(readFileSync(fixturePath('models', 'models.real.json'), 'utf-8')));

  // 规范路径写入 v2 配置，隔离用户本机 legacy 定价文件
  writeCanonicalPricing(v2Config());

  app = createApp();
});

afterEach(async () => {
  resetStatsServiceForTests();
  while (disposables.length) await disposables.pop()();
});

describe('pricing write contract', () => {
  it('GET /api/pricing returns v2 config with revision', async () => {
    const res = await request(app).get('/api/pricing').expect(200);
    expect(res.body.version).toBe('2.0');
    expect(res.body.revision).toBe(0);
    expect(res.body.validationErrors).toBeUndefined();
  });

  it('PUT without envelope → 400 PRICING_BAD_REQUEST', async () => {
    // 裸 config（缺信封）
    const bare = await request(app).put('/api/pricing').send(v2Config()).expect(400);
    expect(bare.body.code).toBe('PRICING_BAD_REQUEST');

    // 有 config 但缺 baseRevision
    const noRevision = await request(app)
      .put('/api/pricing')
      .send({ config: v2Config() })
      .expect(400);
    expect(noRevision.body.code).toBe('PRICING_BAD_REQUEST');

    // config 不是对象
    const badConfig = await request(app)
      .put('/api/pricing')
      .send({ config: 'nope', baseRevision: 0 })
      .expect(400);
    expect(badConfig.body.code).toBe('PRICING_BAD_REQUEST');
  });

  it('PUT round-trip then stale baseRevision → 409 with current', async () => {
    const before = await request(app).get('/api/pricing').expect(200);
    const baseRevision = before.body.revision;

    const config = v2Config({
      rules: { 'openai/gpt-4o': { input: 2.5, output: 10, source: 'manual' } },
    });
    const updated = await request(app)
      .put('/api/pricing')
      .send({ config, baseRevision })
      .expect(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.revision).toBe(baseRevision + 1);

    // 用旧 baseRevision 再写 → 冲突，且携带磁盘当前配置
    const conflict = await request(app)
      .put('/api/pricing')
      .send({ config, baseRevision })
      .expect(409);
    expect(conflict.body.code).toBe('PRICING_REVISION_CONFLICT');
    expect(conflict.body.error).toBeTruthy();
    expect(conflict.body.current.revision).toBe(baseRevision + 1);
    expect(conflict.body.current.rules['openai/gpt-4o'].input).toBe(2.5);
  });

  it('PUT invalid config → 422 with field path in error', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .send({
        config: v2Config({ rules: { m: { input: -1, output: 1 } } }),
        baseRevision: 0,
      })
      .expect(422);
    expect(res.body.code).toBe('PRICING_VALIDATION_FAILED');
    expect(res.body.error).toContain('rules.m');
  });

  it('PUT rule with non-whitelisted source → 422', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .send({
        config: v2Config({ rules: { m: { input: 1, output: 1, source: 'evil' } } }),
        baseRevision: 0,
      })
      .expect(422);
    expect(res.body.code).toBe('PRICING_VALIDATION_FAILED');
    expect(res.body.error).toContain('rules.m');
    expect(res.body.error).toMatch(/source/);
  });

  it('POST /api/pricing/reset writes default v2 config unconditionally', async () => {
    // 先写入一条规则并推进 revision
    await request(app)
      .put('/api/pricing')
      .send({
        config: v2Config({ rules: { m: { input: 1, output: 2 } } }),
        baseRevision: 0,
      })
      .expect(200);

    const res = await request(app)
      .post('/api/pricing/reset')
      .set('Content-Type', 'application/json')
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revision).toBeGreaterThan(1);

    const after = await request(app).get('/api/pricing').expect(200);
    expect(after.body.version).toBe('2.0');
    expect(after.body.rules).toEqual({});
    expect(after.body.patterns).toEqual({});
    expect(after.body.aliases).toEqual({});
  });

  it('GET surfaces validationErrors when on-disk config is corrupt; stats still work', async () => {
    writeFileSync(pricingPath(), '{ not json', 'utf-8');

    const res = await request(app).get('/api/pricing').expect(200);
    expect(Array.isArray(res.body.validationErrors)).toBe(true);
    expect(res.body.validationErrors.length).toBeGreaterThan(0);
    expect(res.body.version).toBe('2.0');

    // 统计不得 500：坏配置下回退账面价
    const stats = await request(app).get('/api/stats').expect(200);
    expect(stats.body.summary).toBeDefined();
  });
});
