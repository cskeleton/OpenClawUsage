import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildArchiveSnapshot } from '../../../scripts/import-session-archive.js';

const disposables = [];
afterEach(async () => { while (disposables.length) await disposables.pop()(); });

async function makeConfigDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ocu-archive-import-'));
  disposables.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function usageLine({ provider = 'bohe', model = 'deepseek-v4-flash', input = 100, output = 50, total = 150, timestamp }) {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      provider,
      model,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: total,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
    },
  });
}

describe('import-session-archive buildArchiveSnapshot', () => {
  it('aggregates archived sessions into day buckets and skips trajectory variants', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.jsonl.imported-1788177078527`), [
      usageLine({ timestamp: '2026-07-26T06:59:26.246Z' }),
      usageLine({ timestamp: '2026-07-26T07:10:00.000Z' }),
      usageLine({ provider: 'openclaw', timestamp: '2026-07-26T07:11:00.000Z' }), // 内部镜像过滤
      JSON.stringify({ type: 'other', message: {} }), // 非 message 行
      usageLine({ input: 0, output: 0, total: 0, timestamp: '2026-07-26T07:12:00.000Z' }), // 零用量过滤
      usageLine({ model: 'kimi-k3', timestamp: '2026-07-27T01:00:00.000Z' }),
      '',
    ].join('\n'));
    // trajectory 变体不得被解析
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.trajectory.jsonl.imported-1788177078527`),
      usageLine({ timestamp: '2026-07-26T08:00:00.000Z' }));

    const { snapshot, stats } = await buildArchiveSnapshot({ configDir });
    expect(stats.imported).toBe(1);
    expect(snapshot.contributions).toHaveLength(1);
    const c = snapshot.contributions[0];
    expect(c.session).toEqual({
      id: UUID_A,
      status: 'done',
      archivedAt: new Date(1788177078527).toISOString(),
    });
    expect(c.firstTimestamp).toBe('2026-07-26T06:59:26.246Z');
    expect(c.lastTimestamp).toBe('2026-07-27T01:00:00.000Z');
    const d1 = c.buckets.find((b) => b.date === '2026-07-26');
    expect(d1.usage.totalTokens).toBe(300); // 两条有效 usage 求和
    expect(d1.requests).toBe(2);
    expect(d1.openclawCost.total).toBeCloseTo(0.06);
    const d2 = c.buckets.find((b) => b.date === '2026-07-27');
    expect(d2.model).toBe('kimi-k3');
    // 快照自检通过（buildArchiveSnapshot 内部已 validateSourceSnapshot）
    expect(snapshot.source.id).toBe('archive-import');
  });

  it('skips sessions already present in the agent SQLite DB', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    const agentDbDir = join(configDir, 'agents', 'main', 'agent');
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(agentDbDir, { recursive: true });
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.jsonl.imported-1788177078527`),
      usageLine({ timestamp: '2026-07-26T06:59:26.246Z' }));
    writeFileSync(join(archiveDir, `agent_main_y.${UUID_B}.jsonl.imported-1788177078527`),
      usageLine({ timestamp: '2026-08-01T00:00:00.000Z' }));

    // UUID_A 已在 DB 中
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(agentDbDir, 'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT)');
    db.prepare('INSERT INTO transcript_events VALUES (?, 1, 1, ?)').run(UUID_A, '{}');
    db.close();

    const { stats } = await buildArchiveSnapshot({ configDir });
    expect(stats.archivedSessions).toBe(2);
    expect(stats.skippedKnown).toBe(1);
    expect(stats.imported).toBe(1);
  });

  it('skips sessions frozen as legacy contributions in the persistent cache', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    const cacheDir = join(configDir, 'cache', 'openclaw-usage');
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.jsonl.imported-1788177078527`),
      usageLine({ timestamp: '2026-07-26T06:59:26.246Z' }));
    writeFileSync(join(cacheDir, 'stats-v2.json'), JSON.stringify({
      files: { 'legacy:old.jsonl': { session: { id: UUID_A } } },
    }));

    const { stats } = await buildArchiveSnapshot({ configDir });
    expect(stats.skippedKnown).toBe(1);
    expect(stats.imported).toBe(0);
  });

  it('skips zero-usage sessions entirely', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.jsonl.imported-1788177078527`),
      usageLine({ input: 0, output: 0, total: 0, timestamp: '2026-07-26T06:59:26.246Z' }));

    const { snapshot, stats } = await buildArchiveSnapshot({ configDir });
    expect(stats.empty).toBe(1);
    expect(snapshot.contributions).toHaveLength(0);
  });

  it('imports Matrix topic sessions with -topic- suffix in the filename', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, `agent_main_matrix_direct_x_thread_y.${UUID_A}-topic-_24ABCdef.jsonl.imported-1788177078528`),
      usageLine({ timestamp: '2026-07-25T07:24:56.759Z' }),
    );

    const { snapshot, stats } = await buildArchiveSnapshot({ configDir });
    expect(stats.imported).toBe(1);
    expect(snapshot.contributions[0].session.id).toBe(UUID_A);
  });

  it('is idempotent: contribution ids are stable across runs', async () => {
    const configDir = await makeConfigDir();
    const archiveDir = join(configDir, 'agents', 'main', 'session-sqlite-import-archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `agent_main_x.${UUID_A}.jsonl.imported-1788177078527`),
      usageLine({ timestamp: '2026-07-26T06:59:26.246Z' }));

    const a = await buildArchiveSnapshot({ configDir });
    const b = await buildArchiveSnapshot({ configDir });
    expect(a.snapshot.contributions[0].contributionId).toBe(b.snapshot.contributions[0].contributionId);
    // 纯函数：不产生任何磁盘写入
    expect(existsSync(join(configDir, 'cache'))).toBe(false);
  });
});
