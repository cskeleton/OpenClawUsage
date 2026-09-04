import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { createApp } from '../../../server.js';
import { resetStatsServiceForTests } from '../../../stats-service.js';
import { saveCandidates } from '../../../pricing-candidates-store.js';

const disposables = [];
let app;
let ws;

/** 定价配置规范路径（OPENCLAW_CONFIG_DIR 下），与 candidates 文件同目录 */
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

  // 规范路径写入 v2 配置，隔离用户本机 legacy 定价文件
  writeCanonicalPricing(v2Config());

  app = createApp();
});

afterEach(async () => {
  resetStatsServiceForTests();
  while (disposables.length) await disposables.pop()();
});

describe('candidates API', () => {
  it('GET /api/pricing/candidates returns empty list initially', async () => {
    const res = await request(app).get('/api/pricing/candidates').expect(200);
    expect(res.body.candidates).toEqual([]);
  });

  it('POST /api/pricing/candidates/resolve rejects non-array body → 400', async () => {
    const bad = await request(app)
      .post('/api/pricing/candidates/resolve')
      .send({ resolutions: 'nope' })
      .expect(400);
    expect(bad.body.code).toBe('PRICING_BAD_REQUEST');

    await request(app)
      .post('/api/pricing/candidates/resolve')
      .send({})
      .expect(400);
  });

  it('resolve accept writes alias+rule and round-trips through GET /api/pricing', async () => {
    // 直接写 candidates 文件，模拟 rematch 已把歧义键入队
    await saveCandidates({
      candidates: [
        {
          observedKey: 'openrouter/gpt-4o-mini',
          candidates: [
            {
              catalogKey: 'openai/gpt-4o-mini',
              provider: 'openai',
              model: 'gpt-4o-mini',
              prices: { input: 0.15, output: 0.6, cacheRead: null, cacheWrite: null },
              score: 1,
              reason: 'exact-multi-provider',
            },
          ],
          lastSeenAt: new Date().toISOString(),
          dismissed: false,
        },
      ],
    });

    const res = await request(app)
      .post('/api/pricing/candidates/resolve')
      .send({
        resolutions: [
          { observedKey: 'openrouter/gpt-4o-mini', action: 'accept', catalogId: 'openai/gpt-4o-mini' },
        ],
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied).toBe(1);
    expect(res.body.failed).toEqual([]);

    // accept 落库：alias 指向所选目录模型，rules 写入 models.dev 来源价目
    const pricing = await request(app).get('/api/pricing').expect(200);
    expect(pricing.body.aliases['openrouter/gpt-4o-mini']).toBe('gpt-4o-mini');
    expect(pricing.body.rules['gpt-4o-mini']).toMatchObject({
      input: 0.15,
      output: 0.6,
      source: 'models.dev',
    });

    // 已处理条目标记 dismissed，仍保留在队列中（含 dismissed，由前端过滤）
    const after = await request(app).get('/api/pricing/candidates').expect(200);
    expect(after.body.candidates).toHaveLength(1);
    expect(after.body.candidates[0].dismissed).toBe(true);
  });

  it('write endpoints reject text/plain content type → 415 (writeRequestGuard)', async () => {
    await request(app)
      .post('/api/pricing/candidates/resolve')
      .set('Content-Type', 'text/plain')
      .send('resolutions=[]')
      .expect(415);

    await request(app)
      .post('/api/pricing/rematch')
      .set('Content-Type', 'text/plain')
      .send('x')
      .expect(415);
  });

  it('POST /api/pricing/rematch on empty stats returns zero counts', async () => {
    ws.execSql('SELECT 1;'); // 空库（仅 schema）：无会话 → byModel 为空
    const res = await request(app)
      .post('/api/pricing/rematch')
      .send({})
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 0, matched: 0, queued: 0 });
  });
});
