import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../helpers/tmp-workspace.js';
import {
  loadSyncConfig,
  updateSyncSettings,
  getPublicSyncConfig,
} from '../../sync-config.js';

const disposables = [];

afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

function configFor(overrides = {}) {
  return {
    version: 1,
    source: { id: 'mbp', label: 'MBP' },
    policy: {
      allowedSshTargets: {
        claw: { label: 'claw', sshAlias: 'claw' },
      },
    },
    settings: { enabled: true, targetId: 'claw', intervalMinutes: 60 },
    imports: { allowedSourceIds: [] },
    ...overrides,
  };
}

describe('sync configuration', () => {
  it('returns a valid disabled single-source default when the file is missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    await expect(loadSyncConfig()).resolves.toEqual({
      version: 1,
      source: { id: 'local', label: 'Local' },
      policy: { allowedSshTargets: {} },
      settings: { enabled: false, targetId: null, intervalMinutes: 60 },
      imports: { allowedSourceIds: [] },
    });
  });

  it('rejects unsafe source, target, and SSH alias identifiers', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    for (const id of ['bad id', '../escape', 'bad;command', '']) {
      writeFileSync(
        join(ws.configDir, 'openclaw-usage-sync.json'),
        JSON.stringify(configFor({ source: { id, label: 'MBP' } }))
      );
      await expect(loadSyncConfig()).rejects.toThrow(/invalid sync config/i);
    }

    writeFileSync(
      join(ws.configDir, 'openclaw-usage-sync.json'),
      JSON.stringify(
        configFor({
          policy: { allowedSshTargets: { 'bad id': { label: 'bad', sshAlias: 'claw' } } },
        })
      )
    );
    await expect(loadSyncConfig()).rejects.toThrow(/invalid sync config/i);

    writeFileSync(
      join(ws.configDir, 'openclaw-usage-sync.json'),
      JSON.stringify(
        configFor({
          policy: { allowedSshTargets: { claw: { label: 'claw', sshAlias: 'claw;id' } } },
        })
      )
    );
    await expect(loadSyncConfig()).rejects.toThrow(/invalid sync config/i);
  });

  it('requires targetId membership to be an own policy property', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const configPath = join(ws.configDir, 'openclaw-usage-sync.json');

    for (const targetId of ['constructor', 'toString', '__defineGetter__']) {
      writeFileSync(
        configPath,
        JSON.stringify(configFor({
          policy: { allowedSshTargets: {} },
          settings: { enabled: true, targetId, intervalMinutes: 60 },
        }))
      );
      await expect(loadSyncConfig()).rejects.toThrow(/invalid sync config/i);
    }

    writeFileSync(
      configPath,
      JSON.stringify(configFor({
        policy: { allowedSshTargets: {} },
        settings: { enabled: false, targetId: null, intervalMinutes: 60 },
      }))
    );
    for (const targetId of ['constructor', 'toString', '__defineGetter__']) {
      await expect(updateSyncSettings({ targetId })).rejects.toThrow(/invalid sync target/i);
    }
  });

  it('updates only public-safe settings and writes a private atomic config', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    writeFileSync(join(ws.configDir, 'openclaw-usage-sync.json'), JSON.stringify(configFor()));

    const updated = await updateSyncSettings({ enabled: false, targetId: null, intervalMinutes: 120, label: 'Laptop' });
    expect(updated.source).toEqual({ id: 'mbp', label: 'Laptop' });
    expect(updated.settings).toEqual({ enabled: false, targetId: null, intervalMinutes: 120 });

    const configPath = join(ws.configDir, 'openclaw-usage-sync.json');
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      ...configFor(),
      source: { id: 'mbp', label: 'Laptop' },
      settings: { enabled: false, targetId: null, intervalMinutes: 120 },
    });
  });

  it('rejects policy/source/import mutations and does not write them', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const configPath = join(ws.configDir, 'openclaw-usage-sync.json');
    writeFileSync(configPath, JSON.stringify(configFor()));
    const before = readFileSync(configPath, 'utf8');

    for (const patch of [
      { policy: {} },
      { source: { id: 'other' } },
      { imports: { allowedSourceIds: ['other'] } },
      { sshAlias: 'other' },
    ]) {
      await expect(updateSyncSettings(patch)).rejects.toThrow(/unknown sync setting/i);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('projects capabilities without exposing policy aliases or configuration paths', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    writeFileSync(
      join(ws.configDir, 'openclaw-usage-sync.json'),
      JSON.stringify(
        configFor({
          imports: { allowedSourceIds: ['claw'] },
        })
      )
    );

    const publicConfig = await getPublicSyncConfig();
    expect(publicConfig).toEqual({
      version: 1,
      source: { id: 'mbp', label: 'MBP' },
      settings: { enabled: true, targetId: 'claw', intervalMinutes: 60 },
      capabilities: {
        canExport: true,
        canImport: true,
        canSync: true,
        outboundTargets: [{ id: 'claw', label: 'claw' }],
        importedSourceIds: ['claw'],
      },
    });
    expect(JSON.stringify(publicConfig)).not.toContain('sshAlias');
    expect(JSON.stringify(publicConfig)).not.toContain(ws.configDir);
    expect(publicConfig.policy).toBeUndefined();
  });
});
