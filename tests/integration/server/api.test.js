import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { createApp } from '../../../server.js';
import { invalidateStatsCache } from '../../../stats-service.js';

const disposables = [];
let app;

beforeEach(async () => {
  invalidateStatsCache();
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);

  // Copy real sessions + models so stats produce non-trivial data
  for (const name of readdirSync(fixturePath('sessions-real'))) {
    copyFileSync(fixturePath('sessions-real', name), join(ws.sessionsDir, name));
  }
  copyFileSync(fixturePath('models', 'models.real.json'), join(ws.agentDir, 'models.json'));

  // Write a pricing config to isolate from user's legacy pricing file
  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: new Date().toISOString(),
    pricing: {},
  });

  app = createApp();
});

afterEach(async () => {
  invalidateStatsCache();
  while (disposables.length) await disposables.pop()();
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

  it('PUT with invalid config returns 400', async () => {
    await request(app)
      .put('/api/pricing')
      .send({ version: '1.0', pricing: { 'openai/gpt-4o': { input: -1, output: 1 } } })
      .expect(400);
  });

  it('PUT with valid config returns 200 ok', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .send({
        version: '1.0', enabled: true,
        pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/pricing/reset returns default config', async () => {
    const res = await request(app).post('/api/pricing/reset').expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('/api/openclaw/models', () => {
  it('returns priced + unpriced lists', async () => {
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
