// API 调用函数
async function fetchPricingConfig() {
  const res = await fetch('/api/pricing');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function updatePricingConfig(config) {
  const res = await fetch('/api/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resetPricingConfig() {
  const res = await fetch('/api/pricing/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAvailableModels() {
  const res = await fetch('/api/pricing/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** @returns {Promise<{ models: Array, unpricedModels?: Array }>} */
async function fetchOpenClawModels() {
  const res = await fetch('/api/openclaw/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 供「复制为自定义」等操作查找完整行数据 */
let lastOpenClawModels = [];

const OPENCLAW_REF_PAGE_SIZE = 10;
/** @type {number} 参考表当前页（从 1 起） */
let openclawRefPage = 1;

/** 「缺少价格的模型」卡片完整列表 */
let lastUnpricedModels = [];
const UNPRICED_PAGE_SIZE = 10;
/** @type {number} */
let unpricedPage = 1;

/**
 * 渲染 OpenClaw 内置价参考表（每页 OPENCLAW_REF_PAGE_SIZE 条）
 * @param {Array} models
 * @param {{ resetPage?: boolean }} [options]
 */
function renderOpenClawReference(models, { resetPage = true } = {}) {
  lastOpenClawModels = models || [];
  const tbody = document.getElementById('openclaw-ref-tbody');
  const pag = document.getElementById('openclaw-ref-pagination');

  if (resetPage) {
    openclawRefPage = 1;
  }

  if (!lastOpenClawModels.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 24px;">
          未在 models.json 中找到带有效单价的模型，或文件不可读（请检查 OPENCLAW_CONFIG_DIR 与 agents/main/agent/models.json）
        </td>
      </tr>
    `;
    if (pag) pag.innerHTML = '';
    return;
  }

  const total = lastOpenClawModels.length;
  const totalPages = Math.max(1, Math.ceil(total / OPENCLAW_REF_PAGE_SIZE));
  if (openclawRefPage > totalPages) openclawRefPage = totalPages;
  if (openclawRefPage < 1) openclawRefPage = 1;

  const start = (openclawRefPage - 1) * OPENCLAW_REF_PAGE_SIZE;
  const pageRows = lastOpenClawModels.slice(start, start + OPENCLAW_REF_PAGE_SIZE);

  const fmt = (n) => {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    if (n === 0) return '0';
    return n.toFixed(4).replace(/\.?0+$/, '');
  };
  const ctx = (cw) => (cw != null ? String(cw) : '—');

  tbody.innerHTML = pageRows
    .map((row) => {
      let badge = '<span class="badge badge-muted">未覆盖</span>';
      if (row.custom) {
        badge = row.custom.enabled
          ? '<span class="badge badge-ok">已覆盖·启用</span>'
          : '<span class="badge badge-warn">已覆盖·禁用</span>';
      }
      const action = row.custom
        ? `<button type="button" class="btn-openclaw-row btn-secondary btn-locate" data-key="${escapeAttr(row.key)}">定位规则</button>`
        : `<button type="button" class="btn-openclaw-row btn-openclaw-row-accent btn-copy-openclaw" data-key="${escapeAttr(row.key)}">复制为自定义</button>`;
      return `
      <tr>
        <td><strong>${escapeHtml(row.key)}</strong><br/><span style="color:var(--text-secondary);font-size:0.85rem;">${escapeHtml(row.displayName || '')}</span></td>
        <td>${fmt(row.cost?.input)}</td>
        <td>${fmt(row.cost?.output)}</td>
        <td>${fmt(row.cost?.cacheRead)}</td>
        <td>${fmt(row.cost?.cacheWrite)}</td>
        <td>${ctx(row.contextWindow)}</td>
        <td>${badge}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');

  if (pag) {
    if (totalPages <= 1) {
      pag.innerHTML = `<span class="pagination-info">共 ${total} 条</span>`;
    } else {
      pag.innerHTML = `
        <button type="button" class="btn-pagination" data-openclaw-page="prev" ${openclawRefPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="pagination-info">第 ${openclawRefPage} / ${totalPages} 页（共 ${total} 条）</span>
        <button type="button" class="btn-pagination" data-openclaw-page="next" ${openclawRefPage >= totalPages ? 'disabled' : ''}>下一页</button>
      `;
    }
  }
}

/**
 * 将 sources 数组格式化为可读标签
 * @param {string[]|undefined} sources
 */
function formatModelSources(sources) {
  if (!sources || !sources.length) return '—';
  const labels = { openclaw: 'openclaw.json', modelsJson: 'models.json' };
  return sources.map((s) => labels[s] || s).join(' · ');
}

/**
 * 渲染「缺少价格的模型」表
 * @param {Array} rows
 * @param {{ resetPage?: boolean }} [options]
 */
function renderUnpricedModels(rows, { resetPage = true } = {}) {
  lastUnpricedModels = rows || [];
  const tbody = document.getElementById('unpriced-models-tbody');
  const pag = document.getElementById('unpriced-models-pagination');
  if (!tbody) return;

  if (resetPage) {
    unpricedPage = 1;
  }

  if (!lastUnpricedModels.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 24px;">
          models.json 中暂无缺少有效单价的模型，或文件不可读
        </td>
      </tr>
    `;
    if (pag) pag.innerHTML = '';
    return;
  }

  const total = lastUnpricedModels.length;
  const totalPages = Math.max(1, Math.ceil(total / UNPRICED_PAGE_SIZE));
  if (unpricedPage > totalPages) unpricedPage = totalPages;
  if (unpricedPage < 1) unpricedPage = 1;

  const start = (unpricedPage - 1) * UNPRICED_PAGE_SIZE;
  const pageRows = lastUnpricedModels.slice(start, start + UNPRICED_PAGE_SIZE);

  const ctx = (cw) => (cw != null ? String(cw) : '—');

  tbody.innerHTML = pageRows
    .map(
      (row) => `
      <tr>
        <td><strong>${escapeHtml(row.key)}</strong></td>
        <td>${escapeHtml(row.displayName || '')}</td>
        <td>${ctx(row.contextWindow)}</td>
        <td style="color: var(--text-secondary);">—</td>
        <td><span style="font-size:0.85rem;">${escapeHtml(formatModelSources(row.sources))}</span></td>
      </tr>`
    )
    .join('');

  if (pag) {
    if (totalPages <= 1) {
      pag.innerHTML = `<span class="pagination-info">共 ${total} 条</span>`;
    } else {
      pag.innerHTML = `
        <button type="button" class="btn-pagination" data-unpriced-page="prev" ${unpricedPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="pagination-info">第 ${unpricedPage} / ${totalPages} 页（共 ${total} 条）</span>
        <button type="button" class="btn-pagination" data-unpriced-page="next" ${unpricedPage >= totalPages ? 'disabled' : ''}>下一页</button>
      `;
    }
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 在下拉框中确保存在指定 provider/model 选项（会话中未出现时）
 * @param {string} key
 */
function ensureModelOption(key) {
  const select = document.getElementById('new-model-select');
  if ([...select.options].some((o) => o.value === key)) return;
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = key;
  select.appendChild(opt);
}

/**
 * 渲染价格表格
 * @param {Object} config
 */
function renderPricingTable(config) {
  const tbody = document.getElementById('pricing-tbody');
  const models = Object.entries(config.pricing || {});

  if (models.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-secondary); padding: 40px;">
          暂无价格配置，添加配置后生效
        </td>
      </tr>
    `;
    return;
  }

  const rows = models
    .map(([model, prices]) => {
      const enabled = prices.enabled !== false;
      return `
    <tr data-model="${escapeAttr(model)}">
      <td style="text-align:center;"><input type="checkbox" class="row-enabled-toggle" data-field="enabled" ${enabled ? 'checked' : ''} title="取消勾选则该行使用 OpenClaw 账面价" /></td>
      <td><strong>${escapeHtml(model)}</strong></td>
      <td><input type="number" class="pricing-input" data-field="input" value="${prices.input}" step="0.01"></td>
      <td><input type="number" class="pricing-input" data-field="output" value="${prices.output}" step="0.01"></td>
      <td><input type="number" class="pricing-input pricing-input--cache" data-field="cacheRead" value="${prices.cacheRead || ''}" step="0.01" placeholder="留空按 Input 原价" title="留空时按该行 Input 单价（$/M）计算 Cache Read 费用"></td>
      <td><input type="number" class="pricing-input pricing-input--cache" data-field="cacheWrite" value="${prices.cacheWrite || ''}" step="0.01" placeholder="留空按 Output 原价" title="留空时按该行 Output 单价（$/M）计算 Cache Write 费用"></td>
      <td><button class="btn-delete" data-model="${escapeAttr(model)}">删除</button></td>
    </tr>
  `;
    })
    .join('');
  tbody.innerHTML = rows;
}

// 填充模型选择下拉框
function populateModelSelect(availableModels, configuredModels) {
  const select = document.getElementById('new-model-select');
  const configuredKeys = Object.keys(configuredModels);

  const options = availableModels
    .filter((model) => !configuredKeys.includes(model))
    .map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`)
    .join('');

  select.innerHTML = `<option value="">选择模型...</option>${options}`;
}

// 加载数据
let pricingConfig = null;

async function loadData() {
  try {
    pricingConfig = await fetchPricingConfig();
    const { models } = await fetchAvailableModels();
    let openclawData = { models: [] };
    try {
      openclawData = await fetchOpenClawModels();
    } catch (e) {
      console.warn('OpenClaw 参考价加载失败:', e);
    }

    const globalEl = document.getElementById('custom-pricing-enabled');
    if (globalEl) {
      globalEl.checked = pricingConfig.enabled !== false;
    }

    renderPricingTable(pricingConfig);
    populateModelSelect(models, pricingConfig.pricing || {});
    renderOpenClawReference(openclawData.models || [], { resetPage: true });
    renderUnpricedModels(openclawData.unpricedModels || [], { resetPage: true });
  } catch (error) {
    alert('加载价格配置失败: ' + error.message);
  }
}

/**
 * 从表格收集 pricing 对象（含每行 enabled）
 */
function collectPricingFromTable() {
  const newPricing = {};
  document.querySelectorAll('#pricing-tbody tr[data-model]').forEach((row) => {
    const model = row.dataset.model;
    const input = parseFloat(row.querySelector('[data-field="input"]').value);
    const output = parseFloat(row.querySelector('[data-field="output"]').value);
    const cacheRead = row.querySelector('[data-field="cacheRead"]').value;
    const cacheWrite = row.querySelector('[data-field="cacheWrite"]').value;
    const enabledEl = row.querySelector('.row-enabled-toggle');
    const enabled = enabledEl ? enabledEl.checked : true;

    if (isNaN(input) || isNaN(output) || input < 0 || output < 0) {
      throw new Error(`${model} 的 Input 和 Output 价格必须为有效的非负数`);
    }

    newPricing[model] = {
      input,
      output,
      cacheRead: cacheRead ? parseFloat(cacheRead) : null,
      cacheWrite: cacheWrite ? parseFloat(cacheWrite) : null,
      enabled,
    };
  });
  return newPricing;
}

// 保存配置
async function savePricingConfig() {
  try {
    const newPricing = collectPricingFromTable();
    pricingConfig.pricing = newPricing;
    pricingConfig.updated = new Date().toISOString();
    const globalEl = document.getElementById('custom-pricing-enabled');
    if (globalEl) {
      pricingConfig.enabled = globalEl.checked;
    }

    await updatePricingConfig(pricingConfig);
    alert('价格配置已保存！成本将使用新价格重新计算。');
    await loadData();
  } catch (error) {
    alert('保存失败: ' + error.message);
  }
}

// 重置配置
async function resetConfig() {
  if (!confirm('确定要重置价格配置吗？将恢复使用 OpenClaw 内置价格。')) {
    return;
  }

  try {
    await resetPricingConfig();
    alert('价格配置已重置！');
    await loadData();
  } catch (error) {
    alert('重置失败: ' + error.message);
  }
}

// 添加新价格
async function addPricing() {
  const modelSelect = document.getElementById('new-model-select');
  const inputPrice = document.getElementById('new-input-price');
  const outputPrice = document.getElementById('new-output-price');
  const cacheReadPrice = document.getElementById('new-cache-read-price');
  const cacheWritePrice = document.getElementById('new-cache-write-price');

  const model = modelSelect.value;
  if (!model) {
    alert('请选择一个模型');
    return;
  }

  const input = parseFloat(inputPrice.value);
  const output = parseFloat(outputPrice.value);

  if (isNaN(input) || isNaN(output) || input < 0 || output < 0) {
    alert('Input 和 Output 价格必须为有效的非负数');
    return;
  }

  const cacheRead = cacheReadPrice.value ? parseFloat(cacheReadPrice.value) : null;
  const cacheWrite = cacheWritePrice.value ? parseFloat(cacheWritePrice.value) : null;

  if (!pricingConfig.pricing) pricingConfig.pricing = {};
  pricingConfig.pricing[model] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    enabled: true,
  };

  // 清空输入
  modelSelect.value = '';
  inputPrice.value = '';
  outputPrice.value = '';
  cacheReadPrice.value = '';
  cacheWritePrice.value = '';

  // 重新渲染
  renderPricingTable(pricingConfig);
  const { models } = await fetchAvailableModels();
  populateModelSelect(models, pricingConfig.pricing);
  try {
    const oc = await fetchOpenClawModels();
    renderOpenClawReference(oc.models || [], { resetPage: true });
    renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
  } catch (_) {
    /* 忽略 */
  }
}

// 删除价格
function deletePricing(model) {
  if (!confirm(`确定要删除 ${model} 的价格配置吗？`)) {
    return;
  }

  delete pricingConfig.pricing[model];
  renderPricingTable(pricingConfig);

  fetchAvailableModels().then(({ models }) => {
    populateModelSelect(models, pricingConfig.pricing);
  });
  fetchOpenClawModels()
    .then((oc) => {
      renderOpenClawReference(oc.models || [], { resetPage: true });
      renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
    })
    .catch(() => {});
}

/**
 * 全局开关：立即保存
 */
async function onGlobalEnabledChange(e) {
  if (!pricingConfig) return;
  const checked = e.target.checked;
  pricingConfig.enabled = checked;
  try {
    await updatePricingConfig(pricingConfig);
    alert(
      checked
        ? '已启用自定义单价（按上方规则重算理论成本）'
        : '已切换为使用 OpenClaw 会话中的账面成本（未覆盖的模型亦如此）'
    );
    await loadData();
  } catch (err) {
    alert('保存失败: ' + err.message);
    e.target.checked = !checked;
    pricingConfig.enabled = !checked;
  }
}

/**
 * 从参考表复制到「添加新价格」表单并滚动
 * @param {string} key
 */
function copyOpenClawToForm(key) {
  const row = lastOpenClawModels.find((m) => m.key === key);
  if (!row) return;

  ensureModelOption(key);
  const select = document.getElementById('new-model-select');
  select.value = key;

  document.getElementById('new-input-price').value = row.cost.input;
  document.getElementById('new-output-price').value = row.cost.output;
  document.getElementById('new-cache-read-price').value =
    row.cost.cacheRead !== 0 && row.cost.cacheRead != null ? row.cost.cacheRead : '';
  document.getElementById('new-cache-write-price').value =
    row.cost.cacheWrite !== 0 && row.cost.cacheWrite != null ? row.cost.cacheWrite : '';

  document.getElementById('add-pricing-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * 高亮表格中的自定义规则行
 * @param {string} key
 */
function locatePricingRow(key) {
  const row = document.querySelector(`#pricing-tbody tr[data-model="${CSS.escape(key)}"]`);
  if (!row) {
    alert('未找到该规则，可能尚未保存到自定义表。');
    return;
  }
  row.classList.add('pricing-row-highlight');
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => row.classList.remove('pricing-row-highlight'), 2500);
}

// 事件监听
document.getElementById('save-pricing-btn').addEventListener('click', savePricingConfig);
document.getElementById('reset-pricing-btn').addEventListener('click', resetConfig);
document.getElementById('add-pricing-btn').addEventListener('click', addPricing);

document.getElementById('custom-pricing-enabled').addEventListener('change', onGlobalEnabledChange);

document.getElementById('pricing-tbody').addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-delete')) {
    const model = e.target.dataset.model;
    deletePricing(model);
  }
});

document.getElementById('openclaw-ref-tbody').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy-openclaw');
  const locBtn = e.target.closest('.btn-locate');
  if (copyBtn) {
    copyOpenClawToForm(copyBtn.dataset.key);
  } else if (locBtn) {
    locatePricingRow(locBtn.dataset.key);
  }
});

document.getElementById('openclaw-ref-pagination')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-openclaw-page]');
  if (!btn || btn.disabled) return;
  const dir = btn.dataset.openclawPage;
  const totalPages = Math.max(1, Math.ceil(lastOpenClawModels.length / OPENCLAW_REF_PAGE_SIZE));
  if (dir === 'prev') openclawRefPage = Math.max(1, openclawRefPage - 1);
  if (dir === 'next') openclawRefPage = Math.min(totalPages, openclawRefPage + 1);
  renderOpenClawReference(lastOpenClawModels, { resetPage: false });
});

document.getElementById('unpriced-models-pagination')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-unpriced-page]');
  if (!btn || btn.disabled) return;
  const dir = btn.dataset.unpricedPage;
  const totalPages = Math.max(1, Math.ceil(lastUnpricedModels.length / UNPRICED_PAGE_SIZE));
  if (dir === 'prev') unpricedPage = Math.max(1, unpricedPage - 1);
  if (dir === 'next') unpricedPage = Math.min(totalPages, unpricedPage + 1);
  renderUnpricedModels(lastUnpricedModels, { resetPage: false });
});

/**
 * 参考卡片折叠：三角按钮切换面板，默认折叠（HTML 上 panel 带 hidden）
 */
function initPricingCollapsibles() {
  document.querySelectorAll('.pricing-collapse-toggle').forEach((btn) => {
    const panelId = btn.getAttribute('aria-controls');
    if (!panelId) return;
    const panel = document.getElementById(panelId);
    if (!panel) return;

    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      btn.setAttribute('aria-expanded', String(next));
      if (next) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
  });
}

initPricingCollapsibles();

// 初始化
loadData();
