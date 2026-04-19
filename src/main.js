import { renderCharts, destroyCharts } from './charts.js';

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
    active: { icon: '🟢', label: 'Active', cls: 'status-active' },
    reset: { icon: '🔄', label: 'Reset', cls: 'status-reset' },
    deleted: { icon: '🗑️', label: 'Deleted', cls: 'status-deleted' },
  };
  const s = map[status] || map.active;
  return `<span class="status-badge ${s.cls}">${s.icon} ${s.label}</span>`;
}

// ---- Time range helpers ----

function getLocalDateStr(date) {
  // Returns YYYY-MM-DD in local timezone
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateRange(rangeKey) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (rangeKey) {
    case 'today': {
      return { from: getLocalDateStr(today), to: getLocalDateStr(today) };
    }
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

/**
 * Filter the full dataset by date range, returning a new structure
 * with recalculated summary, byProvider, byModel, byDate, and sessions.
 */
function filterDataByDateRange(fullData, from, to) {
  if (!from && !to) return fullData;

  // We need the raw records to re-aggregate. But we only have aggregated data.
  // Instead, filter sessions by their timestamp range and re-aggregate from sessions + byDate.
  // Actually we need a different approach: send all raw records from server, or filter byDate and sessions.

  // For sessions: filter by overlap with [from, to]
  const fromDate = from ? from + 'T00:00:00.000Z' : null;
  // To is inclusive, so we use end of day
  const toDate = to ? to + 'T23:59:59.999Z' : null;

  // Filter byDate
  const filteredByDate = {};
  for (const [date, stats] of Object.entries(fullData.byDate)) {
    if (fromDate && date < from) continue;
    if (toDate && date > to) continue;
    filteredByDate[date] = stats;
  }

  // Recalculate summary from byDate
  const summary = {
    totalInput: 0, totalOutput: 0,
    totalCacheRead: 0, totalCacheWrite: 0,
    totalTokens: 0, totalCost: 0,
    totalRequests: 0, totalSessions: 0,
  };

  for (const stats of Object.values(filteredByDate)) {
    summary.totalInput += stats.input;
    summary.totalOutput += stats.output;
    summary.totalCacheRead += stats.cacheRead;
    summary.totalCacheWrite += stats.cacheWrite;
    summary.totalTokens += stats.totalTokens;
    summary.totalCost += stats.totalCost;
    summary.totalRequests += stats.requests;
  }

  // Filter sessions - include session if any activity falls in range
  const filteredSessions = fullData.sessions.filter((s) => {
    if (!s.lastTimestamp && !s.firstTimestamp) return false;
    const first = s.firstTimestamp || s.lastTimestamp;
    const last = s.lastTimestamp || s.firstTimestamp;
    // Session overlaps with range
    if (fromDate && last < fromDate) return false;
    if (toDate && first > toDate) return false;
    return true;
  });

  summary.totalSessions = filteredSessions.length;

  // Recalculate byProvider and byModel from byDate (we can't do per-provider-per-date
  // from the current data structure). Use the full data's byProvider/byModel but
  // note this is approximate for filtered ranges. For accurate per-range provider/model
  // breakdown we'd need the server to return per-record data.
  // Actually, let's use a different approach: have the server return records grouped
  // by date AND provider/model. But for now, let's use sessions data instead.

  const byProvider = {};
  const byModel = {};

  for (const s of filteredSessions) {
    for (const p of s.providers) {
      if (!byProvider[p]) {
        byProvider[p] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
      }
    }
    for (const m of s.models) {
      const key = `${s.providers[0] || 'unknown'}/${m}`;
      if (!byModel[key]) {
        byModel[key] = { provider: s.providers[0] || 'unknown', model: m, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
      }
    }
  }

  // For provider/model breakdown, if filtering "all" use original data, else estimate from sessions
  if (!from && !to) {
    return fullData;
  }

  // Use sessions to aggregate provider/model stats (approximate but good enough per-range)
  for (const s of filteredSessions) {
    const mainProvider = s.providers[0] || 'unknown';
    const mainModel = s.models[0] || 'unknown';

    if (!byProvider[mainProvider]) {
      byProvider[mainProvider] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
    }
    byProvider[mainProvider].input += s.totalInput;
    byProvider[mainProvider].output += s.totalOutput;
    byProvider[mainProvider].cacheRead += s.totalCacheRead;
    byProvider[mainProvider].cacheWrite += s.totalCacheWrite;
    byProvider[mainProvider].totalTokens += s.totalTokens;
    byProvider[mainProvider].totalCost += s.totalCost;
    byProvider[mainProvider].requests += s.requestCount;

    const modelKey = `${mainProvider}/${mainModel}`;
    if (!byModel[modelKey]) {
      byModel[modelKey] = { provider: mainProvider, model: mainModel, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0, requests: 0 };
    }
    byModel[modelKey].input += s.totalInput;
    byModel[modelKey].output += s.totalOutput;
    byModel[modelKey].cacheRead += s.totalCacheRead;
    byModel[modelKey].cacheWrite += s.totalCacheWrite;
    byModel[modelKey].totalTokens += s.totalTokens;
    byModel[modelKey].totalCost += s.totalCost;
    byModel[modelKey].requests += s.requestCount;
  }

  return {
    summary,
    byProvider,
    byModel,
    byDate: filteredByDate,
    sessions: filteredSessions,
    generatedAt: fullData.generatedAt,
  };
}

// ---- Render Summary Cards ----

function renderSummaryCards(summary) {
  const container = document.getElementById('summary-cards');
  const avgPerRequest = summary.totalRequests > 0
    ? Math.round(summary.totalTokens / summary.totalRequests)
    : 0;

  const cards = [
    {
      icon: '⚡', label: 'Total Tokens',
      value: formatNumber(summary.totalTokens),
      sub: `${summary.totalRequests.toLocaleString()} 次请求`,
      valueClass: 'gradient-indigo',
    },
    {
      icon: '📥', label: 'Input Tokens',
      value: formatNumber(summary.totalInput),
      sub: `占 ${summary.totalTokens > 0 ? ((summary.totalInput / summary.totalTokens) * 100).toFixed(1) : 0}%`,
      valueClass: 'gradient-cyan',
    },
    {
      icon: '📤', label: 'Output Tokens',
      value: formatNumber(summary.totalOutput),
      sub: `占 ${summary.totalTokens > 0 ? ((summary.totalOutput / summary.totalTokens) * 100).toFixed(1) : 0}%`,
      valueClass: 'gradient-emerald',
    },
    {
      icon: '💾', label: 'Cache Write',
      value: formatNumber(summary.totalCacheWrite),
      sub: `Read: ${formatNumber(summary.totalCacheRead)}`,
      valueClass: 'gradient-rose',
    },
    {
      icon: '📊', label: 'Sessions',
      value: summary.totalSessions.toLocaleString(),
      sub: `均 ${formatNumber(avgPerRequest)} tokens/请求`,
      valueClass: 'gradient-violet',
    },
    {
      icon: '💰', label: '总费用',
      value: formatCost(summary.totalCost),
      sub: `均 ${formatCost(summary.totalRequests > 0 ? summary.totalCost / summary.totalRequests : 0)}/请求`,
      valueClass: 'gradient-amber',
    },
  ];

  container.innerHTML = cards.map((c) => `
    <div class="stat-card glass-card">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.valueClass}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
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

  // Sort
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

  tbody.innerHTML = pageItems.map((s) => `
    <tr>
      <td>${statusBadge(s.status)}</td>
      <td><span class="session-id" title="${s.id}">${s.id.substring(0, 8)}…</span></td>
      <td>${s.providers.join(', ')}</td>
      <td>${s.models.join(', ')}</td>
      <td><span class="token-value">${formatNumber(s.totalTokens)}</span></td>
      <td>${formatNumber(s.totalInput)}</td>
      <td>${formatNumber(s.totalOutput)}</td>
      <td><span class="cost-value">${formatCost(s.totalCost)}</span></td>
      <td>${s.requestCount}</td>
      <td>${formatDate(s.lastTimestamp)}</td>
    </tr>
  `).join('');

  // Render pagination info
  const info = document.getElementById('pagination-info');
  if (totalItems === 0) {
    info.textContent = '无数据';
  } else {
    info.textContent = `显示 ${startIdx + 1}–${endIdx}，共 ${totalItems} 条`;
  }

  // Render page buttons
  renderPageButtons(totalPages);
}

function renderPageButtons(totalPages) {
  const container = document.getElementById('page-buttons');
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let buttons = '';

  // Prev button
  buttons += `<button class="page-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;

  // Page numbers - show max 7 buttons with ellipsis
  const maxVisible = 7;
  let pages = [];

  if (totalPages <= maxVisible) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [1];
    let start = Math.max(2, currentPage - 2);
    let end = Math.min(totalPages - 1, currentPage + 2);

    if (currentPage <= 3) {
      end = Math.min(5, totalPages - 1);
    }
    if (currentPage >= totalPages - 2) {
      start = Math.max(2, totalPages - 4);
    }

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

  // Next
  buttons += `<button class="page-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;

  container.innerHTML = buttons;
}

function refreshTable() {
  renderSessionsTable(allSessions);
}

// ---- Main ----

let fullData = null; // Cached full dataset
let activeRange = 'today'; // Default range

async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function applyDateRange(rangeKey) {
  if (!fullData) return;

  activeRange = rangeKey;
  const { from, to } = getDateRange(rangeKey);

  // Update date inputs
  document.getElementById('date-from').value = from || '';
  document.getElementById('date-to').value = to || '';

  // Update active button
  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === rangeKey);
  });

  applyFilter(from, to);
}

function applyFilter(from, to) {
  if (!fullData) return;

  const filteredData = filterDataByDateRange(fullData, from, to);

  // Render everything with filtered data
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

    // Hide loading, show content
    loading.style.display = 'none';
    mainContent.style.display = 'block';

    // Update header
    if (fullData.generatedAt) {
      const d = new Date(fullData.generatedAt);
      generatedAt.textContent = `更新于 ${d.toLocaleTimeString('zh-CN')}`;
    }

    // Apply default range (today)
    applyDateRange('today');

    // --- Event Listeners ---

    // Time preset buttons
    document.querySelectorAll('.time-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyDateRange(btn.dataset.range);
      });
    });

    // Custom date inputs
    document.getElementById('date-from').addEventListener('change', () => {
      // Deactivate preset buttons
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

    // Table sort
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

    // Status filter
    document.getElementById('status-filter').addEventListener('change', () => {
      currentPage = 1;
      refreshTable();
    });

    // Search
    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentPage = 1;
        refreshTable();
      }, 200);
    });

    // Page size
    document.getElementById('page-size').addEventListener('change', (e) => {
      pageSize = parseInt(e.target.value, 10);
      currentPage = 1;
      refreshTable();
    });

    // Page navigation (event delegation)
    document.getElementById('page-buttons').addEventListener('click', (e) => {
      const btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.dataset.page, 10);
      if (isNaN(page) || page < 1) return;
      currentPage = page;
      refreshTable();
    });

    // Model log scale toggle
    document.getElementById('model-log-scale').addEventListener('change', () => {
      // Re-render only model chart - need to use current filtered data
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
        <p>加载失败：${err.message}</p>
        <p style="color: var(--text-muted); margin-top: 8px;">请确认后端服务正在运行</p>
      </div>
    `;
  }
}

// 主题切换后刷新图表配色（Chart.js 默认值与 tooltip 随 CSS 变量更新）
window.addEventListener('openclaw-themechange', () => {
  if (!fullData) return;
  const from = document.getElementById('date-from')?.value || null;
  const to = document.getElementById('date-to')?.value || null;
  applyFilter(from, to);
});

// Refresh button
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

init();
