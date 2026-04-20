import { renderCharts, destroyCharts } from './charts.js';
import { escapeHtml, escapeAttr } from './util.js';
import { initLocaleControls, getLocale, t } from './i18n.js';
import { filterDataByDateRange } from './data-filter.js';

// ---- Utility functions ----

function formatNumber(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function formatCost(cost) {
  if (cost >= 1) return '$' + cost.toFixed(2);
  if (cost >= 0.01) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(6);
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffH = diffMs / (1000 * 60 * 60);

  if (diffH < 1) return Math.floor(diffMs / 60000) + ' 分钟前';
  if (diffH < 24) return Math.floor(diffH) + ' 小时前';
  if (diffH < 48) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  const map = {
    active: { icon: '🟢', label: t('dashboard.statusActive'), cls: 'status-active' },
    reset: { icon: '🔄', label: t('dashboard.statusReset'), cls: 'status-reset' },
    deleted: { icon: '🗑️', label: t('dashboard.statusDeleted'), cls: 'status-deleted' },
  };
  const s = map[status] || map.active;
  return `<span class="status-badge ${s.cls}">${s.icon} ${s.label}</span>`;
}

// ---- Time range helpers ----

function getLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateRange(rangeKey) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (rangeKey) {
    case 'today':
      return { from: getLocalDateStr(today), to: getLocalDateStr(today) };
    case 'yesterday': {
      const yd = new Date(today);
      yd.setDate(yd.getDate() - 1);
      return { from: getLocalDateStr(yd), to: getLocalDateStr(yd) };
    }
    case '7d': {
      const d7 = new Date(today);
      d7.setDate(d7.getDate() - 6);
      return { from: getLocalDateStr(d7), to: getLocalDateStr(today) };
    }
    case '30d': {
      const d30 = new Date(today);
      d30.setDate(d30.getDate() - 29);
      return { from: getLocalDateStr(d30), to: getLocalDateStr(today) };
    }
    case 'this-month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: getLocalDateStr(first), to: getLocalDateStr(today) };
    }
    case 'last-month': {
      const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastLast = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: getLocalDateStr(firstLast), to: getLocalDateStr(lastLast) };
    }
    case 'all':
    default:
      return { from: null, to: null };
  }
}

// ---- Render Summary Cards ----

function renderSummaryCards(summary) {
  const container = document.getElementById('summary-cards');
  const avgPerRequest = summary.totalRequests > 0
    ? Math.round(summary.totalTokens / summary.totalRequests)
    : 0;

  const cards = [
    {
      icon: '⚡', label: t('dashboard.summaryTotalTokens'),
      value: formatNumber(summary.totalTokens),
      sub: t('dashboard.summaryRequests', { count: summary.totalRequests.toLocaleString() }),
      valueClass: 'gradient-indigo',
    },
    {
      icon: '📥', label: t('dashboard.summaryInputTokens'),
      value: formatNumber(summary.totalInput),
      sub: t('dashboard.summaryInputRatio', { ratio: summary.totalTokens > 0 ? ((summary.totalInput / summary.totalTokens) * 100).toFixed(1) : 0 }),
      valueClass: 'gradient-cyan',
    },
    {
      icon: '📤', label: t('dashboard.summaryOutputTokens'),
      value: formatNumber(summary.totalOutput),
      sub: t('dashboard.summaryOutputRatio', { ratio: summary.totalTokens > 0 ? ((summary.totalOutput / summary.totalTokens) * 100).toFixed(1) : 0 }),
      valueClass: 'gradient-emerald',
    },
    {
      icon: '💾', label: t('dashboard.summaryCacheWrite'),
      value: formatNumber(summary.totalCacheWrite),
      sub: t('dashboard.summaryCacheRead', { count: formatNumber(summary.totalCacheRead) }),
      valueClass: 'gradient-rose',
    },
    {
      icon: '📊', label: t('dashboard.summarySessions'),
      value: summary.totalSessions.toLocaleString(),
      sub: t('dashboard.summaryAvgTokens', { count: formatNumber(avgPerRequest) }),
      valueClass: 'gradient-violet',
    },
    {
      icon: '💰', label: t('dashboard.summaryTotalCost'),
      value: formatCost(summary.totalCost),
      sub: t('dashboard.summaryAvgCost', { cost: formatCost(summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0) }),
      valueClass: 'gradient-amber',
    },
  ];

  container.innerHTML = cards.map((c) => `
    <div class="stat-card glass-card">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-value ${c.valueClass}">${escapeHtml(c.value)}</div>
      <div class="stat-sub">${escapeHtml(c.sub)}</div>
    </div>
  `).join('');
}

// ---- Render Sessions Table with Pagination ----

let allSessions = [];
let sortField = 'lastTimestamp';
let sortAsc = false;
let currentPage = 1;
let pageSize = 10;

function getFilteredSessions(sessions) {
  const filter = document.getElementById('status-filter').value;
  const search = document.getElementById('search-input').value;

  let filtered = sessions;

  if (filter !== 'all') {
    filtered = filtered.filter((s) => s.status === filter);
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((s) =>
      s.id.toLowerCase().includes(q) ||
      s.providers.join(',').toLowerCase().includes(q) ||
      s.models.join(',').toLowerCase().includes(q)
    );
  }

  filtered.sort((a, b) => {
    let aVal = a[sortField];
    let bVal = b[sortField];
    if (Array.isArray(aVal)) aVal = aVal.join(',');
    if (Array.isArray(bVal)) bVal = bVal.join(',');
    if (aVal == null) return sortAsc ? -1 : 1;
    if (bVal == null) return sortAsc ? 1 : -1;
    if (typeof aVal === 'string') {
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortAsc ? aVal - bVal : bVal - aVal;
  });

  return filtered;
}

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessions-tbody');
  const filtered = getFilteredSessions(sessions);

  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalItems);
  const pageItems = filtered.slice(startIdx, endIdx);

  if (totalItems === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 40px;">
          ${escapeHtml(t('dashboard.noSessionInFilter'))}
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = pageItems.map((s) => `
      <tr>
        <td>${statusBadge(s.status)}</td>
        <td><span class="session-id" title="${escapeAttr(s.id)}">${escapeHtml(s.id.substring(0, 8))}…</span></td>
        <td>${escapeHtml(s.providers.join(', '))}</td>
        <td>${escapeHtml(s.models.join(', '))}</td>
        <td><span class="token-value">${formatNumber(s.totalTokens)}</span></td>
        <td>${formatNumber(s.totalInput)}</td>
        <td>${formatNumber(s.totalOutput)}</td>
        <td><span class="cost-value">${formatCost(s.totalCost)}</span></td>
        <td>${s.requestCount}</td>
        <td>${formatDate(s.lastTimestamp)}</td>
      </tr>
    `).join('');
  }

  const info = document.getElementById('pagination-info');
  if (totalItems === 0) {
    info.textContent = t('dashboard.noData');
  } else {
    info.textContent = t('dashboard.paginationInfo', { start: startIdx + 1, end: endIdx, total: totalItems });
  }

  renderPageButtons(totalPages);
}

function renderPageButtons(totalPages) {
  const container = document.getElementById('page-buttons');
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let buttons = '';
  buttons += `<button class="page-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;

  const maxVisible = 7;
  let pages = [];

  if (totalPages <= maxVisible) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [1];
    let start = Math.max(2, currentPage - 2);
    let end = Math.min(totalPages - 1, currentPage + 2);

    if (currentPage <= 3) end = Math.min(5, totalPages - 1);
    if (currentPage >= totalPages - 2) start = Math.max(2, totalPages - 4);

    if (start > 2) pages.push('...');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages - 1) pages.push('...');
    pages.push(totalPages);
  }

  for (const p of pages) {
    if (p === '...') {
      buttons += `<span class="page-ellipsis">…</span>`;
    } else {
      buttons += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
  }

  buttons += `<button class="page-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;
  container.innerHTML = buttons;
}

function refreshTable() {
  renderSessionsTable(allSessions);
}

// ---- Main ----

let fullData = null;
let activeRange = 'today';

async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function applyDateRange(rangeKey) {
  if (!fullData) return;

  activeRange = rangeKey;
  const { from, to } = getDateRange(rangeKey);

  document.getElementById('date-from').value = from || '';
  document.getElementById('date-to').value = to || '';

  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === rangeKey);
  });

  applyFilter(from, to);
}

function applyFilter(from, to) {
  if (!fullData) return;

  const filteredData = filterDataByDateRange(fullData, from, to);

  renderSummaryCards(filteredData.summary);
  destroyCharts();
  renderCharts(filteredData);

  allSessions = filteredData.sessions;
  currentPage = 1;
  renderSessionsTable(allSessions);
}

async function init() {
  const loading = document.getElementById('loading');
  const mainContent = document.getElementById('main-content');
  const generatedAt = document.getElementById('generated-at');

  try {
    fullData = await fetchStats();

    loading.style.display = 'none';
    mainContent.style.display = 'block';

    if (fullData.generatedAt) {
      const d = new Date(fullData.generatedAt);
      generatedAt.textContent = t('common.updatedAt', { time: d.toLocaleTimeString(getLocale()) });
    }

    applyDateRange('today');

    // --- Event Listeners ---

    document.querySelectorAll('.time-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyDateRange(btn.dataset.range);
      });
    });

    document.getElementById('date-from').addEventListener('change', () => {
      document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
      const from = document.getElementById('date-from').value || null;
      const to = document.getElementById('date-to').value || null;
      applyFilter(from, to);
    });
    document.getElementById('date-to').addEventListener('change', () => {
      document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
      const from = document.getElementById('date-from').value || null;
      const to = document.getElementById('date-to').value || null;
      applyFilter(from, to);
    });

    document.querySelectorAll('thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (sortField === field) {
          sortAsc = !sortAsc;
        } else {
          sortField = field;
          sortAsc = false;
        }
        currentPage = 1;
        refreshTable();
      });
    });

    document.getElementById('status-filter').addEventListener('change', () => {
      currentPage = 1;
      refreshTable();
    });

    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentPage = 1;
        refreshTable();
      }, 200);
    });

    document.getElementById('page-size').addEventListener('change', (e) => {
      pageSize = parseInt(e.target.value, 10);
      currentPage = 1;
      refreshTable();
    });

    document.getElementById('page-buttons').addEventListener('click', (e) => {
      const btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.dataset.page, 10);
      if (isNaN(page) || page < 1) return;
      currentPage = page;
      refreshTable();
    });

    document.getElementById('model-log-scale').addEventListener('change', () => {
      const { from, to } = activeRange === 'all'
        ? { from: null, to: null }
        : (() => {
            const f = document.getElementById('date-from').value || null;
            const t = document.getElementById('date-to').value || null;
            return { from: f, to: t };
          })();
      const filteredData = filterDataByDateRange(fullData, from, to);
      destroyCharts();
      renderCharts(filteredData);
    });

  } catch (err) {
    loading.innerHTML = `
      <div style="color: var(--accent-rose); text-align: center;">
        <p style="font-size: 2rem; margin-bottom: 12px;">❌</p>
        <p>${escapeHtml(t('dashboard.loadFailed', { message: err.message }))}</p>
        <p style="color: var(--text-muted); margin-top: 8px;">${escapeHtml(t('dashboard.ensureBackendRunning'))}</p>
      </div>
    `;
  }
}

window.addEventListener('openclaw-themechange', () => {
  if (!fullData) return;
  const from = document.getElementById('date-from')?.value || null;
  const to = document.getElementById('date-to')?.value || null;
  applyFilter(from, to);
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');

  try {
    await fetch('/api/refresh');
    fullData = null;
    await init();
  } finally {
    btn.classList.remove('spinning');
  }
});

window.addEventListener('openclaw-localechange', () => {
  if (!fullData) return;
  const generatedAt = document.getElementById('generated-at');
  if (fullData.generatedAt && generatedAt) {
    const d = new Date(fullData.generatedAt);
    generatedAt.textContent = t('common.updatedAt', { time: d.toLocaleTimeString(getLocale()) });
  }
  refreshTable();
  renderSummaryCards(filterDataByDateRange(
    fullData,
    document.getElementById('date-from')?.value || null,
    document.getElementById('date-to')?.value || null
  ).summary);
});

initLocaleControls();
init();
