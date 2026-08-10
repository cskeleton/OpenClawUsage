// Chart.js via CDN — loaded dynamically
import { t } from './i18n.js';
import { buildModelChartRows } from './model-chart-data.js';

let Chart;

// Store chart instances for cleanup
let chartInstances = {
  timeline: null,
  provider: null,
  model: null,
};

/** Chart.js 单例加载 Promise：并发调用共享同一次加载，避免重复插入脚本 */
let chartJsPromise = null;

function loadChartJs() {
  if (Chart) return Promise.resolve();
  if (chartJsPromise) return chartJsPromise;

  chartJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
    script.onload = () => {
      Chart = window.Chart;
      resolve();
    };
    script.onerror = (err) => {
      // 失败后允许后续渲染重新尝试加载
      chartJsPromise = null;
      reject(err);
    };
    document.head.appendChild(script);
  });
  return chartJsPromise;
}

// Color palette
const COLORS = {
  indigo: { bg: 'rgba(99, 102, 241, 0.6)', border: '#818cf8' },
  violet: { bg: 'rgba(139, 92, 246, 0.6)', border: '#a78bfa' },
  cyan: { bg: 'rgba(34, 211, 238, 0.6)', border: '#22d3ee' },
  emerald: { bg: 'rgba(52, 211, 153, 0.6)', border: '#34d399' },
  amber: { bg: 'rgba(251, 191, 36, 0.6)', border: '#fbbf24' },
  rose: { bg: 'rgba(251, 113, 133, 0.6)', border: '#fb7185' },
  orange: { bg: 'rgba(251, 146, 60, 0.6)', border: '#fb923c' },
  sky: { bg: 'rgba(56, 189, 248, 0.6)', border: '#38bdf8' },
};

const COLOR_KEYS = Object.keys(COLORS);

function getColor(index) {
  return COLORS[COLOR_KEYS[index % COLOR_KEYS.length]];
}

/**
 * 从 CSS 变量读取当前主题的图表配色（随浅色/深色切换）
 * @returns {{ text: string, border: string, grid: string, tooltipBg: string, tooltipTitle: string, tooltipBody: string, tooltipBorder: string }}
 */
function getChartThemeFromCss() {
  const root = document.documentElement;
  const s = getComputedStyle(root);
  const text = (s.getPropertyValue('--chart-text') || '#78716c').trim();
  const border = (s.getPropertyValue('--chart-border') || 'rgba(234, 88, 12, 0.12)').trim();
  const grid = (s.getPropertyValue('--chart-grid') || 'rgba(234, 88, 12, 0.08)').trim();
  const tooltipBg = (s.getPropertyValue('--chart-tooltip-bg') || 'rgba(28, 25, 23, 0.92)').trim();
  const tooltipTitle = (s.getPropertyValue('--chart-tooltip-title') || '#fafaf9').trim();
  const tooltipBody = (s.getPropertyValue('--chart-tooltip-body') || '#a8a29e').trim();
  const tooltipBorder = (s.getPropertyValue('--chart-tooltip-border') || 'rgba(249, 115, 22, 0.35)').trim();
  return { text, border, grid, tooltipBg, tooltipTitle, tooltipBody, tooltipBorder };
}

// Common chart defaults（随主题刷新）
function setChartDefaults() {
  const t = getChartThemeFromCss();
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.border;
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
  Chart.defaults.plugins.legend.labels.padding = 16;
}

function formatTickValue(v) {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return v;
}

/** 图表内的费用格式化：小额保留更多位，避免显示成 $0.00 */
function formatCostValue(v) {
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(3);
  if (v > 0) return '$' + v.toFixed(6);
  return '$0';
}

export function formatProviderTooltipLabel(label, value, total) {
  const cost = Number.isFinite(value) ? value : 0;
  const share = Number.isFinite(total) && total > 0 ? (cost / total) * 100 : 0;
  return ` ${label}: ${formatCostValue(cost)} (${share.toFixed(1)}%)`;
}

const MODEL_INPUT_COLORS = {
  cacheRead: 'rgba(99, 102, 241, 0.88)',
  cacheWrite: 'rgba(99, 102, 241, 0.58)',
  input: 'rgba(99, 102, 241, 0.28)',
};

const MODEL_INPUT_SEGMENTS = ['cacheRead', 'cacheWrite', 'input'];

function getInputSegmentBorderRadius(rows, segment) {
  return (context) => {
    const row = rows[context.dataIndex] ?? {};
    const visibleSegments = MODEL_INPUT_SEGMENTS.filter((name) => (
      Number.isFinite(row[name]) && row[name] > 0
    ));

    if (!visibleSegments.includes(segment)) return 0;

    return {
      bottomLeft: visibleSegments[0] === segment ? 6 : 0,
      bottomRight: visibleSegments[0] === segment ? 6 : 0,
      topLeft: visibleSegments.at(-1) === segment ? 6 : 0,
      topRight: visibleSegments.at(-1) === segment ? 6 : 0,
    };
  };
}

export function buildModelDatasets(rows) {
  return [
    {
      label: t('dashboard.chartCacheRead'),
      stack: 'input',
      data: rows.map((row) => row.cacheRead),
      backgroundColor: MODEL_INPUT_COLORS.cacheRead,
      borderColor: COLORS.indigo.border,
      borderWidth: 1,
      borderRadius: getInputSegmentBorderRadius(rows, 'cacheRead'),
      borderSkipped: false,
    },
    {
      label: t('dashboard.chartCacheWrite'),
      stack: 'input',
      data: rows.map((row) => row.cacheWrite),
      backgroundColor: MODEL_INPUT_COLORS.cacheWrite,
      borderColor: COLORS.indigo.border,
      borderWidth: 1,
      borderRadius: getInputSegmentBorderRadius(rows, 'cacheWrite'),
      borderSkipped: false,
    },
    {
      label: t('dashboard.chartInput'),
      stack: 'input',
      data: rows.map((row) => row.input),
      backgroundColor: MODEL_INPUT_COLORS.input,
      borderColor: COLORS.indigo.border,
      borderWidth: 1,
      borderRadius: getInputSegmentBorderRadius(rows, 'input'),
      borderSkipped: false,
    },
    {
      label: t('dashboard.chartOutput'),
      stack: 'output',
      data: rows.map((row) => row.output),
      backgroundColor: COLORS.violet.bg,
      borderColor: COLORS.violet.border,
      borderWidth: 1,
      borderRadius: 6,
      borderSkipped: false,
    },
  ];
}

export function formatModelTotalInput(items) {
  const total = items.reduce((sum, item) => (
    item.dataset.stack === 'input' && Number.isFinite(item.parsed?.y)
      ? sum + item.parsed.y
      : sum
  ), 0);
  return `${t('dashboard.chartTotalInput')}: ${total.toLocaleString()}`;
}

/**
 * 在 canvas 容器里渲染「暂无数据」文案并清空画布。返回 true 表示已走空态分支。
 * @param {HTMLCanvasElement|null} ctx
 * @param {string} message
 */
function renderEmptyChart(ctx, message) {
  if (!ctx) return true;
  const parent = ctx.parentElement;
  if (!parent) return true;
  let placeholder = parent.querySelector('.chart-empty');
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'chart-empty';
    placeholder.style.cssText = 'align-items:center;justify-content:center;min-height:160px;color:var(--text-secondary);font-size:0.9rem;';
    parent.appendChild(placeholder);
  }
  placeholder.textContent = message;
  placeholder.hidden = false;
  // display 必须与 hidden 同步设置：内联 display 会压过 [hidden] 的默认样式
  placeholder.style.display = 'flex';
  ctx.style.display = 'none';
  return true;
}

/** 清除空态占位，重新显示 canvas */
function clearEmptyChart(ctx) {
  if (!ctx) return;
  const parent = ctx.parentElement;
  const placeholder = parent?.querySelector('.chart-empty');
  if (placeholder) {
    placeholder.hidden = true;
    placeholder.style.display = 'none';
    // 清空文案，避免语言切换后残留上一语言的空态文字
    placeholder.textContent = '';
  }
  ctx.style.display = '';
}

function getTooltipConfig() {
  const t = getChartThemeFromCss();
  return {
    backgroundColor: t.tooltipBg,
    borderColor: t.tooltipBorder,
    borderWidth: 1,
    titleColor: t.tooltipTitle,
    bodyColor: t.tooltipBody,
    padding: 12,
    cornerRadius: 12,
  };
}

// ---- Timeline Chart ----
/**
 * @param {Record<string, object>} byDate
 * @param {'tokens'|'cost'} metric 展示 Token 分量还是每日费用
 */
function renderTimelineChart(byDate, metric = 'tokens') {
  const ctx = document.getElementById('chart-timeline');
  if (!ctx) return;

  const dates = Object.keys(byDate);
  if (dates.length === 0) {
    renderEmptyChart(ctx, t('dashboard.chartEmptyRange'));
    return;
  }
  clearEmptyChart(ctx);

  const labels = dates.map((d) => {
    const dt = new Date(d);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  });

  const isCost = metric === 'cost';
  const datasets = isCost
    ? [
        {
          label: t('dashboard.metricCost'),
          data: dates.map((d) => byDate[d].totalCost),
          borderColor: COLORS.amber.border,
          backgroundColor: 'rgba(251, 191, 36, 0.12)',
          fill: true,
          tension: 0.4,
          pointRadius: dates.length > 30 ? 0 : 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
      ]
    : [
        {
          label: 'Input Tokens',
          data: dates.map((d) => byDate[d].input),
          borderColor: COLORS.cyan.border,
          backgroundColor: 'rgba(34, 211, 238, 0.08)',
          fill: true,
          tension: 0.4,
          pointRadius: dates.length > 30 ? 0 : 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
        {
          label: 'Output Tokens',
          data: dates.map((d) => byDate[d].output),
          borderColor: COLORS.emerald.border,
          backgroundColor: 'rgba(52, 211, 153, 0.08)',
          fill: true,
          tension: 0.4,
          pointRadius: dates.length > 30 ? 0 : 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
      ];

  chartInstances.timeline = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !isCost },
        tooltip: {
          ...getTooltipConfig(),
          callbacks: {
            label: (ctx) => (isCost
              ? `${ctx.dataset.label}: ${formatCostValue(ctx.parsed.y)}`
              : `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: isCost ? formatCostValue : formatTickValue },
          grid: { color: getChartThemeFromCss().grid },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

// ---- Provider Doughnut ----
function renderProviderChart(byProvider) {
  const ctx = document.getElementById('chart-provider');
  if (!ctx) return;

  const providers = Object.keys(byProvider);
  if (providers.length === 0) {
    renderEmptyChart(ctx, t('dashboard.chartEmptyProvider'));
    return;
  }
  clearEmptyChart(ctx);

  const costs = providers.map((p) => byProvider[p].totalCost);
  const totalCost = costs.reduce((total, cost) => (
    Number.isFinite(cost) ? total + cost : total
  ), 0);

  chartInstances.provider = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: providers,
      datasets: [
        {
          data: costs,
          backgroundColor: providers.map((_, i) => getColor(i).bg),
          borderColor: providers.map((_, i) => getColor(i).border),
          borderWidth: 2,
          hoverOffset: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          ...getTooltipConfig(),
          callbacks: {
            label: (ctx) => formatProviderTooltipLabel(ctx.label, ctx.parsed, totalCost),
          },
        },
      },
    },
  });
}

// ---- Model Bar Chart (with log scale support) ----
function renderModelChart(byModel) {
  const ctx = document.getElementById('chart-model');
  if (!ctx) return;

  const models = Object.keys(byModel);
  if (models.length === 0) {
    renderEmptyChart(ctx, t('dashboard.chartEmptyModel'));
    return;
  }
  clearEmptyChart(ctx);

  const useLogScale = document.getElementById('model-log-scale')?.checked || false;
  const mergeDateCheckpoints = document.getElementById('model-merge-checkpoints')?.checked ?? true;
  const rows = buildModelChartRows(byModel, { mergeDateCheckpoints });
  const labels = rows.map((row) => row.label);
  const datasets = buildModelDatasets(rows);

  // Calculate data range to detect if log scale is needed
  const allValues = rows.flatMap((row) => [row.totalInput, row.output]).filter((v) => v > 0);
  const maxVal = Math.max(...allValues, 1);
  const minVal = Math.min(...allValues, 1);
  const dynamicRange = maxVal / minVal;

  // Auto-suggest log scale if range > 100x
  const logHint = document.getElementById('model-log-scale')?.parentElement;
  if (logHint && dynamicRange > 100 && !useLogScale) {
    logHint.classList.add('hint-pulse');
  } else if (logHint) {
    logHint.classList.remove('hint-pulse');
  }

  chartInstances.model = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'x',
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          ...getTooltipConfig(),
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
            footer: formatModelTotalInput,
          },
        },
      },
      scales: {
        y: {
          type: useLogScale ? 'logarithmic' : 'linear',
          beginAtZero: !useLogScale,
          min: useLogScale ? 1 : undefined,
          ticks: {
            callback: (v) => {
              if (useLogScale) {
                // Only show labels at powers of 10
                if (v === 1 || v === 10 || v === 100 || v === 1000
                  || v === 10000 || v === 100000 || v === 1000000
                  || v === 10000000 || v === 100000000) {
                  return formatTickValue(v);
                }
                return '';
              }
              return formatTickValue(v);
            },
          },
          grid: { color: getChartThemeFromCss().grid },
        },
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
          },
        },
      },
    },
  });
}

// ---- Public API ----

/**
 * 渲染代次：每次 renderCharts / destroyCharts 都推进。
 * Chart.js 加载或前一次渲染尚未结束时又发生新的筛选，旧的那次必须放弃，
 * 否则会创建出 destroyCharts() 追踪不到的实例并覆盖最新数据。
 */
let renderGeneration = 0;

export function destroyCharts() {
  renderGeneration += 1;
  for (const key of Object.keys(chartInstances)) {
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      chartInstances[key] = null;
    }
  }
}

export async function renderCharts(data, { timelineMetric = 'tokens' } = {}) {
  const generation = ++renderGeneration;

  await loadChartJs();
  // 等待期间又发生了新的渲染/销毁：本次已过期，直接放弃
  if (generation !== renderGeneration) return;

  setChartDefaults();

  renderTimelineChart(data.byDate, timelineMetric);
  renderProviderChart(data.byProvider);
  renderModelChart(data.byModel);
}
