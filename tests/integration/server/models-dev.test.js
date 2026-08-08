import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { createApp } from '../../../server.js';
import { getCacheDir } from '../../../stats-cache-store.js';
import {
  __clearModelsDevCacheForTests,
  MODELS_DEV_CACHE_FILENAME,
} from '../../../models-dev.js';

const disposables = [];
let app;
let ws;

beforeEach(async () => {
  __clearModelsDevCacheForTests();
  ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  app = createApp();
});

afterEach(async () => {
  __clearModelsDevCacheForTests();
  while (disposables.length) await disposables.pop()();
});

const SNAPSHOT = {
  fetchedAt: new Date().toISOString(),
  models: [
    {
      key: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1000000,
    },
  ],
};

async function seedCache(snapshot = SNAPSHOT) {
  await mkdir(getCacheDir(), { recursive: true });
  await writeFile(
    join(getCacheDir(), MODELS_DEV_CACHE_FILENAME),
    JSON.stringify(snapshot),
    'utf-8',
  );
}

describe('GET /api/models-dev/models', () => {
  it('returns fresh snapshot without network', async () => {
    await seedCache();
    const res = await request(app).get('/api/models-dev/models');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('models.dev');
    expect(res.body.stale).toBe(false);
    expect(res.body.models[0].key).toBe('anthropic/claude-sonnet-4-6');
  });

  it('marks expired snapshot as stale', async () => {
    await seedCache({ ...SNAPSHOT, fetchedAt: new Date(Date.now() - 25 * 3600e3).toISOString() });
    const res = await request(app).get('/api/models-dev/models');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  it('responds 502 when no cache and network fails', async () => {
    // 损坏缓存文件视为无缓存，再让全局 fetch 失败
    await mkdir(getCacheDir(), { recursive: true });
    await writeFile(join(getCacheDir(), MODELS_DEV_CACHE_FILENAME), 'not-json', 'utf-8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try {
      const res = await request(app).get('/api/models-dev/models');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/models\.dev/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET is not blocked by writeRequestGuard', async () => {
    await seedCache();
    const res = await request(app)
      .get('/api/models-dev/models')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });
});
