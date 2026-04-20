import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import {
  listOpenClawPricedModels,
  listUnpricedModels,
} from '../../../openclaw-config.js';

const disposables = [];
afterEach(async () => {
  while (disposables.length) await disposables.pop()();
});

describe('openclaw-config list*Models', () => {
  it('returns [] when models.json is missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    expect(await listOpenClawPricedModels()).toEqual([]);
    expect(await listUnpricedModels()).toEqual([]);
  });

  it('splits priced vs unpriced from synth fixture', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyFileSync(fixturePath('models', 'models.synth.json'), join(ws.agentDir, 'models.json'));

    const priced = await listOpenClawPricedModels();
    const unpriced = await listUnpricedModels();

    expect(priced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-4o']);
    expect(unpriced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-mini-unpriced']);
  });

  it('produces non-empty lists from the redacted real models.json', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    copyFileSync(fixturePath('models', 'models.real.json'), join(ws.agentDir, 'models.json'));

    const priced = await listOpenClawPricedModels();
    const unpriced = await listUnpricedModels();

    expect(Array.isArray(priced)).toBe(true);
    expect(Array.isArray(unpriced)).toBe(true);
    expect(priced.length + unpriced.length).toBeGreaterThan(0);
    for (const row of priced) {
      expect(typeof row.provider).toBe('string');
      expect(typeof row.model).toBe('string');
      expect(typeof row.cost.input).toBe('number');
    }
  });

  it('treats unparseable models.json as empty', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ws.agentDir, 'models.json'), '{ this is not valid json', 'utf-8');

    expect(await listOpenClawPricedModels()).toEqual([]);
    expect(await listUnpricedModels()).toEqual([]);
  });
});
