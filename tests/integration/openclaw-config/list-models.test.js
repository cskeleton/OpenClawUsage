import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
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
  it('returns [] when openclaw.json is missing', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);

    expect(await listOpenClawPricedModels()).toEqual([]);
    expect(await listUnpricedModels()).toEqual([]);
  });

  it('splits priced vs unpriced from models.providers', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    ws.writeModelsJson({
      models: {
        providers: {
          openai: {
            models: [
              { id: 'gpt-4o', name: 'GPT-4o', cost: { input: 2.5, output: 10 } },
            ],
          },
          another: {
            models: [
              { id: 'gpt-mini-unpriced', name: 'Mini' },
            ],
          },
        },
      },
    });

    const priced = await listOpenClawPricedModels();
    const unpriced = await listUnpricedModels();

    expect(priced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-4o']);
    expect(unpriced.map((r) => `${r.provider}/${r.model}`)).toEqual(['another/gpt-mini-unpriced']);
  });

  it('accepts the legacy top-level providers shape as a fallback', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    ws.writeModelsJson({
      providers: {
        openai: {
          models: [
            { id: 'gpt-4o', name: 'GPT-4o', cost: { input: 2.5, output: 10 } },
          ],
        },
      },
    });

    const priced = await listOpenClawPricedModels();
    expect(priced.map((r) => `${r.provider}/${r.model}`)).toEqual(['openai/gpt-4o']);
  });

  it('produces non-empty lists from the redacted real openclaw.json extract', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    ws.writeModelsJson(JSON.parse(readFileSync(fixturePath('models', 'models.real.json'), 'utf-8')));

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

  it('treats unparseable openclaw.json as empty', async () => {
    const ws = await createTmpWorkspace();
    disposables.push(ws.cleanup);
    writeFileSync(`${ws.configDir}/openclaw.json`, '{ this is not valid json', 'utf-8');

    expect(await listOpenClawPricedModels()).toEqual([]);
    expect(await listUnpricedModels()).toEqual([]);
  });
});
