import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

describe('createTmpWorkspace', () => {
  it('creates agent & workspace directories and injects env vars', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    expect(existsSync(ws.agentDir)).toBe(true);
    expect(existsSync(ws.sessionsDir)).toBe(true);
    expect(process.env.OPENCLAW_CONFIG_DIR).toBe(ws.configDir);
    expect(process.env.OPENCLAW_DIR).toBe(ws.workspaceDir);
    expect(ws.dbPath).toBe(join(ws.agentDir, 'openclaw-agent.sqlite'));
  });

  it('execSql creates minimal schema and inserts rows', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    ws.execSql(`
      INSERT INTO transcript_events VALUES
        ('s1', 1, '{"type":"message"}', 1782801600000);
      INSERT INTO session_windows VALUES
        ('s1', 'k1', 'done', 1782801600000, 1782801600000, 1782801600000);
    `);

    const db = new DatabaseSync(ws.dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) c FROM transcript_events').get().c).toBe(1);
      expect(db.prepare('SELECT status FROM session_windows WHERE session_id = ?').get('s1').status).toBe('done');
    } finally {
      db.close();
    }
  });

  it('copyFixtureDb copies the real redacted sample', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    ws.copyFixtureDb(fixturePath('db', 'openclaw-agent.sqlite'));
    const db = new DatabaseSync(ws.dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) c FROM transcript_events').get().c).toBeGreaterThan(0);
      expect(db.prepare('SELECT COUNT(*) c FROM session_transcript_archives').get().c).toBe(9);
    } finally {
      db.close();
    }
  });

  it('writeModelsJson writes openclaw.json under config root', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    ws.writeModelsJson({ models: { providers: {} } });
    const path = join(ws.configDir, 'openclaw.json');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ models: { providers: {} } });
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
