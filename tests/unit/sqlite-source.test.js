import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  getSqlitePath,
  extractUsageRecord,
  scanSqliteManifest,
  buildSqliteContributions,
  listSqliteSessionIds,
} from '../../sqlite-source.js';
import { createTmpWorkspace } from '../helpers/tmp-workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = join(__dirname, '..', 'fixtures', 'db', 'openclaw-agent.sqlite');

/** 最小事件构造器：message + usage */
function messageEvent({ provider = 'openai', model = 'gpt-test', seq = 1, ts = '2026-09-01T10:00:00.000Z', usage } = {}) {
  return {
    type: 'message',
    id: `evt-${seq}`,
    timestamp: ts,
    message: {
      role: 'assistant',
      provider,
      model,
      usage: usage || { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } },
    },
  };
}

describe('sqlite-source extractUsageRecord', () => {
  it('extracts usage from a message event', () => {
    const rec = extractUsageRecord(JSON.stringify(messageEvent({})));
    expect(rec.provider).toBe('openai');
    expect(rec.model).toBe('gpt-test');
    expect(rec.usage.input).toBe(100);
    expect(rec.openclawCost.total).toBe(0.0012);
    expect(rec.timestamp).toBe('2026-09-01T10:00:00.000Z');
  });

  it('filters openclaw internal mirror messages', () => {
    const ev = messageEvent({ provider: 'openclaw' });
    expect(extractUsageRecord(JSON.stringify(ev))).toBeNull();
  });

  it('filters non-message events and missing usage', () => {
    expect(extractUsageRecord('{"type":"session","version":3}')).toBeNull();
    expect(extractUsageRecord('{"type":"message","message":{"role":"user"}}')).toBeNull();
    expect(extractUsageRecord('not-json')).toBeNull();
  });
});

describe('sqlite-source manifest & contributions', () => {
  let ws;
  beforeEach(async () => {
    ws = await createTmpWorkspace();
  });
  afterEach(async () => {
    await ws.cleanup();
  });

  it('reports exists:false when the database is missing', () => {
    const manifest = scanSqliteManifest();
    expect(manifest.exists).toBe(false);
    expect(manifest.sessions).toEqual({});
    expect(listSqliteSessionIds()).toBeNull();
    expect(getSqlitePath()).toBe(join(ws.configDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
  });

  it('builds sessions/archives manifest with identity quadruples', () => {
    ws.execSql(`
      INSERT INTO transcript_events VALUES
        ('sess-a', 1, '${JSON.stringify(messageEvent({ seq: 1 }))}', 1783000000000),
        ('sess-a', 2, '${JSON.stringify(messageEvent({ seq: 2 }))}', 1783000001000);
      INSERT INTO session_windows VALUES
        ('sess-a', 'agent:main:main', 'done', 1783000000000, 1783000001000, 1783000001000);
      INSERT INTO session_transcript_archives VALUES
        ('sess-b', 'deadbeef', 'agent:main:old', 'deleted', 'identity', X'7b7d', 'sha', 'arch-b', 1783000002000, NULL);
    `);

    const manifest = scanSqliteManifest();
    expect(manifest.exists).toBe(true);
    expect(manifest.identity.schemaVersion).toBeGreaterThan(0);
    expect(manifest.sessions['sess-a']).toEqual({
      events: 2,
      maxSeq: 2,
      lastCreatedAt: 1783000001000,
      watermark: 1783000001000,
    });
    expect(Object.keys(manifest.archives)).toEqual(['sess-b@deadbeef']);
    expect(manifest.archives['sess-b@deadbeef'].reason).toBe('deleted');
  });

  it('builds active contributions with window status mapping', async () => {
    ws.execSql(`
      INSERT INTO transcript_events VALUES
        ('sess-run', 1, '${JSON.stringify(messageEvent({ provider: 'p1', model: 'm1' }))}', 1783000000000),
        ('sess-run', 2, '${JSON.stringify(messageEvent({ provider: 'p1', model: 'm1' }))}', 1783000000100),
        ('sess-done', 1, '${JSON.stringify(messageEvent({ provider: 'p2', model: 'm2' }))}', 1783000000000);
      INSERT INTO session_windows VALUES
        ('sess-run', 'k1', 'running', 1783000000000, 1783000000100, 1783000000100),
        ('sess-done', 'k2', 'failed', 1783000000000, 1783000000000, 1783000000000);
    `);

    const { contributions } = await buildSqliteContributions(
      { added: ['sess-run', 'sess-done'], changed: [], removed: [] },
      { added: [], changed: [], removed: [] }
    );

    expect(Object.keys(contributions).sort()).toEqual(['sqlite:sess-done', 'sqlite:sess-run']);
    expect(contributions['sqlite:sess-run'].session.status).toBe('active');
    expect(contributions['sqlite:sess-done'].session.status).toBe('done');
    // missing window → active
    expect(contributions['sqlite:sess-run'].buckets).toHaveLength(1);
    expect(contributions['sqlite:sess-run'].buckets[0].requests).toBe(2);
    expect(contributions['sqlite:sess-run'].hasRecords).toBe(true);
  });

  it('parses identity-encoded archives as deleted sessions', async () => {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-arch', timestamp: '2026-08-31T19:00:00.000Z' }),
      JSON.stringify(messageEvent({ provider: 'px', model: 'mx', ts: '2026-08-31T19:00:01.000Z' })),
    ].join('\n');
    const blobHex = Buffer.from(lines, 'utf-8').toString('hex');
    ws.execSql(`
      INSERT INTO session_transcript_archives VALUES
        ('sess-arch', 'cafe01', 'k', 'deleted', 'identity', X'${blobHex}', 'sha', 'arch', 1783000000000, NULL);
    `);

    const { contributions } = await buildSqliteContributions(
      { added: [], changed: [], removed: [] },
      { added: ['sess-arch@cafe01'], changed: [], removed: [] }
    );

    const c = contributions['sqlite-archive:sess-arch@cafe01'];
    expect(c).toBeDefined();
    expect(c.session.status).toBe('deleted');
    expect(c.hasRecords).toBe(true);
    expect(c.buckets[0].provider).toBe('px');
    expect(c.firstTimestamp).toBe('2026-08-31T19:00:01.000Z');
  });

  it('degrades to empty manifest when the db file has no schema', () => {
    // 0 字节 db 文件：openSqliteReadOnly 能打开，但表不存在
    writeFileSync(ws.dbPath, '');
    const manifest = scanSqliteManifest();
    expect(manifest.exists).toBe(true);
    expect(manifest.sessions).toEqual({});
    expect(manifest.archives).toEqual({});
    // listSqliteSessionIds 同样不应抛错
    const ids = listSqliteSessionIds();
    expect(ids).not.toBeNull();
    expect(ids.size).toBe(0);
  });

  it('skips a corrupt archive without failing the whole build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodLines = JSON.stringify(messageEvent({ provider: 'px', model: 'mx' }));
    const goodHex = Buffer.from(goodLines, 'utf-8').toString('hex');
    ws.execSql(`
      INSERT INTO session_transcript_archives VALUES
        ('sess-ok', 'cafe01', 'k', 'deleted', 'identity', X'${goodHex}', 'sha', 'arch-ok', 1783000000000, NULL),
        ('sess-bad', 'cafe02', 'k', 'reset', 'zstd', X'deadbeef', 'sha', 'arch-bad', 1783000000000, NULL);
    `);

    const { contributions } = await buildSqliteContributions(
      { added: [], changed: [], removed: [] },
      { added: ['sess-ok@cafe01', 'sess-bad@cafe02'], changed: [], removed: [] }
    );

    expect(contributions['sqlite-archive:sess-ok@cafe01']).toBeDefined();
    expect(contributions['sqlite-archive:sess-bad@cafe02']).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lists active + archived session ids for legacy dedup', () => {
    ws.execSql(`
      INSERT INTO transcript_events VALUES
        ('sess-a', 1, '${JSON.stringify(messageEvent({}))}', 1783000000000);
      INSERT INTO session_transcript_archives VALUES
        ('sess-b', 'deadbeef', 'k', 'reset', 'identity', X'7b7d', 'sha', 'arch-b', 1783000002000, NULL);
    `);
    const ids = listSqliteSessionIds();
    expect(ids.has('sess-a')).toBe(true);
    expect(ids.has('sess-b')).toBe(true);
  });

  it('works against the real redacted fixture db', async () => {
    ws.copyFixtureDb(FIXTURE_DB);
    const manifest = scanSqliteManifest();
    expect(manifest.exists).toBe(true);
    expect(Object.keys(manifest.sessions).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(manifest.archives).length).toBe(9);

    const { contributions } = await buildSqliteContributions(
      {
        added: Object.keys(manifest.sessions),
        changed: [],
        removed: [],
      },
      {
        added: Object.keys(manifest.archives),
        changed: [],
        removed: [],
      }
    );
    const totalRequests = Object.values(contributions).reduce(
      (sum, c) => sum + c.buckets.reduce((s, b) => s + b.requests, 0),
      0
    );
    expect(totalRequests).toBeGreaterThan(0);

    // fixture 含非 UUID 会话
    const namedKey = Object.keys(contributions).find((k) => k.includes('research-'));
    expect(namedKey).toBeDefined();
  });
});
