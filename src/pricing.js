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

/** 根据全局「启用」开关，为下方配置区叠加灰色强调（仍可交互） */
function syncCustomPricingDisabledUI() {
  const el = document.getElementById('custom-pricing-enabled');
  const stack = document.getElementById('pricing-config-stack');
  if (!el || !stack) return;
  stack.classList.toggle('pricing-config-stack--custom-disabled', !el.checked);
}

/**
 * 将当前 pricingConfig 同步到服务端（自动保存）
 */
async function persistPricingConfigToServer() {
  if (!pricingConfig) return;
  const globalEl = document.getElementById('custom-pricing-enabled');
  if (globalEl) {
    pricingConfig.enabled = globalEl.checked;
  }
  try {
    const res = await updatePricingConfig(pricingConfig);
    if (res && res.updated) {
      pricingConfig.updated = res.updated;
    }
  } catch (err) {
    alert('同步失败: ' + err.message);
    await loadData();
    throw err;
  }
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
 * 客户端校验通配符 / 正则键（与后端 pricing.js 语义一致）
 * @param {string} matchType
 * @param {string} key
 * @returns {string} 空字符串表示通过，否则为错误信息
 */
function validateClientPattern(matchType, key) {
  const k = String(key).trim();
  if (!k) return '请填写模型键或模式';
  if (matchType === 'regex') {
    if (!k.startsWith('/')) return '正则键须以 / 开头（如 /pattern/i）';
    const lastSlash = k.lastIndexOf('/');
    if (lastSlash <= 0) return '正则键须为 /pattern/ 或 /pattern/flags 形式';
    const body = k.slice(1, lastSlash);
    const flags = k.slice(lastSlash + 1);
    try {
      void new RegExp(body, flags);
      return '';
    } catch (e) {
      return e.message || '正则无法编译';
    }
  }
  if (matchType === 'wildcard') {
    try {
      let out = '';
      for (let i = 0; i < k.length; i++) {
        const c = k[i];
        if (c === '*') out += '.*';
        else if (c === '?') out += '.';
        else if ('\\^$+{}[]|().'.includes(c)) out += `\\${c}`;
        else out += c;
      }
      void new RegExp(`^${out}$`);
      return '';
    } catch (e) {
      return e.message || '通配符无法构成有效规则';
    }
  }
  return '';
}

/** 添加规则区：通配符/正则时显示提示并校验 combobox 内容 */
function syncNewMatchTypeUI() {
  const mtEl = document.getElementById('new-match-type');
  const hint = document.getElementById('new-pattern-hint');
  const errEl = document.getElementById('new-pattern-error');
  if (!mtEl) return;
  const mt = mtEl.value;
  if (mt === 'exact') {
    if (hint) hint.hidden = true;
    if (errEl) errEl.hidden = true;
  } else {
    if (hint) hint.hidden = false;
    onNewModelKeyInput();
  }
}

/** combobox 在通配符/正则模式下实时校验 */
function onNewModelKeyInput() {
  const mtEl = document.getElementById('new-match-type');
  const errEl = document.getElementById('new-pattern-error');
  if (!mtEl || !errEl) return;
  const mt = mtEl.value;
  if (mt === 'exact') return;
  const key = document.getElementById('new-model-input')?.value ?? '';
  if (!key.trim()) {
    errEl.hidden = true;
    return;
  }
  const err = validateClientPattern(mt, key);
  if (err) {
    errEl.textContent = err;
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }
}

/**
 * 在 datalist 中确保存在指定 provider/model 建议项（参考表复制等场景）
 * @param {string} key
 */
function ensureModelDatalistOption(key) {
  const dl = document.getElementById('new-model-datalist');
  if (!dl) return;
  if ([...dl.querySelectorAll('option')].some((o) => o.value === key)) return;
  const opt = document.createElement('option');
  opt.value = key;
  dl.appendChild(opt);
}

/** 当前正在编辑的行（原始键），与 pricingConfig 中的 key 一致 */
let pricingTableEditingKey = null;

/**
 * 只读单元格展示价格数字
 * @param {number|null|undefined} n
 */
function fmtDisplayPrice(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  return String(n);
}

/**
 * 匹配类型中文标签（只读展示）
 * @param {'exact'|'wildcard'|'regex'} mt
 */
function matchTypeBadgeHtml(mt) {
  if (mt === 'wildcard') {
    return '<span class="badge badge-ok">通配符</span>';
  }
  if (mt === 'regex') {
    return '<span class="badge badge-warn">正则</span>';
  }
  return '<span class="badge badge-muted">精确</span>';
}

/**
 * 渲染价格表格（默认只读；一行「编辑」后进入编辑模式）
 * @param {Object} config
 */
function renderPricingTable(config) {
  const tbody = document.getElementById('pricing-tbody');
  const models = Object.entries(config.pricing || {});

  if (models.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 40px;">
          暂无价格配置，添加配置后生效
        </td>
      </tr>
    `;
    return;
  }

  const rows = models
    .map(([model, prices]) => {
      const enabled = prices.enabled !== false;
      const mt =
        prices.matchType === 'wildcard' || prices.matchType === 'regex' ? prices.matchType : 'exact';
      const isEditing = pricingTableEditingKey === model;
      const mtSel = (v) => (mt === v ? ' selected' : '');

      if (isEditing) {
        return `
    <tr data-model="${escapeAttr(model)}" data-row-editing="true">
      <td class="col-center">
        <label class="toggle-switch" title="关闭则该行使用 OpenClaw 账面价">
          <input type="checkbox" class="row-enabled-toggle" data-field="enabled" ${enabled ? 'checked' : ''} aria-label="启用该行自定义单价" />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </td>
      <td class="col-model-key">
        <input type="text" class="pricing-key-input" data-field="modelKey" value="${escapeAttr(model)}" list="new-model-datalist" spellcheck="false" autocomplete="off" />
      </td>
      <td class="col-center">
        <select class="pricing-match-select" data-field="matchType" title="匹配类型">
          <option value="exact"${mtSel('exact')}>精确</option>
          <option value="wildcard"${mtSel('wildcard')}>通配符</option>
          <option value="regex"${mtSel('regex')}>正则</option>
        </select>
      </td>
      <td class="col-numeric"><input type="number" class="pricing-input" data-field="input" value="${prices.input}" step="0.01"></td>
      <td class="col-numeric"><input type="number" class="pricing-input" data-field="output" value="${prices.output}" step="0.01"></td>
      <td class="col-numeric"><input type="number" class="pricing-input pricing-input--cache" data-field="cacheRead" value="${prices.cacheRead ?? ''}" step="0.01" placeholder="留空按 Input 原价" title="留空时按该行 Input 单价计算 Cache Read 费用"></td>
      <td class="col-numeric"><input type="number" class="pricing-input pricing-input--cache" data-field="cacheWrite" value="${prices.cacheWrite ?? ''}" step="0.01" placeholder="留空按 Output 原价" title="留空时按该行 Output 单价计算 Cache Write 费用"></td>
      <td class="col-center pricing-actions-cell">
        <button type="button" class="btn-row-done btn-primary" data-original-model="${escapeAttr(model)}">完成</button>
        <button type="button" class="btn-row-cancel btn-secondary">取消</button>
      </td>
    </tr>
  `;
      }

      return `
    <tr data-model="${escapeAttr(model)}">
      <td class="col-center">
        <label class="toggle-switch" title="关闭则该行使用 OpenClaw 账面价">
          <input type="checkbox" class="row-enabled-toggle" data-field="enabled" ${enabled ? 'checked' : ''} aria-label="启用该行自定义单价" />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </td>
      <td class="col-model-key"><span class="pricing-cell-readonly"><strong>${escapeHtml(model)}</strong></span></td>
      <td class="col-center">${matchTypeBadgeHtml(mt)}</td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.input)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.output)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.cacheRead != null ? prices.cacheRead : null)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.cacheWrite != null ? prices.cacheWrite : null)}</span></td>
      <td class="col-center pricing-actions-cell">
        <button type="button" class="btn-row-edit btn-secondary" data-model="${escapeAttr(model)}">编辑</button>
        <button type="button" class="btn-delete" data-model="${escapeAttr(model)}">删除</button>
      </td>
    </tr>
  `;
    })
    .join('');
  tbody.innerHTML = rows;
}

/**
 * 进入行编辑
 * @param {string} model
 */
function beginRowEdit(model) {
  if (pricingTableEditingKey !== null && pricingTableEditingKey !== model) {
    alert('请先完成或取消正在编辑的行');
    return;
  }
  pricingTableEditingKey = model;
  renderPricingTable(pricingConfig);
  requestAnimationFrame(() => {
    document
      .querySelector(`#pricing-tbody tr[data-model="${CSS.escape(model)}"] .pricing-key-input`)
      ?.focus();
  });
}

/**
 * 取消行编辑（丢弃未保存到内存的修改，从 pricingConfig 重绘）
 */
function cancelRowEdit() {
  pricingTableEditingKey = null;
  renderPricingTable(pricingConfig);
}

/**
 * 将编辑行写回 pricingConfig（内存），并退出编辑
 * @param {string} originalModel
 */
async function applyRowEdit(originalModel) {
  const row = document.querySelector(`#pricing-tbody tr[data-model="${CSS.escape(originalModel)}"]`);
  if (!row) return;

  const newKey = (row.querySelector('[data-field="modelKey"]')?.value ?? '').trim();
  if (!newKey) {
    alert('模型键不能为空');
    return;
  }

  const matchTypeEl = row.querySelector('[data-field="matchType"]');
  const matchType = matchTypeEl ? matchTypeEl.value : 'exact';
  const input = parseFloat(row.querySelector('[data-field="input"]').value);
  const output = parseFloat(row.querySelector('[data-field="output"]').value);
  const cacheRead = row.querySelector('[data-field="cacheRead"]').value;
  const cacheWrite = row.querySelector('[data-field="cacheWrite"]').value;
  const enabledEl = row.querySelector('.row-enabled-toggle');
  const enabled = enabledEl ? enabledEl.checked : true;

  if (isNaN(input) || isNaN(output) || input < 0 || output < 0) {
    alert('Input 和 Output 价格必须为有效的非负数');
    return;
  }

  const patErr = matchType !== 'exact' ? validateClientPattern(matchType, newKey) : '';
  if (patErr) {
    alert(`${newKey}：${patErr}`);
    return;
  }

  if (!pricingConfig.pricing) pricingConfig.pricing = {};
  if (newKey !== originalModel && pricingConfig.pricing[newKey]) {
    alert('已存在相同键的规则，请使用其他键名');
    return;
  }

  const entry = {
    input,
    output,
    cacheRead: cacheRead ? parseFloat(cacheRead) : null,
    cacheWrite: cacheWrite ? parseFloat(cacheWrite) : null,
    enabled,
  };
  if (matchType !== 'exact') {
    entry.matchType = matchType;
  }

  if (newKey !== originalModel) {
    delete pricingConfig.pricing[originalModel];
  }
  pricingConfig.pricing[newKey] = entry;
  pricingTableEditingKey = null;
  try {
    await persistPricingConfigToServer();
    renderPricingTable(pricingConfig);
    fetchAvailableModels().then(({ models }) => {
      populateModelDatalist(models, pricingConfig.pricing);
    });
    fetchOpenClawModels()
      .then((oc) => {
        renderOpenClawReference(oc.models || [], { resetPage: true });
        renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
      })
      .catch(() => {});
  } catch {
    /* persistPricingConfigToServer 已 loadData */
  }
}

/**
 * 填充「添加新价格」combobox 的 datalist（未配置的会话模型候选）
 * @param {string[]} availableModels
 * @param {Record<string, unknown>} configuredModels
 */
function populateModelDatalist(availableModels, configuredModels) {
  const dl = document.getElementById('new-model-datalist');
  if (!dl) return;
  const configuredKeys = Object.keys(configuredModels);
  dl.innerHTML = '';
  availableModels
    .filter((m) => !configuredKeys.includes(m))
    .forEach((model) => {
      const opt = document.createElement('option');
      opt.value = model;
      dl.appendChild(opt);
    });
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
    syncCustomPricingDisabledUI();

    pricingTableEditingKey = null;
    renderPricingTable(pricingConfig);
    populateModelDatalist(models, pricingConfig.pricing || {});
    renderOpenClawReference(openclawData.models || [], { resetPage: true });
    renderUnpricedModels(openclawData.unpricedModels || [], { resetPage: true });
    syncNewModelClearVisibility();
  } catch (error) {
    alert('加载价格配置失败: ' + error.message);
  } finally {
    syncCustomPricingDisabledUI();
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
  if (pricingTableEditingKey !== null) {
    alert('请先完成或取消表格中正在编辑的行');
    return;
  }
  const matchTypeEl = document.getElementById('new-match-type');
  const modelInput = document.getElementById('new-model-input');
  const inputPrice = document.getElementById('new-input-price');
  const outputPrice = document.getElementById('new-output-price');
  const cacheReadPrice = document.getElementById('new-cache-read-price');
  const cacheWritePrice = document.getElementById('new-cache-write-price');
  const errEl = document.getElementById('new-pattern-error');

  const matchType = matchTypeEl ? matchTypeEl.value : 'exact';
  const model = (modelInput?.value ?? '').trim();
  if (!model) {
    alert('请填写或选择 provider/model（或通配符/正则模式）');
    return;
  }
  if (matchType !== 'exact') {
    const perr = validateClientPattern(matchType, model);
    if (perr) {
      if (errEl) {
        errEl.textContent = perr;
        errEl.hidden = false;
      }
      return;
    }
    if (errEl) errEl.hidden = true;
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
  if (pricingConfig.pricing[model]) {
    alert('已存在相同键的规则，请删除后再添加或保存后编辑');
    return;
  }

  const row = {
    input,
    output,
    cacheRead,
    cacheWrite,
    enabled: true,
  };
  if (matchType !== 'exact') {
    row.matchType = matchType;
  }
  pricingConfig.pricing[model] = row;

  // 清空输入
  if (modelInput) modelInput.value = '';
  inputPrice.value = '';
  outputPrice.value = '';
  cacheReadPrice.value = '';
  cacheWritePrice.value = '';
  if (matchTypeEl) matchTypeEl.value = 'exact';
  syncNewMatchTypeUI();
  syncNewModelClearVisibility();

  try {
    await persistPricingConfigToServer();
    renderPricingTable(pricingConfig);
    const { models } = await fetchAvailableModels();
    populateModelDatalist(models, pricingConfig.pricing);
    try {
      const oc = await fetchOpenClawModels();
      renderOpenClawReference(oc.models || [], { resetPage: true });
      renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
    } catch (_) {
      /* 忽略 */
    }
  } catch {
    /* persistPricingConfigToServer 已 loadData */
  }
}

// 删除价格
async function deletePricing(model) {
  if (!confirm(`确定要删除 ${model} 的价格配置吗？`)) {
    return;
  }

  if (pricingTableEditingKey === model) {
    pricingTableEditingKey = null;
  }
  delete pricingConfig.pricing[model];
  try {
    await persistPricingConfigToServer();
    renderPricingTable(pricingConfig);
    fetchAvailableModels().then(({ models }) => {
      populateModelDatalist(models, pricingConfig.pricing);
    });
    fetchOpenClawModels()
      .then((oc) => {
        renderOpenClawReference(oc.models || [], { resetPage: true });
        renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
      })
      .catch(() => {});
  } catch {
    /* persistPricingConfigToServer 已 loadData */
  }
}

/**
 * 全局开关：立即同步
 */
async function onGlobalEnabledChange(e) {
  if (!pricingConfig) return;
  const checked = e.target.checked;
  pricingConfig.enabled = checked;
  syncCustomPricingDisabledUI();
  try {
    await persistPricingConfigToServer();
  } catch {
    e.target.checked = !checked;
    pricingConfig.enabled = !checked;
    syncCustomPricingDisabledUI();
  }
}

/**
 * 行内启用开关：立即同步（与是否处于编辑模式无关）
 * @param {Event} e
 */
function onRowEnabledChange(e) {
  const t = e.target;
  if (!t.classList.contains('row-enabled-toggle')) return;
  const row = t.closest('tr[data-model]');
  if (!row || !pricingConfig?.pricing) return;
  const model = row.dataset.model;
  const entry = pricingConfig.pricing[model];
  if (!entry) return;
  entry.enabled = t.checked;
  persistPricingConfigToServer();
}

/** 添加区模型输入右侧「清空」按钮显隐 */
function syncNewModelClearVisibility() {
  const input = document.getElementById('new-model-input');
  const btn = document.getElementById('new-model-clear');
  if (!input || !btn) return;
  btn.hidden = !input.value.trim();
}

/**
 * 从参考表复制到「添加新价格」表单并滚动
 * @param {string} key
 */
function copyOpenClawToForm(key) {
  const row = lastOpenClawModels.find((m) => m.key === key);
  if (!row) return;

  if (pricingTableEditingKey !== null) {
    alert('请先完成或取消表格中正在编辑的行');
    return;
  }

  const mtEl = document.getElementById('new-match-type');
  if (mtEl) mtEl.value = 'exact';
  syncNewMatchTypeUI();

  ensureModelDatalistOption(key);
  const modelInput = document.getElementById('new-model-input');
  if (modelInput) modelInput.value = key;
  syncNewModelClearVisibility();

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
document.getElementById('reset-pricing-btn').addEventListener('click', resetConfig);
document.getElementById('add-pricing-btn').addEventListener('click', addPricing);

document.getElementById('new-match-type')?.addEventListener('change', syncNewMatchTypeUI);
document.getElementById('new-model-input')?.addEventListener('input', () => {
  onNewModelKeyInput();
  syncNewModelClearVisibility();
});
document.getElementById('new-model-clear')?.addEventListener('click', () => {
  const input = document.getElementById('new-model-input');
  if (input) input.value = '';
  syncNewModelClearVisibility();
  onNewModelKeyInput();
  input?.focus();
});

document.getElementById('custom-pricing-enabled').addEventListener('change', onGlobalEnabledChange);

document.getElementById('pricing-tbody').addEventListener('change', onRowEnabledChange);

document.getElementById('pricing-tbody').addEventListener('click', (e) => {
  const doneBtn = e.target.closest('.btn-row-done');
  const cancelBtn = e.target.closest('.btn-row-cancel');
  const editBtn = e.target.closest('.btn-row-edit');
  const delBtn = e.target.closest('.btn-delete');
  if (doneBtn) {
    applyRowEdit(doneBtn.dataset.originalModel);
    return;
  }
  if (cancelBtn) {
    cancelRowEdit();
    return;
  }
  if (editBtn) {
    beginRowEdit(editBtn.dataset.model);
    return;
  }
  if (delBtn) {
    deletePricing(delBtn.dataset.model);
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

/** 显示短暂 toast（价格页「已复制」等） */
function showPricingToast(message) {
  const el = document.getElementById('pricing-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.add('pricing-toast--visible');
  clearTimeout(showPricingToast._tid);
  showPricingToast._tid = setTimeout(() => {
    el.classList.remove('pricing-toast--visible');
    el.hidden = true;
  }, 2200);
}

document.getElementById('pricing-help-copy-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const source = document.getElementById('pricing-help-copy-content');
  const text = source?.innerText?.trim() ?? '';
  if (!text) {
    showPricingToast('没有可复制的内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showPricingToast('已复制');
  } catch {
    showPricingToast('复制失败，请手动选择说明文字');
  }
});

// 初始化
loadData().then(() => syncNewMatchTypeUI());
