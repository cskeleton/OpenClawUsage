import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { createApp } from '../../../server.js';
import { createMcpServer } from '../../../mcp-server.js';
import {
  getStats,
  resetStatsServiceForTests,
  updatePricingConfig,
} from '../../../stats-service.js';
import { namespaceFileContributions } from '../../../stats-contribution.js';

const disposables = [];

function syncConfig(overrides = {}) {
  return {
    version: 1,
    source: { id: 'local', label: 'This machine' },
    policy: {
      allowedSshTargets: {
        claw: { label: 'claw', sshAlias: 'ssh-secret-alias' },
      },
    },
    settings: { enabled: true, targetId: 'claw', intervalMinutes: 60 },
    imports: { allowedSourceIds: ['remote'] },
    ...overrides,
  };
}

function importedSnapshot(provider = 'openai') {
  return {
    version: 1,
    kind: 'openclaw-usage-source-contributions',
    scope: 'local-only',
    source: { id: 'remote', label: 'Remote laptop' },
    revision: 'remote-revision',
    generatedAt: '2026-04-20T00:00:00.000Z',
    contributions: [{
      contributionId: 'opaque-remote-file',
      session: { id: 'same-session', status: 'active', archivedAt: null },
      firstTimestamp: '2026-04-15T10:00:00.000Z',
      lastTimestamp: '2026-04-15T10:00:00.000Z',
      buckets: [{
        date: '2026-04-15',
        provider,
        model: 'gpt-4o',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        requests: 1,
      }],
      hasRecords: true,
    }],
  };
}

async function setup({ withImport = true, missingImport = false } = {}) {
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);
  copyFileSync(fixturePath('sessions-synth', 'edge-matrix.jsonl'), join(ws.sessionsDir, 'same-session.jsonl'));
  // parseSessionFile requires a UUID prefix; keep the semantic collision in the
  // session ID carried by the imported contribution instead.
  copyFileSync(fixturePath('sessions-synth', 'edge-matrix.jsonl'), join(ws.sessionsDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'));
  writeFileSync(join(ws.workspaceDir, 'openclaw-usage-pricing.json'), JSON.stringify({
    version: '1.0', enabled: true, updated: '2026-04-20T00:00:00.000Z',
    pricing: { 'openai/gpt-4o': { input: 1, output: 2 } },
  }));
  writeFileSync(join(ws.configDir, 'openclaw-usage-sync.json'), JSON.stringify(syncConfig({
    imports: { allowedSourceIds: missingImport ? ['remote', 'missing'] : ['remote'] },
  })));
  if (withImport && !missingImport) {
    const importDir = join(ws.configDir, 'cache/openclaw-usage/imports');
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, 'remote.json'), JSON.stringify(importedSnapshot()));
    const old = new Date('2026-04-20T00:00:00.000Z');
    utimesSync(join(importDir, 'remote.json'), old, old);
  }
  return ws;
}

beforeEach(() => resetStatsServiceForTests());
afterEach(async () => {
  resetStatsServiceForTests();
  while (disposables.length) await disposables.pop()();
});

describe('multi-source stats aggregation', () => {
  it('namespaces colliding sessions and combines per-source contributions with receiver pricing', async () => {
    await setup();
    const result = await getStats({ waitForRefresh: true });

    expect(result.sources.map((source) => source.id)).toEqual(['local', 'remote']);
    expect(result.statsBySource.local.summary.totalTokens + result.statsBySource.remote.summary.totalTokens)
      .toBe(result.summary.totalTokens);
    expect(result.statsBySource.local.summary.totalRequests + result.statsBySource.remote.summary.totalRequests)
      .toBe(result.summary.totalRequests);
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(result.sessions.length);
    expect(result.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'local', sourceLabel: 'This machine' }),
      expect.objectContaining({ sourceId: 'remote', sourceLabel: 'Remote laptop', id: 'remote:same-session' }),
    ]));
    expect(result.sessions.find((session) => session.sourceId === 'remote')).not.toHaveProperty('filename');
    expect(result.instance.capabilities.outboundTargets).toEqual([{ id: 'claw', label: 'claw' }]);
  });

  it('always prefixes raw IDs, including IDs that already contain the source prefix', () => {
    const files = namespaceFileContributions({
      first: { session: { id: 'same' } },
      second: { session: { id: 'local:same' } },
    }, 'local', 'Local');

    expect(files['local:first'].session.id).toBe('local:same');
    expect(files['local:second'].session.id).toBe('local:local:same');
  });

  it('keeps configured-but-missing imports visible as empty source stats', async () => {
    await setup({ withImport: false, missingImport: true });
    const result = await getStats({ waitForRefresh: true });

    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'missing', kind: 'imported', status: 'missing' }),
    ]));
    expect(result.statsBySource.missing.summary.totalTokens).toBe(0);
  });

  it('marks imports stale at lastReceivedAt plus the local interval while retaining them in All', async () => {
    await setup();
    const result = await getStats({ waitForRefresh: true });
    const remote = result.sources.find((source) => source.id === 'remote');

    expect(remote.lastReceivedAt).toBe('2026-04-20T00:00:00.000Z');
    expect(remote.generatedAt).toBe('2026-04-20T00:00:00.000Z');
    expect(remote.staleSince).toBe('2026-04-20T01:00:00.000Z');
    expect(remote.status).toBe('stale');
    expect(result.statsBySource.remote.summary.totalTokens).toBeGreaterThan(0);
  });

  it('observes imported replacement and removal on the next request', async () => {
    const ws = await setup();
    const first = await getStats({ waitForRefresh: true });
    const firstFresh = await getStats({ waitForRefresh: true });
    expect(firstFresh.generatedAt).toBe(first.generatedAt);
    expect(firstFresh.statsBySource.local.generatedAt).toBe(first.generatedAt);
    expect(firstFresh.sources.find((source) => source.id === 'local').generatedAt)
      .toBe(first.generatedAt);
    expect(firstFresh.cache.combinedRevision).toBe(first.cache.combinedRevision);
    expect(first.sources.find((source) => source.id === 'remote').revision)
      .toBe('remote-revision');
    const path = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const beforeBytes = readFileSync(path);
    const replaced = importedSnapshot();
    replaced.revision = 'remote-revision-2';
    replaced.contributions[0].buckets[0].usage.totalTokens = 99;
    writeFileSync(path, JSON.stringify(replaced));

    const second = await getStats({ waitForRefresh: true });
    expect(second.statsBySource.remote.summary.totalTokens)
      .toBe(first.statsBySource.remote.summary.totalTokens - 15 + 99);
    expect(second.cache.revision).toBe(first.cache.revision);
    expect(second.cache.sourceId).toBe(first.cache.sourceId);
    expect(second.cache.combinedRevision).not.toBe(first.cache.combinedRevision);
    expect(readFileSync(path)).not.toEqual(beforeBytes);

    unlinkSync(path);
    const third = await getStats({ waitForRefresh: true });
    expect(third.sources.find((source) => source.id === 'remote').status).toBe('missing');
    expect(third.statsBySource.remote.summary.totalTokens).toBe(0);
    expect(third.cache.combinedRevision).not.toBe(second.cache.combinedRevision);
  });

  it('changes combined freshness when imported content changes under stable metadata', async () => {
    const ws = await setup();
    const path = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const receivedAt = new Date('2026-04-20T00:00:00.000Z');
    const first = await getStats({ waitForRefresh: true });
    const replacement = importedSnapshot();
    replacement.contributions[0].buckets[0].usage.totalTokens = 77;
    writeFileSync(path, JSON.stringify(replacement));
    utimesSync(path, receivedAt, receivedAt);

    const second = await getStats({ waitForRefresh: true });
    expect(second.statsBySource.remote.summary.totalTokens)
      .toBe(first.statsBySource.remote.summary.totalTokens - 15 + 77);
    expect(second.cache.combinedRevision).not.toBe(first.cache.combinedRevision);
  });

  it('changes combined freshness when only the configured local source identity changes', async () => {
    const ws = await setup();
    const first = await getStats({ waitForRefresh: true });
    const config = JSON.parse(readFileSync(join(ws.configDir, 'openclaw-usage-sync.json'), 'utf8'));
    config.source = { id: 'other', label: 'Other machine' };
    writeFileSync(join(ws.configDir, 'openclaw-usage-sync.json'), JSON.stringify(config));

    const second = await getStats({ waitForRefresh: true });
    expect(Object.hasOwn(second.statsBySource, 'other')).toBe(true);
    expect(second.cache.combinedRevision).not.toBe(first.cache.combinedRevision);
  });

  it('canonicalizes bucket order with locale-independent Unicode ordering', async () => {
    const ws = await setup();
    const path = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const receivedAt = new Date('2026-04-20T00:00:00.000Z');
    const firstSnapshot = importedSnapshot();
    const composed = { ...firstSnapshot.contributions[0].buckets[0], provider: '\u00e9' };
    const decomposed = { ...firstSnapshot.contributions[0].buckets[0], provider: 'e\u0301' };
    firstSnapshot.contributions[0].buckets = [composed, decomposed];
    writeFileSync(path, JSON.stringify(firstSnapshot));
    utimesSync(path, receivedAt, receivedAt);
    const first = await getStats({ waitForRefresh: true });

    const reversed = {
      ...firstSnapshot,
      contributions: [{
        ...firstSnapshot.contributions[0],
        buckets: [decomposed, composed],
      }],
    };
    writeFileSync(path, JSON.stringify(reversed));
    utimesSync(path, receivedAt, receivedAt);
    const second = await getStats({ waitForRefresh: true });
    expect(second.statsBySource.remote.summary).toEqual(first.statsBySource.remote.summary);
    expect(second.cache.combinedRevision).toBe(first.cache.combinedRevision);

    const changed = {
      ...reversed,
      contributions: [{
        ...reversed.contributions[0],
        buckets: [{ ...decomposed, usage: { ...decomposed.usage, totalTokens: 16 } }, composed],
      }],
    };
    writeFileSync(path, JSON.stringify(changed));
    utimesSync(path, receivedAt, receivedAt);
    const third = await getStats({ waitForRefresh: true });
    expect(third.cache.combinedRevision).not.toBe(second.cache.combinedRevision);
  });

  it('retains adversarial imported provider rows without mutating Object.prototype', async () => {
    const ws = await setup();
    const importPath = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const originalKeys = Object.getOwnPropertyNames(Object.prototype);
    const snapshot = importedSnapshot('__proto__');
    snapshot.contributions.push({
      ...importedSnapshot('constructor').contributions[0],
      contributionId: 'opaque-constructor',
    });
    snapshot.contributions.push({
      ...importedSnapshot('toString').contributions[0],
      contributionId: 'opaque-to-string',
    });
    writeFileSync(importPath, JSON.stringify(snapshot));

    const result = await getStats({ waitForRefresh: true });
    const providers = result.statsBySource.remote.byProvider;
    expect(Object.hasOwn(providers, '__proto__')).toBe(true);
    expect(Object.hasOwn(providers, 'constructor')).toBe(true);
    expect(Object.hasOwn(providers, 'toString')).toBe(true);
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(originalKeys);
    expect(Object.prototype.input).toBeUndefined();
  });

  it('recalculates local, imported, and combined costs with one receiver price', async () => {
    const ws = await setup();
    const importPath = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const beforeSnapshot = readFileSync(importPath);
    const before = await getStats({ waitForRefresh: true });
    const beforeLocal = before.statsBySource.local.byModel['openai/gpt-4o'].totalCost;
    const beforeRemote = before.statsBySource.remote.byModel['openai/gpt-4o'].totalCost;

    await updatePricingConfig({
      version: '1.0',
      enabled: true,
      updated: '2026-04-20T00:01:00.000Z',
      pricing: { 'openai/gpt-4o': { input: 3, output: 4 } },
    });
    const after = await getStats({ waitForRefresh: true });
    const afterLocal = after.statsBySource.local.byModel['openai/gpt-4o'].totalCost;
    const afterRemote = after.statsBySource.remote.byModel['openai/gpt-4o'].totalCost;

    expect(afterLocal).not.toBe(beforeLocal);
    expect(afterRemote).not.toBe(beforeRemote);
    expect(after.summary.totalCost).toBeCloseTo(afterLocal + afterRemote +
      Object.values(after.statsBySource.local.byModel)
        .filter((row) => row.provider !== 'openai' || row.model !== 'gpt-4o')
        .reduce((sum, row) => sum + row.totalCost, 0) +
      Object.values(after.statsBySource.remote.byModel)
        .filter((row) => row.provider !== 'openai' || row.model !== 'gpt-4o')
        .reduce((sum, row) => sum + row.totalCost, 0), 12);
    expect(readFileSync(importPath)).toEqual(beforeSnapshot);
  });
});

describe('multi-source HTTP and MCP integration', () => {
  it('returns safe sync config/status and backward-compatible combined stats', async () => {
    await setup();
    const app = createApp({ staticDir: join(process.cwd(), 'dist-does-not-exist') });
    const config = await request(app).get('/api/sync/config').expect(200);
    expect(Object.keys(config.body).sort()).toEqual(['capabilities', 'settings', 'source', 'version']);
    expect(config.body.capabilities.outboundTargets).toEqual([{ id: 'claw', label: 'claw' }]);
    expect(JSON.stringify(config.body)).not.toContain('ssh-secret-alias');
    expect(JSON.stringify(config.body)).not.toContain('openclaw-usage-sync.json');

    const status = await request(app).get('/api/sync/status').expect(200);
    expect(Object.keys(status.body).sort()).toEqual([
      'configuredTargetId', 'enabled', 'error', 'failureSince', 'lastAttempt',
      'lastSuccess', 'outboundTargets', 'targetId', 'version',
    ]);
    expect(status.body).toHaveProperty('lastSuccess');
    expect(JSON.stringify(status.body)).not.toContain('ssh-secret-alias');

    const stats = await request(app).get('/api/stats').expect(200);
    expect(stats.body.summary).toBeDefined();
    expect(stats.body.statsBySource.remote.summary.totalTokens).toBeGreaterThan(0);
  });

  it('returns the public settings projection with exact keys and rejects sensitive fields', async () => {
    await setup();
    const app = createApp({ staticDir: join(process.cwd(), 'dist-does-not-exist') });
    const settings = await request(app)
      .put('/api/sync/settings')
      .set('Content-Type', 'application/json')
      .send({ enabled: false, targetId: null, intervalMinutes: 30, label: 'Local renamed' })
      .expect(200);
    expect(Object.keys(settings.body).sort()).toEqual(['capabilities', 'settings', 'source', 'version']);

    for (const [method, path] of [['post', '/api/sync/run'], ['post', '/api/sync/test']]) {
      const response = await request(app)[method](path)
        .set('Content-Type', 'application/json')
        .send({ targetId: 'claw', sshAlias: 'leak' })
        .expect(400);
      expect(Object.keys(response.body).sort()).toEqual(['code', 'error']);
      expect(JSON.stringify(response.body)).not.toContain('leak');
    }
  });

  it('enforces exact safe write bodies and same-origin JSON guard for sync actions', async () => {
    await setup();
    const app = createApp({ staticDir: join(process.cwd(), 'dist-does-not-exist') });

    const extra = await request(app)
      .put('/api/sync/settings')
      .set('Content-Type', 'application/json')
      .send({ enabled: true, sshAlias: 'secret' })
      .expect(400);
    expect(extra.body.code).toBe('SYNC_SETTINGS_INVALID');
    expect(extra.body.error).not.toContain('secret');

    for (const [method, path] of [
      ['put', '/api/sync/settings'],
      ['post', '/api/sync/run'],
      ['post', '/api/sync/test'],
    ]) {
      const crossSite = await request(app)[method](path)
        .set('Origin', 'https://evil.example')
        .set('Content-Type', 'application/json')
        .send({ targetId: 'claw' })
        .expect(403);
      expect(crossSite.body.error).toMatch(/cross-origin/i);
      await request(app)[method](path)
        .send('{"targetId":"claw"}')
        .expect(415);
    }

    const run = await request(app)
      .post('/api/sync/run')
      .set('Content-Type', 'application/json')
      .send({ targetId: 'unknown;rm -rf /' })
      .expect(400);
    expect(run.body.code).toBe('SYNC_TARGET_NOT_ALLOWED');
    expect(JSON.stringify(run.body)).not.toContain('ssh-secret-alias');

    const test = await request(app)
      .post('/api/sync/test')
      .set('Content-Type', 'application/json')
      .send({ targetId: null })
      .expect(400);
    expect(test.body.code).toBe('SYNC_TARGET_INVALID');
  });

  it('keeps raw local UUID lookup working without a sync config', async () => {
    const ws = await setup();
    unlinkSync(join(ws.configDir, 'openclaw-usage-sync.json'));
    const handlers = createMcpServer().__handlers;
    const stats = await getStats({ waitForRefresh: true });
    const rawId = stats.statsBySource.local.sessions[0].id;
    expect(rawId).not.toContain(':');
    expect(stats.sessions[0].id).toBe(rawId);
    const response = await handlers.callTool({
      params: { name: 'get_session_stats', arguments: { sessionId: rawId } },
    });
    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0].text).id).toBe(rawId);
  });

  it('does not expose null or non-finite totals when an unsafe import is present', async () => {
    const ws = await setup();
    const importPath = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const unsafe = importedSnapshot();
    unsafe.contributions[0].buckets[0].usage.input = 1e308;
    unsafe.contributions[0].buckets[0].usage.totalTokens = 1e308;
    writeFileSync(importPath, JSON.stringify(unsafe));

    const app = createApp({ staticDir: join(process.cwd(), 'dist-does-not-exist') });
    const response = await request(app).get('/api/stats?fresh=1').expect(200);
    expect(response.body.statsBySource.remote.summary.totalInput).toBe(0);
    expect(response.body.statsBySource.remote.summary.totalTokens).toBe(0);
    for (const value of Object.values(response.body.summary)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    for (const summary of [response.body.summary, response.body.statsBySource.local.summary, response.body.statsBySource.remote.summary]) {
      for (const field of ['totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheWrite', 'totalTokens', 'totalCost', 'totalRequests', 'totalSessions']) {
        expect(summary[field]).not.toBeNull();
        expect(Number.isFinite(summary[field])).toBe(true);
      }
    }
  });

  it('fails closed when a raw session ID is ambiguous across sources', async () => {
    const ws = await setup();
    const first = await getStats({ waitForRefresh: true });
    const rawId = first.statsBySource.local.sessions[0].id.replace(/^local:/, '');
    const importPath = join(ws.configDir, 'cache/openclaw-usage/imports/remote.json');
    const snapshot = importedSnapshot();
    snapshot.contributions[0].session.id = rawId;
    writeFileSync(importPath, JSON.stringify(snapshot));

    const response = await createMcpServer().__handlers.callTool({
      params: { name: 'get_session_stats', arguments: { sessionId: rawId } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/not found/i);
  });

  it('keeps MCP tools on combined stats without adding a source filter', async () => {
    await setup();
    const handlers = createMcpServer().__handlers;
    const listed = await handlers.listTools();
    expect(listed.tools.find((tool) => tool.name === 'get_total_usage').inputSchema.properties).toEqual({});
    const response = await handlers.callTool({ params: { name: 'get_total_usage', arguments: {} } });
    const summary = JSON.parse(response.content[0].text);
    const stats = await getStats({ waitForRefresh: true });
    expect(summary.totalTokens).toBe(stats.summary.totalTokens);
  });
});
