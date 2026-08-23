import { describe, it, expect, vi } from 'vitest';
import {
  cmdSync,
  cmdReceiveSync,
  cmdSyncStatus,
} from '../../scripts/openclaw-usage-cli.js';

describe('sync CLI commands', () => {
  it('sync uses the explicit target and returns machine-readable-safe output', async () => {
    const lines = [];
    const syncFn = vi.fn(async (targetId) => ({ ok: true, targetId, sourceId: 'mbp', revision: 'r1' }));
    const code = await cmdSync({ targetId: 'claw', syncFn, print: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(syncFn).toHaveBeenCalledWith('claw');
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, targetId: 'claw' });
  });

  it('passes only the fixed scheduled mode to scheduled syncs', async () => {
    const syncFn = vi.fn(async (targetId, options) => {
      expect(targetId).toBeUndefined();
      expect(options).toEqual({ scheduled: true });
      return { ok: true, skipped: true, status: 'disabled' };
    });
    expect(await cmdSync({ scheduled: true, syncFn, print: () => {} })).toBe(0);
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it('sync reports a sanitized failure and exits nonzero', async () => {
    const lines = [];
    const syncFn = vi.fn(async () => { throw new Error('stderr credential=secret'); });
    const code = await cmdSync({ syncFn, print: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain('secret');
    expect(lines.join('\n')).toMatch(/sync failed/i);
  });

  it('receive-sync passes stdin to the receiver and returns deterministic exit codes', async () => {
    const input = { id: 'stdin' };
    const lines = [];
    const receiveFn = vi.fn(async (received) => {
      expect(received).toBe(input);
      return { ok: true, sourceId: 'mbp', revision: 'r1' };
    });
    const code = await cmdReceiveSync({ input, receiveFn, print: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(receiveFn).toHaveBeenCalledWith(input);
    expect(JSON.parse(lines[0]).ok).toBe(true);
  });

  it('sync-status prints only safe JSON state', async () => {
    const lines = [];
    const statusFn = vi.fn(async () => ({
      version: 1,
      targetId: 'claw',
      lastAttempt: null,
      lastSuccess: null,
      failureSince: null,
      error: null,
      enabled: true,
      configuredTargetId: 'claw',
      outboundTargets: [{ id: 'claw', label: 'claw' }],
    }));
    const code = await cmdSyncStatus({ statusFn, print: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({ targetId: 'claw', enabled: true }));
    expect(lines[0]).not.toContain('sshAlias');
  });
});
