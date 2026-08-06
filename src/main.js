import { renderCharts, destroyCharts } from './charts.js';
import { escapeHtml, escapeAttr } from './util.js';
import { initLocaleControls, getLocale, t } from './i18n.js';
import { filterData, collapseCrossTable, providerOfKey, modelOfKey } from './data-filter.js';

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

function formatPercent(value, total) {
  if (!total) return '0%';
  return ((value / total) * 100).toFixed(1) + '%';
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

// ---- Provider / Model 维度筛选 ----

let filterProvider = '';
/** 完整的 `provider/model` 键 */
let filterModel = '';
let timelineMetric = 'tokens';

/** 当前时间区间内出现过的 `provider/model` 键 */
function getRangeModelKeys(from, to) {
  if (!fullData) return [];
  return Object.keys(collapseCrossTable(fullData.byDateModel || {}, from, to)).sort();
}

/**
 * 用当前时间区间内的数据填充 Provider / Model 下拉。
 * 已选中但在新区间内无数据的选项仍保留，避免选择被静默清空。
 */
function populateDimensionOptions(from, to) {
  const keys = getRangeModelKeys(from, to);

  const providers = [...new Set(keys.map(providerOfKey))].sort();
  if (filterProvider && !providers.includes(filterProvider)) providers.push(filterProvider);

  const providerSelect = document.getElementById('provider-filter');
  providerSelect.innerHTML = [
    `<option value="">${escapeHtml(t('dashboard.allProviders'))}</option>`,
    ...providers.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`),
  ].join('');
  providerSelect.value = filterProvider;

  const modelKeys = filterProvider
    ? keys.filter((k) => providerOfKey(k) === filterProvider)
    : keys;
  if (filterModel && !modelKeys.includes(filterModel)) modelKeys.push(filterModel);

  const modelSelect = document.getElementById('model-filter');
  modelSelect.innerHTML = [
    `<option value="">${escapeHtml(t('dashboard.allModels'))}</option>`,
    ...modelKeys.map((k) => {
      // 已按 provider 收窄时只显示模型名，否则显示完整键
      const label = filterProvider ? modelOfKey(k) : k;
      return `<option value="${escapeAttr(k)}">${escapeHtml(label)}</option>`;
    }),
  ].join('');
  modelSelect.value = filterModel;

  document.getElementById('clear-dimension-filter').hidden = !filterProvider && !filterModel;
}

/** 顶部筛选回显：当前 provider/model 在所选区间内的费用与 token 合计 */
function renderDimensionSummary(filteredData) {
  const el = document.getElementById('dimension-summary');
  if (!filterProvider && !filterModel) {
    el.innerHTML = '';
    return;
  }

  const label = filterModel || filterProvider;
  const { summary } = filteredData;
  el.innerHTML = `
    <span class="dimension-chip">
      <span class="dimension-chip-key">${escapeHtml(label)}</span>
      <span class="dimension-chip-cost">${escapeHtml(formatCost(summary.totalCost))}</span>
      <span class="dimension-chip-sub">${escapeHtml(t('dashboard.chipTokens', { count: formatNumber(summary.totalTokens) }))}</span>
      <span class="dimension-chip-sub">${escapeHtml(t('dashboard.summaryRequests', { count: summary.totalRequests.toLocaleString() }))}</span>
    </span>
  `;
}

// ---- Provider / Model 消耗明细表 ----

let breakdownDimension = 'provider';
let breakdownSort = 'totalCost';
let breakdownAsc = false;

/**
 * 把 byProvider / byModel 摊平为明细表行
 * @param {Object} filteredData
 * @returns {Array<object>}
 */
function buildBreakdownRows(filteredData) {
  const source = breakdownDimension === 'provider'
    ? filteredData.byProvider || {}
    : filteredData.byModel || {};

  return Object.entries(source).map(([key, stats]) => ({
    key,
    input: stats.input,
    output: stats.output,
    cacheRead: stats.cacheRead,
    cacheWrite: stats.cacheWrite,
    totalTokens: stats.totalTokens,
    totalCost: stats.totalCost,
    requests: stats.requests,
  }));
}

function renderBreakdownTable(filteredData) {
  const tbody = document.getElementById('breakdown-tbody');
  const tfoot = document.getElementById('breakdown-tfoot');
  const rows = buildBreakdownRows(filteredData);

  const totalCost = rows.reduce((sum, r) => sum + r.totalCost, 0);

  rows.sort((a, b) => {
    // costShare 与 totalCost 同序
    const field = breakdownSort === 'costShare' ? 'totalCost' : breakdownSort;
    const aVal = a[field];
    const bVal = b[field];
    if (typeof aVal === 'string') {
      return breakdownAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return breakdownAsc ? aVal - bVal : bVal - aVal;
  });

  document.getElementById('breakdown-key-header').textContent = breakdownDimension === 'provider'
    ? t('dashboard.tableProvider')
    : t('dashboard.tableProviderModel');

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 40px;">
          ${escapeHtml(t('dashboard.noBreakdownInFilter'))}
        </td>
      </tr>
    `;
    tfoot.innerHTML = '';
    return;
  }

  const activeKey = breakdownDimension === 'provider' ? filterProvider : filterModel;

  tbody.innerHTML = rows.map((r) => `
    <tr class="breakdown-row${r.key === activeKey ? ' is-active' : ''}" data-key="${escapeAttr(r.key)}" tabindex="0">
      <td><span class="breakdown-key">${escapeHtml(r.key)}</span></td>
      <td>${formatNumber(r.input)}</td>
      <td>${formatNumber(r.output)}</td>
      <td>${formatNumber(r.cacheRead)}</td>
      <td>${formatNumber(r.cacheWrite)}</td>
      <td><span class="token-value">${formatNumber(r.totalTokens)}</span></td>
      <td><span class="cost-value">${formatCost(r.totalCost)}</span></td>
      <td>
        <span class="share-bar"><span class="share-bar-fill" style="width:${totalCost > 0 ? (r.totalCost / totalCost) * 100 : 0}%"></span></span>
        <span class="share-text">${formatPercent(r.totalCost, totalCost)}</span>
      </td>
      <td>${r.requests.toLocaleString()}</td>
    </tr>
  `).join('');

  const totals = rows.reduce((acc, r) => {
    acc.input += r.input;
    acc.output += r.output;
    acc.cacheRead += r.cacheRead;
    acc.cacheWrite += r.cacheWrite;
    acc.totalTokens += r.totalTokens;
    acc.requests += r.requests;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, requests: 0 });

  tfoot.innerHTML = `
    <tr class="breakdown-total">
      <td>${escapeHtml(t('dashboard.breakdownTotal'))}</td>
      <td>${formatNumber(totals.input)}</td>
      <td>${formatNumber(totals.output)}</td>
      <td>${formatNumber(totals.cacheRead)}</td>
      <td>${formatNumber(totals.cacheWrite)}</td>
      <td><span class="token-value">${formatNumber(totals.totalTokens)}</span></td>
      <td><span class="cost-value">${formatCost(totalCost)}</span></td>
      <td>100%</td>
      <td>${totals.requests.toLocaleString()}</td>
    </tr>
  `;
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
let eventsBound = false;
let refreshInFlight = false;
let backgroundPollActive = false;

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function updateCacheStateBadge(cache) {
  const badge = document.getElementById('cache-state-badge');
  if (!badge) return;
  badge.classList.remove('is-refreshing', 'is-stale');
  if (!cache || cache.state === 'fresh') {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  badge.hidden = false;
  if (cache.state === 'refreshing') {
    badge.classList.add('is-refreshing');
    badge.textContent = t('common.cacheRefreshing');
  } else if (cache.state === 'stale') {
    badge.classList.add('is-stale');
    badge.textContent = t('common.cacheStale');
  }
}

function updateGeneratedAt(data) {
  const generatedAt = document.getElementById('generated-at');
  if (data?.generatedAt && generatedAt) {
    const d = new Date(data.generatedAt);
    generatedAt.textContent = t('common.updatedAt', { time: d.toLocaleTimeString(getLocale()) });
  }
}

async function fetchStats({ fresh = false } = {}) {
  const url = fresh ? '/api/stats?fresh=1' : '/api/stats';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function getCurrentDateFilter() {
  if (activeRange === 'all') {
    return { from: null, to: null };
  }
  const from = document.getElementById('date-from').value || null;
  const to = document.getElementById('date-to').value || null;
  return { from, to };
}

/** 当前完整筛选条件（时间 + provider/model） */
function getCurrentFilter() {
  const { from, to } = getCurrentDateFilter();
  return { from, to, provider: filterProvider || null, model: filterModel || null };
}

/** 用当前筛选条件重新渲染全部区块 */
function rerender(resetPage = false) {
  if (!fullData) return;
  const filter = getCurrentFilter();
  populateDimensionOptions(filter.from, filter.to);
  applyFilter(filter, resetPage);
}

function applyDateRange(rangeKey, resetPage = true) {
  if (!fullData) return;

  activeRange = rangeKey;
  const { from, to } = getDateRange(rangeKey);

  document.getElementById('date-from').value = from || '';
  document.getElementById('date-to').value = to || '';

  document.querySelectorAll('.time-btn[data-range]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === rangeKey);
  });

  populateDimensionOptions(from, to);
  applyFilter({ from, to, provider: filterProvider || null, model: filterModel || null }, resetPage);
}

/**
 * 按完整筛选条件重算并渲染
 * @param {{ from: string|null, to: string|null, provider: string|null, model: string|null }} filter
 * @param {boolean} resetPage
 */
function applyFilter(filter, resetPage = true) {
  if (!fullData) return;

  const filteredData = filterData(fullData, filter);

  renderSummaryCards(filteredData.summary);
  renderDimensionSummary(filteredData);
  renderBreakdownTable(filteredData);
  destroyCharts();
  renderCharts(filteredData, { timelineMetric });

  allSessions = filteredData.sessions;
  if (resetPage) currentPage = 1;
  renderSessionsTable(allSessions);
}

function renderDataFromFull(resetPage = false) {
  if (!fullData) return;
  updateGeneratedAt(fullData);
  updateCacheStateBadge(fullData.cache);

  rerender(resetPage);
}

async function pollUntilFresh() {
  if (backgroundPollActive) return;
  backgroundPollActive = true;
  try {
    const data = await fetchStats({ fresh: true });
    fullData = data;
    renderDataFromFull(false);
  } catch (err) {
    showToast(t('common.refreshFailed'), true);
  } finally {
    backgroundPollActive = false;
  }
}

async function loadAndRender({ initial = false } = {}) {
  const loading = document.getElementById('loading');
  const mainContent = document.getElementById('main-content');

  try {
    const data = await fetchStats();
    fullData = data;

    if (initial) {
      loading.style.display = 'none';
      mainContent.style.display = 'block';
      applyDateRange('today', true);
    } else {
      renderDataFromFull(false);
    }

    if (data.cache?.state === 'refreshing') {
      pollUntilFresh();
    }
  } catch (err) {
    if (initial) {
      loading.innerHTML = `
        <div style="color: var(--accent-rose); text-align: center;">
          <p style="font-size: 2rem; margin-bottom: 12px;">❌</p>
          <p>${escapeHtml(t('dashboard.loadFailed', { message: err.message }))}</p>
          <p style="color: var(--text-muted); margin-top: 8px;">${escapeHtml(t('dashboard.ensureBackendRunning'))}</p>
        </div>
      `;
    } else {
      showToast(t('common.refreshFailed'), true);
    }
  }
}

function bindEventsOnce() {
  if (eventsBound) return;
  eventsBound = true;

  document.querySelectorAll('.time-btn[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyDateRange(btn.dataset.range);
    });
  });

  document.getElementById('date-from').addEventListener('change', () => {
    document.querySelectorAll('.time-btn[data-range]').forEach((b) => b.classList.remove('active'));
    activeRange = 'custom';
    rerender(true);
  });
  document.getElementById('date-to').addEventListener('change', () => {
    document.querySelectorAll('.time-btn[data-range]').forEach((b) => b.classList.remove('active'));
    activeRange = 'custom';
    rerender(true);
  });

  document.getElementById('provider-filter').addEventListener('change', (e) => {
    filterProvider = e.target.value;
    // Provider 变更后，已选 model 若不属于该 provider 则失效
    if (filterModel && filterProvider && providerOfKey(filterModel) !== filterProvider) {
      filterModel = '';
    }
    rerender(true);
  });

  document.getElementById('model-filter').addEventListener('change', (e) => {
    filterModel = e.target.value;
    // 选定具体模型时同步收窄 Provider，保持两个下拉自洽
    if (filterModel) filterProvider = providerOfKey(filterModel);
    rerender(true);
  });

  document.getElementById('clear-dimension-filter').addEventListener('click', () => {
    filterProvider = '';
    filterModel = '';
    rerender(true);
  });

  document.querySelectorAll('#breakdown-dimension .dim-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      breakdownDimension = btn.dataset.dimension;
      document.querySelectorAll('#breakdown-dimension .dim-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      rerender(false);
    });
  });

  document.querySelectorAll('#breakdown-table thead th[data-breakdown-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.breakdownSort;
      if (breakdownSort === field) {
        breakdownAsc = !breakdownAsc;
      } else {
        breakdownSort = field;
        breakdownAsc = false;
      }
      rerender(false);
    });
  });

  // 点击明细行下钻为筛选条件；再次点击已选中的行则取消
  const breakdownBody = document.getElementById('breakdown-tbody');
  const drillDown = (row) => {
    const key = row.dataset.key;
    if (!key) return;
    if (breakdownDimension === 'provider') {
      filterProvider = filterProvider === key ? '' : key;
      filterModel = '';
    } else {
      filterModel = filterModel === key ? '' : key;
      filterProvider = filterModel ? providerOfKey(filterModel) : '';
    }
    rerender(true);
  };
  breakdownBody.addEventListener('click', (e) => {
    const row = e.target.closest('.breakdown-row');
    if (row) drillDown(row);
  });
  breakdownBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.breakdown-row');
    if (!row) return;
    e.preventDefault();
    drillDown(row);
  });

  document.querySelectorAll('#timeline-metric-switch .metric-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      timelineMetric = btn.dataset.metric;
      document.querySelectorAll('#timeline-metric-switch .metric-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      rerender(false);
    });
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
    const filteredData = filterData(fullData, getCurrentFilter());
    destroyCharts();
    renderCharts(filteredData, { timelineMetric });
  });
}

function setRefreshControlsDisabled(disabled) {
  document.getElementById('refresh-btn').disabled = disabled;
  document.getElementById('refresh-menu-btn').disabled = disabled;
  document.getElementById('refresh-full-btn').disabled = disabled;
}

async function runManualRefresh(full = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  setRefreshControlsDisabled(true);

  try {
    const url = full ? '/api/refresh?full=1' : '/api/refresh';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadAndRender({ initial: false });
  } catch (err) {
    showToast(t('common.refreshFailed'), true);
  } finally {
    btn.classList.remove('spinning');
    setRefreshControlsDisabled(false);
    refreshInFlight = false;
    closeRefreshDropdown();
  }
}

function closeRefreshDropdown() {
  const dropdown = document.getElementById('refresh-dropdown');
  const menuBtn = document.getElementById('refresh-menu-btn');
  if (!dropdown || !menuBtn) return;
  dropdown.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

function openRefreshDropdown() {
  const dropdown = document.getElementById('refresh-dropdown');
  const menuBtn = document.getElementById('refresh-menu-btn');
  dropdown.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  document.getElementById('refresh-full-btn').focus();
}

function bindRefreshControls() {
  document.getElementById('refresh-btn').addEventListener('click', () => {
    runManualRefresh(false);
  });

  const menuBtn = document.getElementById('refresh-menu-btn');
  const dropdown = document.getElementById('refresh-dropdown');
  const fullBtn = document.getElementById('refresh-full-btn');

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdown.hidden) openRefreshDropdown();
    else closeRefreshDropdown();
  });

  fullBtn.addEventListener('click', () => {
    runManualRefresh(true);
  });

  menuBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRefreshDropdown();
    }
  });

  dropdown.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRefreshDropdown();
      menuBtn.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('refresh-group').contains(e.target)) {
      closeRefreshDropdown();
    }
  });
}

async function init() {
  bindEventsOnce();
  bindRefreshControls();
  await loadAndRender({ initial: true });
}

window.addEventListener('openclaw-themechange', () => {
  if (!fullData) return;
  applyFilter(getCurrentFilter(), false);
});

window.addEventListener('openclaw-localechange', () => {
  if (!fullData) return;
  updateGeneratedAt(fullData);
  updateCacheStateBadge(fullData.cache);
  // 下拉占位项、明细表表头与筛选回显均含文案，需整体重绘
  rerender(false);
});

initLocaleControls();
init();
