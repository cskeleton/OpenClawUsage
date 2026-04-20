import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createTmpWorkspace } from '../../helpers/tmp-workspace.js';
import { fixturePath } from '../../helpers/fixture-loader.js';
import { createMcpServer } from '../../../mcp-server.js';
import { invalidateStatsCache } from '../../../stats-service.js';

const disposables = [];
let handlers;

beforeEach(async () => {
  invalidateStatsCache();
  const ws = await createTmpWorkspace();
  disposables.push(ws.cleanup);

  for (const name of readdirSync(fixturePath('sessions-real'))) {
    copyFileSync(fixturePath('sessions-real', name), join(ws.sessionsDir, name));
  }
  copyFileSync(fixturePath('models', 'models.real.json'), join(ws.agentDir, 'models.json'));

  await ws.writePricingConfig({
    version: '1.0',
    enabled: true,
    updated: new Date().toISOString(),
    pricing: {},
  });

  const server = createMcpServer();
  handlers = server.__handlers;
});

afterEach(async () => {
  invalidateStatsCache();
  while (disposables.length) await disposables.pop()();
});

function call(name, args = {}) {
  return handlers.callTool({ params: { name, arguments: args } });
}

describe('MCP listTools', () => {
  it('returns 8 tool descriptors covering the expected names', async () => {
    const res = await handlers.listTools();
    expect(res.tools.length).toBe(8);
    const names = res.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_total_usage',
      'get_usage_by_provider',
      'get_usage_by_model',
      'list_recent_sessions',
      'get_session_stats',
      'get_pricing_config',
      'update_pricing_config',
      'refresh_stats_cache',
    ]));
  });
});

describe('MCP callTool', () => {
  it('get_total_usage returns JSON summary with totalTokens', async () => {
    const res = await call('get_total_usage');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toHaveProperty('totalTokens');
    expect(parsed).toHaveProperty('totalSessions');
  });

  it('get_usage_by_provider returns object keyed by provider', async () => {
    const res = await call('get_usage_by_provider');
    const parsed = JSON.parse(res.content[0].text);
    expect(typeof parsed).toBe('object');
  });

  it('get_usage_by_model returns array sorted by totalTokens desc', async () => {
    const res = await call('get_usage_by_model');
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i - 1].totalTokens).toBeGreaterThanOrEqual(parsed[i].totalTokens);
    }
  });

  it('list_recent_sessions respects limit', async () => {
    const res = await call('list_recent_sessions', { limit: 2 });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.length).toBeLessThanOrEqual(2);
  });

  it('get_session_stats returns isError for unknown UUID', async () => {
    const res = await call('get_session_stats', { sessionId: '00000000-0000-0000-0000-000000000000' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
  });

  it('get_pricing_config returns current config', async () => {
    const res = await call('get_pricing_config');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.version).toBe('1.0');
  });

  it('update_pricing_config + refresh_stats_cache reflect change', async () => {
    await call('update_pricing_config', {
      config: {
        version: '1.0',
        enabled: true,
        pricing: { 'openai/gpt-4o': { input: 999, output: 999 } },
      },
    });

    const refreshRes = await call('refresh_stats_cache');
    expect(JSON.parse(refreshRes.content[0].text).ok).toBe(true);

    const pricingRes = await call('get_pricing_config');
    const parsed = JSON.parse(pricingRes.content[0].text);
    expect(parsed.pricing['openai/gpt-4o'].input).toBe(999);
  });

  it('unknown tool throws Error handled by callToolHandler catch', async () => {
    const res = await call('nonexistent_tool');
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Tool not found/);
  });
});
