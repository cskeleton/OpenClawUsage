// Chart.js via CDN — loaded dynamically
let Chart;

// Store chart instances for cleanup
let chartInstances = {
  timeline: null,
  provider: null,
  model: null,
};

async function loadChartJs() {
  if (Chart) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
    script.onload = () => {
      Chart = window.Chart;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
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
    placeholder.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:160px;color:var(--text-secondary);font-size:0.9rem;';
    parent.appendChild(placeholder);
  }
  placeholder.textContent = message;
  placeholder.hidden = false;
  ctx.style.display = 'none';
  return true;
}

/** 清除空态占位，重新显示 canvas */
function clearEmptyChart(ctx) {
  if (!ctx) return;
  const parent = ctx.parentElement;
  const placeholder = parent?.querySelector('.chart-empty');
  if (placeholder) placeholder.hidden = true;
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
function renderTimelineChart(byDate) {
  const ctx = document.getElementById('chart-timeline');
  if (!ctx) return;

  const dates = Object.keys(byDate);
  if (dates.length === 0) {
    renderEmptyChart(ctx, '所选区间暂无数据');
    return;
  }
  clearEmptyChart(ctx);

  const inputData = dates.map((d) => byDate[d].input);
  const outputData = dates.map((d) => byDate[d].output);

  const labels = dates.map((d) => {
    const dt = new Date(d);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  });

  chartInstances.timeline = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Input Tokens',
          data: inputData,
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
          data: outputData,
          borderColor: COLORS.emerald.border,
          backgroundColor: 'rgba(52, 211, 153, 0.08)',
          fill: true,
          tension: 0.4,
          pointRadius: dates.length > 30 ? 0 : 2,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          ...getTooltipConfig(),
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: formatTickValue },
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
    renderEmptyChart(ctx, '所选区间暂无 Provider 费用');
    return;
  }
  clearEmptyChart(ctx);

  const costs = providers.map((p) => byProvider[p].totalCost);

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
            label: (ctx) => ` ${ctx.label}: $${ctx.parsed.toFixed(4)}`,
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
    renderEmptyChart(ctx, '所选区间暂无 Model 用量');
    return;
  }
  clearEmptyChart(ctx);

  const useLogScale = document.getElementById('model-log-scale')?.checked || false;

  // Sort models by total tokens descending for better visualization
  const sorted = models
    .map((key) => ({ key, ...byModel[key] }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));

  const labels = sorted.map((m) => m.model);
  const inputData = sorted.map((m) => m.input);
  const outputData = sorted.map((m) => m.output);

  // Calculate data range to detect if log scale is needed
  const allValues = [...inputData, ...outputData].filter((v) => v > 0);
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
      datasets: [
        {
          label: 'Input Tokens',
          data: inputData,
          backgroundColor: COLORS.indigo.bg,
          borderColor: COLORS.indigo.border,
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Output Tokens',
          data: outputData,
          backgroundColor: COLORS.violet.bg,
          borderColor: COLORS.violet.border,
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'x',
      plugins: {
        tooltip: {
          ...getTooltipConfig(),
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
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

export function destroyCharts() {
  for (const key of Object.keys(chartInstances)) {
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      chartInstances[key] = null;
    }
  }
}

export async function renderCharts(data) {
  await loadChartJs();
  setChartDefaults();

  renderTimelineChart(data.byDate);
  renderProviderChart(data.byProvider);
  renderModelChart(data.byModel);
}
