import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
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
