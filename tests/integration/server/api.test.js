import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { createApp } from '../../../server.js';
import { invalidateStatsCache, resetStatsServiceForTests } from '../../../stats-service.js';

const disposables = [];
let app;

beforeEach(async () => {
  resetStatsServiceForTests();
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
  resetStatsServiceForTests();
  while (disposables.length) await disposables.pop()();
});

describe('GET /api/stats', () => {
  it('returns aggregated stats with expected shape', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.byProvider).toBeDefined();
    expect(res.body.byDateProvider).toBeDefined();
    expect(typeof res.body.generatedAt).toBe('string');
    expect(res.body.cache).toBeDefined();
    expect(res.body.cache.state).toMatch(/fresh|refreshing|stale/);
  });

  it('fresh=1 waits and returns fresh cache state', async () => {
    const res = await request(app).get('/api/stats?fresh=1').expect(200);
    expect(res.body.cache.state).toBe('fresh');
  });
});

describe('GET /api/refresh', () => {
  it('returns ok and a fresh generatedAt', async () => {
    const res = await request(app).get('/api/refresh').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.generatedAt).toBeDefined();
    expect(res.body.cache).toBeDefined();
  });

  it('full=1 returns ok after full rebuild', async () => {
    const res = await request(app).get('/api/refresh?full=1').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cache.state).toBe('fresh');
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
    const res = await request(app)
      .post('/api/pricing/reset')
      .set('Content-Type', 'application/json')
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('write endpoint CSRF guard', () => {
  it('rejects cross-site Origin on PUT /api/pricing', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .set('Origin', 'https://evil.example.com')
      .send({ version: '1.0', enabled: true, pricing: {} })
      .expect(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it('rejects cross-site Origin on POST /api/pricing/reset', async () => {
    await request(app)
      .post('/api/pricing/reset')
      .set('Origin', 'https://evil.example.com')
      .set('Content-Type', 'application/json')
      .expect(403);
  });

  it('rejects opaque Origin (sandboxed iframe / file://)', async () => {
    await request(app)
      .post('/api/pricing/reset')
      .set('Origin', 'null')
      .set('Content-Type', 'application/json')
      .expect(403);
  });

  it('rejects cross-site form content types', async () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const res = await request(app)
        .post('/api/pricing/reset')
        .set('Content-Type', contentType)
        .send('version=1.0')
        .expect(415);
      expect(res.body.error).toMatch(/application\/json/i);
    }
  });

  it('rejects reset without any Content-Type', async () => {
    await request(app).post('/api/pricing/reset').expect(415);
  });

  it('accepts same-origin JSON fetch from the local frontend', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'http://127.0.0.1:3001')
      .send({ version: '1.0', enabled: true, pricing: {} })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts the dev-mode Vite proxy origin (loopback, different port)', async () => {
    const res = await request(app)
      .post('/api/pricing/reset')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'http://localhost:3000')
      .set('Content-Type', 'application/json')
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('does not affect read endpoints', async () => {
    await request(app)
      .get('/api/pricing')
      .set('Origin', 'https://evil.example.com')
      .expect(200);
  });

  it('parses vendor JSON (+json) and accepts a valid pricing config', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .set('Content-Type', 'application/vnd.test+json')
      .send({
        version: '1.0',
        enabled: true,
        pricing: { 'openai/gpt-4o': { input: 2.5, output: 10 } },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('parses vendor JSON (+json) but still rejects an invalid pricing config', async () => {
    const res = await request(app)
      .put('/api/pricing')
      .set('Content-Type', 'application/vnd.test+json')
      .send({
        version: '1.0',
        pricing: { 'openai/gpt-4o': { input: -1, output: 1 } },
      })
      .expect(400);
    expect(res.body.error).toBeTruthy();
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
