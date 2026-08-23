import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSettingsPatch,
  loadSettingsData,
  saveSettings,
  runSettingsAction,
  renderSettings,
  initSettings,
} from '../../../src/settings.js';
import { setLocale } from '../../../src/i18n.js';

describe('settings UI API boundary', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="settings-content"></main>';
    setLocale('zh-CN');
  });

  it('builds an exact public settings patch', () => {
    expect(buildSettingsPatch({
      label: 'MBP', enabled: true, targetId: 'claw', intervalMinutes: '60',
    })).toEqual({ label: 'MBP', enabled: true, targetId: 'claw', intervalMinutes: 60 });
  });

  it('loads config and status using separate GET requests', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: { id: 'mbp', label: 'MBP' }, settings: {}, capabilities: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ lastSuccess: null }), { status: 200 }));
    await loadSettingsData(fetchImpl);
    expect(fetchImpl.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      ['/api/sync/config', undefined],
      ['/api/sync/status', undefined],
    ]);
  });

  it('saves only the exact allowed settings body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await saveSettings({ label: 'MBP', enabled: false, targetId: null, intervalMinutes: 30 }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/sync/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'MBP', enabled: false, targetId: null, intervalMinutes: 30 }),
    });
  });

  it('tests and runs sync with targetId only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await runSettingsAction('test', 'claw', fetchImpl);
    await runSettingsAction('run', 'claw', fetchImpl);
    expect(fetchImpl.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      ['/api/sync/test', JSON.stringify({ targetId: 'claw' })],
      ['/api/sync/run', JSON.stringify({ targetId: 'claw' })],
    ]);
  });

  it('does not render arbitrary host or SSH detail inputs when targets are absent', () => {
    renderSettings({
      source: { id: 'local', label: 'Local' },
      settings: { enabled: false, targetId: null, intervalMinutes: 60 },
      capabilities: { canSync: false, outboundTargets: [] },
    }, { lastSuccess: null, lastAttempt: null, error: null });
    expect(document.querySelector('input[name="host"]')).toBeNull();
    expect(document.querySelector('input[name="sshAlias"]')).toBeNull();
    expect(document.querySelector('input[name="remotePath"]')).toBeNull();
    expect(document.querySelector('[data-settings-guidance]')).not.toBeNull();
    expect(document.querySelector('select[name="targetId"]')).toBeNull();
  });

  it('re-renders the heading after save and status after an action without stale nodes', async () => {
    const initialConfig = {
      source: { id: 'mbp', label: 'My MBP' },
      settings: { enabled: true, targetId: 'claw', intervalMinutes: 60 },
      capabilities: { canExport: true, canSync: true, outboundTargets: [{ id: 'claw', label: 'claw' }] },
    };
    const savedConfig = { ...initialConfig, source: { id: 'mbp', label: 'Updated MBP' } };
    const initialStatus = { lastAttempt: null, lastSuccess: null, failureSince: null, error: null };
    const actionStatus = { lastAttempt: '2026-08-24T12:00:00.000Z', lastSuccess: '2026-08-24T12:01:00.000Z', failureSince: null, error: null };
    const responses = [initialConfig, initialStatus, savedConfig, initialStatus, actionStatus];
    const fetchImpl = vi.fn(async (url, options) => {
      if (url === '/api/sync/settings') return new Response(JSON.stringify(responses.shift()), { status: 200 });
      if (url === '/api/sync/run') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    });
    await initSettings(fetchImpl);
    const label = document.querySelector('input[name="label"]');
    label.value = 'Updated MBP';
    document.getElementById('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.settings-card h2').textContent).toBe('Updated MBP');
    expect(document.getElementById('settings-message').textContent).toBe('设置已保存');

    document.querySelector('[data-settings-action="run"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.settings-status-list').textContent).toContain('2026-08-24T12:01:00.000Z');
    expect(document.getElementById('settings-message').textContent).toBe('同步已完成');
  });
});
