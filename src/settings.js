import { initLocaleControls, t } from './i18n.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || t('settings.requestFailed'));
    error.code = body.code || 'SETTINGS_REQUEST_FAILED';
    throw error;
  }
  return body;
}

export function buildSettingsPatch(values) {
  return {
    label: String(values.label || '').trim(),
    enabled: Boolean(values.enabled),
    targetId: values.targetId || null,
    intervalMinutes: Number(values.intervalMinutes),
  };
}

export async function loadSettingsData(fetchImpl = fetch) {
  const [config, status] = await Promise.all([
    requestJson(fetchImpl, '/api/sync/config'),
    requestJson(fetchImpl, '/api/sync/status'),
  ]);
  return { config, status };
}

export async function saveSettings(patch, fetchImpl = fetch) {
  return requestJson(fetchImpl, '/api/sync/settings', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(buildSettingsPatch(patch)),
  });
}

export async function runSettingsAction(action, targetId, fetchImpl = fetch) {
  if (action !== 'test' && action !== 'run') throw new Error('Unknown sync action');
  if (!targetId) throw new Error('A sync target is required');
  return requestJson(fetchImpl, `/api/sync/${action}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ targetId }),
  });
}

function statusMarkup(status) {
  const rows = [
    ['settings.lastAttempt', status?.lastAttempt || '—'],
    ['settings.lastSuccess', status?.lastSuccess || '—'],
    ['settings.failureSince', status?.failureSince || '—'],
  ];
  return rows.map(([key, value]) => `
    <div class="settings-status-row">
      <span>${escapeHtml(t(key))}</span><strong>${escapeHtml(value)}</strong>
    </div>
  `).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderSettings(config, status = {}) {
  const root = document.getElementById('settings-content');
  if (!root) return;
  const source = config?.source || { id: 'local', label: 'Local' };
  const settings = config?.settings || { enabled: false, targetId: null, intervalMinutes: 60 };
  const capabilities = config?.capabilities || {};
  const targets = Array.isArray(capabilities.outboundTargets) ? capabilities.outboundTargets : [];
  const hasTargets = capabilities.canSync && targets.length > 0;

  root.innerHTML = `
    <section class="settings-grid">
      <div class="glass-card settings-card">
        <div class="settings-card-heading">
          <div>
            <p class="settings-eyebrow">${escapeHtml(t('settings.currentSource'))}</p>
            <h2>${escapeHtml(source.label)}</h2>
            <p class="settings-source-id">${escapeHtml(source.id)}</p>
          </div>
          <span class="settings-capability-badge">${escapeHtml(capabilities.canExport ? t('settings.exportReady') : t('settings.localOnly'))}</span>
        </div>
        <form id="settings-form" class="settings-form">
          <label class="settings-field">
            <span>${escapeHtml(t('settings.label'))}</span>
            <input name="label" type="text" value="${escapeHtml(source.label)}" maxlength="120" required />
          </label>
          <label class="settings-toggle-field">
            <input name="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
            <span>${escapeHtml(t('settings.enabled'))}</span>
          </label>
          ${hasTargets ? `
            <label class="settings-field">
              <span>${escapeHtml(t('settings.target'))}</span>
              <select name="targetId" aria-label="${escapeHtml(t('settings.target'))}">
                <option value="">${escapeHtml(t('settings.noTarget'))}</option>
                ${targets.map((target) => `<option value="${escapeHtml(target.id)}" ${target.id === settings.targetId ? 'selected' : ''}>${escapeHtml(target.label || target.id)}</option>`).join('')}
              </select>
            </label>
          ` : `
            <p class="settings-guidance" data-settings-guidance>${escapeHtml(t('settings.noTargetsGuidance'))}</p>
          `}
          <label class="settings-field settings-interval-field">
            <span>${escapeHtml(t('settings.intervalMinutes'))}</span>
            <input name="intervalMinutes" type="number" min="1" max="10080" step="1" value="${escapeHtml(settings.intervalMinutes)}" required />
          </label>
          <button type="submit" class="btn-primary">${escapeHtml(t('settings.save'))}</button>
          <p id="settings-message" class="settings-message" role="status" aria-live="polite"></p>
        </form>
      </div>
      <div class="glass-card settings-card">
        <p class="settings-eyebrow">${escapeHtml(t('settings.syncStatus'))}</p>
        <div class="settings-status-list">${statusMarkup(status)}</div>
        <p class="settings-status-error" id="settings-status-error">${status?.error ? escapeHtml(status.error) : ''}</p>
        ${hasTargets ? `
          <div class="settings-actions">
            <button type="button" class="btn-secondary" data-settings-action="test">${escapeHtml(t('settings.testConnection'))}</button>
            <button type="button" class="btn-primary" data-settings-action="run">${escapeHtml(t('settings.syncNow'))}</button>
          </div>
        ` : ''}
      </div>
      <div class="glass-card settings-card settings-help-card">
        <p class="settings-eyebrow">${escapeHtml(t('settings.sshHelpTitle'))}</p>
        <p>${escapeHtml(t('settings.sshHelp'))}</p>
      </div>
    </section>
  `;
}

function setMessage(message, isError = false) {
  const el = document.getElementById('settings-message');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', isError);
}

async function loadStatus(fetchImpl) {
  return requestJson(fetchImpl, '/api/sync/status');
}

function bindSettingsInteractions(config, status, fetchImpl) {
  const root = document.getElementById('settings-content');
  const form = document.getElementById('settings-form');
  if (!root || !form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const savedConfig = await saveSettings({
        label: values.label,
        enabled: form.elements.enabled.checked,
        targetId: values.targetId || null,
        intervalMinutes: values.intervalMinutes,
      }, fetchImpl);
      const savedStatus = await loadStatus(fetchImpl);
      // The PUT response is the public config projection. Rendering it before
      // the success message keeps heading, controls, and feedback in sync.
      renderSettings(savedConfig?.source ? savedConfig : config, savedStatus);
      bindSettingsInteractions(savedConfig?.source ? savedConfig : config, savedStatus, fetchImpl);
      setMessage(t('settings.saveSuccess'));
    } catch {
      setMessage(t('settings.saveFailed'), true);
    }
  });

  root.querySelectorAll('[data-settings-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = form.elements.targetId?.value || config.settings?.targetId;
      if (!target) return;
      try {
        await runSettingsAction(button.dataset.settingsAction, target, fetchImpl);
        const latestStatus = await loadStatus(fetchImpl);
        // Action status is persisted by the server; replace the old card and
        // bind the new action nodes once so no stale listener survives.
        renderSettings(config, latestStatus);
        bindSettingsInteractions(config, latestStatus, fetchImpl);
        setMessage(button.dataset.settingsAction === 'test' ? t('settings.testSuccess') : t('settings.syncSuccess'));
      } catch {
        setMessage(t('settings.actionFailed'), true);
      }
    });
  });
}

export async function initSettings(fetchImpl = fetch) {
  const root = document.getElementById('settings-content');
  if (!root) return;
  try {
    const { config, status } = await loadSettingsData(fetchImpl);
    renderSettings(config, status);
    bindSettingsInteractions(config, status, fetchImpl);
  } catch {
    root.innerHTML = `<p class="settings-message is-error" role="status">${escapeHtml(t('settings.loadFailed'))}</p>`;
  }
}

initLocaleControls();
if (document.getElementById('settings-app')) initSettings();

window.addEventListener('openclaw-localechange', () => {
  if (document.getElementById('settings-app')) initSettings();
});
