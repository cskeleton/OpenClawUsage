import { escapeHtml, escapeAttr, showToast } from './util.js';
import { initLocaleControls, t } from './i18n.js';

// 保留原有 showPricingToast 名称以减少改动；内部委托给统一 toast 实现
const showPricingToast = (msg, opts) => showToast(msg, opts);

// API 调用函数
async function fetchPricingConfig() {
  const res = await fetch('/api/pricing');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 最近一次 GET /api/pricing 记录的配置 revision（乐观锁基线） */
let currentRevision = 0;

/**
 * PUT /api/pricing（v2 信封 { config, baseRevision }）。
 * 409 → 提示并重新加载，返回 null；其它非 2xx → 提示并重新加载，返回 null。
 * @param {Object} config
 * @returns {Promise<{ ok: true, revision: number, updated: string }|null>}
 */
async function updatePricingConfig(config) {
  const res = await fetch('/api/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, baseRevision: currentRevision }),
  });
  if (res.status === 409) {
    alert(t('pricing.conflictReload'));
    await loadData();
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || t('pricing.saveFailed'));
    await loadData();
    return null;
  }
  return res.json();
}

async function resetPricingConfig() {
  // 显式声明 JSON 内容类型：服务端写接口以此阻止跨站表单提交
  const res = await fetch('/api/pricing/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
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
 * 将当前 pricingConfig 同步到服务端（自动保存，v2 信封 + 乐观锁）
 * @returns {Promise<boolean>} true 表示已保存；false 表示冲突/校验失败（已提示并重载）
 */
async function persistPricingConfigToServer() {
  if (!pricingConfig) return false;
  const globalEl = document.getElementById('custom-pricing-enabled');
  if (globalEl) {
    pricingConfig.enabled = globalEl.checked;
  }
  try {
    const res = await updatePricingConfig(pricingConfig);
    if (!res) return false; // 409 / 校验失败：updatePricingConfig 已提示并 loadData
    currentRevision = typeof res.revision === 'number' ? res.revision : currentRevision;
    pricingConfig.revision = currentRevision;
    if (res.updated) {
      pricingConfig.updated = res.updated;
    }
    return true;
  } catch (err) {
    showToast(t('pricing.syncFailed', { message: err.message }), { variant: 'error' });
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
          ${t('pricing.openclawRefEmpty')}
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
          暂无缺少有效单价的模型，或文件不可读
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
    .map((row) => {
      let badge = '<span class="badge badge-muted">未覆盖</span>';
      if (row.custom) {
        badge = row.custom.enabled
          ? '<span class="badge badge-ok">已覆盖·启用</span>'
          : '<span class="badge badge-warn">已覆盖·禁用</span>';
      }
      const action = row.custom
        ? `<button type="button" class="btn-openclaw-row btn-secondary btn-locate-unpriced" data-key="${escapeAttr(row.key)}">定位规则</button>`
        : `<button type="button" class="btn-openclaw-row btn-openclaw-row-accent btn-copy-unpriced" data-key="${escapeAttr(row.key)}">复制到自定义</button>`;
      return `
      <tr>
        <td><strong>${escapeHtml(row.key)}</strong></td>
        <td>${escapeHtml(row.displayName || '')}</td>
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
        <button type="button" class="btn-pagination" data-unpriced-page="prev" ${unpricedPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="pagination-info">第 ${unpricedPage} / ${totalPages} 页（共 ${total} 条）</span>
        <button type="button" class="btn-pagination" data-unpriced-page="next" ${unpricedPage >= totalPages ? 'disabled' : ''}>下一页</button>
      `;
    }
  }
}

/**
 * 重新拉取「可用模型」与「OpenClaw 参考表」并重绘，供新增/编辑/删除规则后共用。
 */
async function refreshSupplementaryTables() {
  try {
    const { models } = await fetchAvailableModels();
    populateModelDatalist(models, configuredRuleKeys());
  } catch (err) {
    console.warn('刷新可用模型失败:', err);
  }
  try {
    const oc = await fetchOpenClawModels();
    renderOpenClawReference(oc.models || [], { resetPage: true });
    renderUnpricedModels(oc.unpricedModels || [], { resetPage: true });
  } catch (err) {
    console.warn('刷新 OpenClaw 参考表失败:', err);
  }
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
/** 当前正在编辑的行所在层（'rules' | 'patterns'） */
let pricingTableEditingSection = null;

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
 * 规则来源徽标：rules 按 source（手动 / models.dev），patterns 一律「高级规则」
 * @param {'rules'|'patterns'} section
 * @param {Object} entry
 */
function sourceBadgeHtml(section, entry) {
  if (section === 'patterns') {
    return `<span class="badge badge-warn">${t('pricing.sourcePattern')}</span>`;
  }
  if (entry.source === 'models.dev') {
    return `<span class="badge badge-ok">${t('pricing.sourceModelsDev')}</span>`;
  }
  return `<span class="badge badge-muted">${t('pricing.sourceManual')}</span>`;
}

/**
 * 渲染规则表（v2：rules 精确层与 patterns 通配符/正则层合并展示；
 * 默认只读，一行「编辑」后进入编辑模式）
 * @param {Object} config
 */
function renderRulesTable(config) {
  const tbody = document.getElementById('pricing-tbody');
  const models = [
    ...Object.entries(config.rules || {}).map(([key, entry]) => ['rules', key, entry]),
    ...Object.entries(config.patterns || {}).map(([key, entry]) => ['patterns', key, entry]),
  ];

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
    .map(([section, model, prices]) => {
      const enabled = prices.enabled !== false;
      const mt =
        section === 'patterns' &&
        (prices.matchType === 'wildcard' || prices.matchType === 'regex') ? prices.matchType : 'exact';
      const isEditing = pricingTableEditingKey === model && pricingTableEditingSection === section;
      const mtSel = (v) => (mt === v ? ' selected' : '');
      const sourceBadge = sourceBadgeHtml(section, prices);

      if (isEditing) {
        return `
    <tr data-model="${escapeAttr(model)}" data-section="${section}" data-row-editing="true">
      <td class="col-center">
        <label class="toggle-switch" title="关闭则该行使用 OpenClaw 账面价">
          <input type="checkbox" class="row-enabled-toggle" data-field="enabled" ${enabled ? 'checked' : ''} aria-label="启用该行自定义单价" />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </td>
      <td class="col-model-key">
        <input type="text" class="pricing-key-input" data-field="modelKey" value="${escapeAttr(model)}" list="new-model-datalist" spellcheck="false" autocomplete="off" />
        ${sourceBadge}
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
      <td class="col-numeric"><input type="number" class="pricing-input pricing-input--cache" data-field="cacheWrite" value="${prices.cacheWrite ?? ''}" step="0.01" placeholder="留空按 Input 原价" title="留空时按该行 Input 单价计算 Cache Write 费用"></td>
      <td class="col-center pricing-actions-cell">
        <button type="button" class="btn-row-done btn-primary" data-original-model="${escapeAttr(model)}" data-section="${section}">完成</button>
        <button type="button" class="btn-row-cancel btn-secondary">取消</button>
      </td>
    </tr>
  `;
      }

      return `
    <tr data-model="${escapeAttr(model)}" data-section="${section}">
      <td class="col-center">
        <label class="toggle-switch" title="关闭则该行使用 OpenClaw 账面价">
          <input type="checkbox" class="row-enabled-toggle" data-field="enabled" ${enabled ? 'checked' : ''} aria-label="启用该行自定义单价" />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </td>
      <td class="col-model-key"><span class="pricing-cell-readonly"><strong>${escapeHtml(model)}</strong></span> ${sourceBadge}</td>
      <td class="col-center">${matchTypeBadgeHtml(mt)}</td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.input)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.output)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.cacheRead != null ? prices.cacheRead : null)}</span></td>
      <td class="col-numeric"><span class="pricing-cell-readonly pricing-cell-num">${fmtDisplayPrice(prices.cacheWrite != null ? prices.cacheWrite : null)}</span></td>
      <td class="col-center pricing-actions-cell">
        <button type="button" class="btn-row-edit btn-secondary" data-model="${escapeAttr(model)}" data-section="${section}">编辑</button>
        <button type="button" class="btn-delete" data-model="${escapeAttr(model)}" data-section="${section}">删除</button>
      </td>
    </tr>
  `;
    })
    .join('');
  tbody.innerHTML = rows;
}

/**
 * 进入行编辑
 * @param {'rules'|'patterns'} section
 * @param {string} model
 */
function beginRowEdit(section, model) {
  if (pricingTableEditingKey !== null &&
      (pricingTableEditingKey !== model || pricingTableEditingSection !== section)) {
    showToast('请先完成或取消正在编辑的行', { variant: 'error' });
    return;
  }
  pricingTableEditingKey = model;
  pricingTableEditingSection = section;
  renderRulesTable(pricingConfig);
  requestAnimationFrame(() => {
    document
      .querySelector(`#pricing-tbody tr[data-model="${CSS.escape(model)}"][data-section="${section}"] .pricing-key-input`)
      ?.focus();
  });
}

/**
 * 取消行编辑（丢弃未保存到内存的修改，从 pricingConfig 重绘）
 */
function cancelRowEdit() {
  pricingTableEditingKey = null;
  pricingTableEditingSection = null;
  renderRulesTable(pricingConfig);
}

/**
 * 将编辑行写回 pricingConfig（内存），并退出编辑。
 * matchType 为 exact 时写入 rules，否则写入 patterns；
 * 编辑 source:'models.dev' 的条目保存后即升级为 manual（去掉 syncedAt）。
 * @param {'rules'|'patterns'} originalSection
 * @param {string} originalModel
 */
async function applyRowEdit(originalSection, originalModel) {
  const row = document.querySelector(`#pricing-tbody tr[data-model="${CSS.escape(originalModel)}"][data-section="${originalSection}"]`);
  if (!row) return;

  const newKey = (row.querySelector('[data-field="modelKey"]')?.value ?? '').trim();
  if (!newKey) {
    showToast('模型键不能为空', { variant: 'error' });
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
    showToast('Input 和 Output 价格必须为有效的非负数', { variant: 'error' });
    return;
  }

  const patErr = matchType !== 'exact' ? validateClientPattern(matchType, newKey) : '';
  if (patErr) {
    showToast(`${newKey}：${patErr}`, { variant: 'error' });
    return;
  }

  if (!pricingConfig.rules) pricingConfig.rules = {};
  if (!pricingConfig.patterns) pricingConfig.patterns = {};
  const targetSection = matchType === 'exact' ? 'rules' : 'patterns';
  const targetMap = targetSection === 'rules' ? pricingConfig.rules : pricingConfig.patterns;
  const originalMap = originalSection === 'rules' ? pricingConfig.rules : pricingConfig.patterns;
  if ((newKey !== originalModel || targetSection !== originalSection) && targetMap[newKey]) {
    showToast('已存在相同键的规则，请使用其他键名', { variant: 'error' });
    return;
  }

  const entry = {
    input,
    output,
    cacheRead: cacheRead ? parseFloat(cacheRead) : null,
    cacheWrite: cacheWrite ? parseFloat(cacheWrite) : null,
    enabled,
  };
  if (targetSection === 'patterns') {
    entry.matchType = matchType;
  } else {
    // 任何编辑保存都视为用户意图：source 升级 manual，去掉同步时间戳
    entry.source = 'manual';
  }

  if (newKey !== originalModel || targetSection !== originalSection) {
    delete originalMap[originalModel];
  }
  targetMap[newKey] = entry;
  pricingTableEditingKey = null;
  pricingTableEditingSection = null;
  try {
    await persistPricingConfigToServer();
    renderRulesTable(pricingConfig);
    await refreshSupplementaryTables();
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

/** 已配置键集合（rules + patterns），供 datalist 过滤已配置模型 */
function configuredRuleKeys() {
  return { ...(pricingConfig?.patterns || {}), ...(pricingConfig?.rules || {}) };
}

// 加载数据
let pricingConfig = null;

/**
 * 拉取确认队列（失败时回落空队列，不阻塞主配置加载）
 * @returns {Promise<Array>}
 */
async function fetchPricingCandidates() {
  try {
    const res = await fetch('/api/pricing/candidates');
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.candidates) ? body.candidates : [];
  } catch (e) {
    console.warn('确认队列加载失败:', e);
    return [];
  }
}

/**
 * 页面顶部 banner：GET /api/pricing 返回 validationErrors 时逐条展示
 * @param {string[]|undefined} errors
 */
function renderValidationBanner(errors) {
  const banner = document.getElementById('pricing-validation-banner');
  if (!banner) return;
  if (!Array.isArray(errors) || errors.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <h3 style="margin-bottom: 10px;">${t('pricing.validationErrorsTitle')}</h3>
    <ul style="margin: 0; padding-left: 20px;">
      ${errors.map((msg) => `<li>${escapeHtml(msg)}</li>`).join('')}
    </ul>
  `;
}

/** 「忽略 Provider」开关按配置回显（缺省视为 true，与后端口径一致） */
function syncIgnoreProviderUI() {
  const el = document.getElementById('ignore-provider-toggle');
  if (!el || !pricingConfig) return;
  el.checked = pricingConfig.matching?.ignoreProvider !== false;
}

async function loadData() {
  try {
    const [pricingBody, candidates] = await Promise.all([
      fetchPricingConfig(),
      fetchPricingCandidates(),
    ]);
    // validationErrors 是响应的附加字段，不属于配置本体，不能随 PUT 回写
    const { validationErrors, ...config } = pricingBody;
    pricingConfig = config;
    currentRevision = typeof config.revision === 'number' ? config.revision : 0;
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
    syncIgnoreProviderUI();
    renderValidationBanner(validationErrors);

    pricingTableEditingKey = null;
    pricingTableEditingSection = null;
    renderRulesTable(pricingConfig);
    populateModelDatalist(models, configuredRuleKeys());
    renderOpenClawReference(openclawData.models || [], { resetPage: true });
    renderUnpricedModels(openclawData.unpricedModels || [], { resetPage: true });
    renderCandidatesQueue(candidates);
    syncNewModelClearVisibility();
  } catch (error) {
    showToast(t('pricing.loadFailed', { message: error.message }), { variant: 'error' });
  } finally {
    syncCustomPricingDisabledUI();
  }
}

// 重置配置
async function resetConfig() {
  if (!confirm(t('pricing.resetConfirm'))) {
    return;
  }

  try {
    await resetPricingConfig();
    showToast(t('pricing.resetSuccess'), { variant: 'success' });
    await loadData();
  } catch (error) {
    showToast(t('pricing.resetFailed', { message: error.message }), { variant: 'error' });
  }
}

// 添加新价格
async function addPricing() {
  if (pricingTableEditingKey !== null) {
    showToast('请先完成或取消表格中正在编辑的行', { variant: 'error' });
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
    showToast('请填写或选择 provider/model（或通配符/正则模式）', { variant: 'error' });
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
    showToast('Input 和 Output 价格必须为有效的非负数', { variant: 'error' });
    return;
  }

  const cacheRead = cacheReadPrice.value ? parseFloat(cacheReadPrice.value) : null;
  const cacheWrite = cacheWritePrice.value ? parseFloat(cacheWritePrice.value) : null;

  if (!pricingConfig.rules) pricingConfig.rules = {};
  if (!pricingConfig.patterns) pricingConfig.patterns = {};
  if (pricingConfig.rules[model] || pricingConfig.patterns[model]) {
    showToast('已存在相同键的规则，请删除后再添加或保存后编辑', { variant: 'error' });
    return;
  }

  const row = {
    input,
    output,
    cacheRead,
    cacheWrite,
    enabled: true,
  };
  // exact 键进 rules（source: manual）；通配符/正则进 patterns（保留 matchType）
  if (matchType === 'exact') {
    row.source = 'manual';
    pricingConfig.rules[model] = row;
  } else {
    row.matchType = matchType;
    pricingConfig.patterns[model] = row;
  }

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
    renderRulesTable(pricingConfig);
    await refreshSupplementaryTables();
  } catch {
    /* persistPricingConfigToServer 已 loadData */
  }
}

// 删除价格
async function deletePricing(section, model) {
  if (!confirm(`确定要删除 ${model} 的价格配置吗？`)) {
    return;
  }

  if (pricingTableEditingKey === model && pricingTableEditingSection === section) {
    pricingTableEditingKey = null;
    pricingTableEditingSection = null;
  }
  const map = section === 'patterns' ? pricingConfig.patterns : pricingConfig.rules;
  if (map) delete map[model];
  try {
    await persistPricingConfigToServer();
    renderRulesTable(pricingConfig);
    await refreshSupplementaryTables();
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
  if (!row || !pricingConfig) return;
  const map = row.dataset.section === 'patterns' ? pricingConfig.patterns : pricingConfig.rules;
  const model = row.dataset.model;
  const entry = map?.[model];
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
    showToast('请先完成或取消表格中正在编辑的行', { variant: 'error' });
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
 * 将缺少内置单价的模型键填入「添加新价格」表单（无参考价，需自行填写单价）
 * @param {string} key
 */
function copyUnpricedToForm(key) {
  const row = lastUnpricedModels.find((m) => m.key === key);
  if (!row) return;

  if (pricingTableEditingKey !== null) {
    showToast('请先完成或取消表格中正在编辑的行', { variant: 'error' });
    return;
  }

  const mtEl = document.getElementById('new-match-type');
  if (mtEl) mtEl.value = 'exact';
  syncNewMatchTypeUI();

  ensureModelDatalistOption(key);
  const modelInput = document.getElementById('new-model-input');
  if (modelInput) modelInput.value = key;
  syncNewModelClearVisibility();

  document.getElementById('new-input-price').value = '';
  document.getElementById('new-output-price').value = '';
  document.getElementById('new-cache-read-price').value = '';
  document.getElementById('new-cache-write-price').value = '';

  document.getElementById('add-pricing-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showPricingToast('已填入模型键，请填写 Input/Output 单价');
}

/**
 * 高亮表格中的自定义规则行
 * @param {string} key
 */
function locatePricingRow(key) {
  const row = document.querySelector(`#pricing-tbody tr[data-model="${CSS.escape(key)}"]`);
  if (!row) {
    showToast('未找到该规则，可能尚未保存到自定义表', { variant: 'error' });
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
    applyRowEdit(doneBtn.dataset.section === 'patterns' ? 'patterns' : 'rules', doneBtn.dataset.originalModel);
    return;
  }
  if (cancelBtn) {
    cancelRowEdit();
    return;
  }
  if (editBtn) {
    beginRowEdit(editBtn.dataset.section === 'patterns' ? 'patterns' : 'rules', editBtn.dataset.model);
    return;
  }
  if (delBtn) {
    deletePricing(delBtn.dataset.section === 'patterns' ? 'patterns' : 'rules', delBtn.dataset.model);
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

document.getElementById('unpriced-models-tbody')?.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy-unpriced');
  const locBtn = e.target.closest('.btn-locate-unpriced');
  if (copyBtn) {
    copyUnpricedToForm(copyBtn.dataset.key);
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

// ============================================
// 确认队列（models.dev 歧义候选）与匹配口径控制
// ============================================

/** 最近一次 GET /api/pricing/candidates 返回的原始队列（含 dismissed） */
let lastCandidates = [];

/**
 * 渲染确认队列：过滤 dismissed；单候选条目优先，其余按 observedKey 排序
 * @param {Array} candidates
 */
function renderCandidatesQueue(candidates) {
  const section = document.getElementById('candidates-section');
  const list = document.getElementById('candidates-list');
  if (!section || !list) return;
  lastCandidates = Array.isArray(candidates) ? candidates : [];

  const visible = lastCandidates
    .filter((c) => !c.dismissed)
    .sort((a, b) => {
      const la = Array.isArray(a.candidates) ? a.candidates.length : 0;
      const lb = Array.isArray(b.candidates) ? b.candidates.length : 0;
      return la - lb || String(a.observedKey).localeCompare(String(b.observedKey));
    });

  if (visible.length === 0) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }
  section.hidden = false;

  const fmtPrice = (n) => (typeof n === 'number' && !Number.isNaN(n) ? `$${n}` : '—');
  list.innerHTML = visible
    .map((entry) => {
      const cands = Array.isArray(entry.candidates) ? entry.candidates : [];
      const items = cands
        .map((cand) => {
          const prices = cand.prices || {};
          const score = typeof cand.score === 'number' ? ` ${(cand.score * 100).toFixed(0)}%` : '';
          const priceText =
            `I:${fmtPrice(prices.input)} O:${fmtPrice(prices.output)} ` +
            `CR:${fmtPrice(prices.cacheRead)} CW:${fmtPrice(prices.cacheWrite)}`;
          return `
        <li style="margin-bottom: 6px;">
          <strong>${escapeHtml(cand.catalogKey)}</strong>
          <span style="color: var(--text-secondary); font-size: 0.85rem;"> ${escapeHtml(cand.provider || '')}${score}</span>
          <span style="color: var(--text-secondary); font-size: 0.85rem;"> ${escapeHtml(priceText)}</span>
          <button type="button" class="btn-openclaw-row btn-openclaw-row-accent btn-candidate-accept"
            data-observed-key="${escapeAttr(entry.observedKey)}" data-catalog-id="${escapeAttr(cand.catalogKey)}">${t('pricing.candidateAccept')}</button>
        </li>`;
        })
        .join('');
      return `
      <div class="candidate-entry" data-observed-key="${escapeAttr(entry.observedKey)}" style="margin-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">
          <strong>${escapeHtml(entry.observedKey)}</strong>
          <span style="flex: 1;"></span>
          <button type="button" class="btn-openclaw-row btn-secondary btn-candidate-manual"
            data-observed-key="${escapeAttr(entry.observedKey)}">${t('pricing.candidateManualFill')}</button>
          <button type="button" class="btn-openclaw-row btn-secondary btn-candidate-dismiss"
            data-observed-key="${escapeAttr(entry.observedKey)}">${t('pricing.candidateDismiss')}</button>
        </div>
        <ul style="margin: 0; padding-left: 18px; list-style: none;">${items}</ul>
      </div>`;
    })
    .join('');
}

/**
 * 批量提交确认队列决议，成功后整页重载（规则表与队列一并刷新）
 * @param {Array<{ observedKey: string, action: 'accept'|'dismiss', catalogId?: string }>} resolutions
 * @returns {Promise<boolean>}
 */
async function resolveCandidatesBatch(resolutions) {
  if (!Array.isArray(resolutions) || resolutions.length === 0) return false;
  try {
    const res = await fetch('/api/pricing/candidates/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutions }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadData();
    return true;
  } catch (err) {
    showToast(t('pricing.syncFailed', { message: err.message }), { variant: 'error' });
    return false;
  }
}

/** 「采纳所有唯一候选」：对所有非 dismissed 且仅一个候选的条目批量 accept */
function acceptAllUniqueCandidates() {
  const resolutions = lastCandidates
    .filter((c) => !c.dismissed && Array.isArray(c.candidates) && c.candidates.length === 1)
    .map((c) => ({ observedKey: c.observedKey, action: 'accept', catalogId: c.candidates[0].catalogKey }));
  resolveCandidatesBatch(resolutions);
}

/** 「忽略全部」：对所有非 dismissed 条目批量 dismiss */
function dismissAllCandidates() {
  const resolutions = lastCandidates
    .filter((c) => !c.dismissed)
    .map((c) => ({ observedKey: c.observedKey, action: 'dismiss' }));
  resolveCandidatesBatch(resolutions);
}

/** 「重新扫描匹配」：对 stats 中未覆盖模型批量重扫 models.dev */
async function rematchAll() {
  const btn = document.getElementById('btn-rematch');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/pricing/rematch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.catalogUnavailable) {
      showToast(t('pricing.rematchCatalogUnavailable'), { variant: 'error' });
    } else {
      showToast(t('pricing.rematchResult', { matched: result.matched, queued: result.queued }), { variant: 'success' });
    }
    await loadData();
  } catch (err) {
    showToast(t('pricing.syncFailed', { message: err.message }), { variant: 'error' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 确认队列「手动填价」：observed key 预填进「添加新价格」表单（不带价格）
 * @param {string} observedKey
 */
function fillCandidateToForm(observedKey) {
  if (pricingTableEditingKey !== null) {
    showToast('请先完成或取消表格中正在编辑的行', { variant: 'error' });
    return;
  }

  const mtEl = document.getElementById('new-match-type');
  if (mtEl) mtEl.value = 'exact';
  syncNewMatchTypeUI();

  ensureModelDatalistOption(observedKey);
  const modelInput = document.getElementById('new-model-input');
  if (modelInput) modelInput.value = observedKey;
  syncNewModelClearVisibility();

  document.getElementById('new-input-price').value = '';
  document.getElementById('new-output-price').value = '';
  document.getElementById('new-cache-read-price').value = '';
  document.getElementById('new-cache-write-price').value = '';

  const section = document.getElementById('add-pricing-section');
  if (section && typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  showPricingToast(t('pricing.manualFillHint'));
}

/**
 * 「忽略 Provider」开关：写回 config.matching.ignoreProvider 并立即同步
 * @param {Event} e
 */
async function onIgnoreProviderChange(e) {
  if (!pricingConfig) return;
  const checked = e.target.checked;
  if (!pricingConfig.matching) pricingConfig.matching = {};
  pricingConfig.matching.ignoreProvider = checked;
  try {
    await persistPricingConfigToServer();
  } catch {
    e.target.checked = !checked;
    pricingConfig.matching.ignoreProvider = !checked;
  }
}

/** 「噪声后缀」：prompt 编辑逗号分隔列表并写回 config.matching.noiseSuffixes */
async function onNoiseSuffixesClick() {
  if (!pricingConfig) return;
  const current = (pricingConfig.matching?.noiseSuffixes || []).join(', ');
  const input = prompt(t('pricing.noiseSuffixesPrompt'), current);
  if (input == null) return;
  if (!pricingConfig.matching) pricingConfig.matching = {};
  pricingConfig.matching.noiseSuffixes = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await persistPricingConfigToServer();
  } catch {
    /* persistPricingConfigToServer 已 loadData */
  }
}

document.getElementById('btn-accept-all-unique')?.addEventListener('click', acceptAllUniqueCandidates);
document.getElementById('btn-dismiss-all')?.addEventListener('click', dismissAllCandidates);
document.getElementById('btn-rematch')?.addEventListener('click', rematchAll);
document.getElementById('ignore-provider-toggle')?.addEventListener('change', onIgnoreProviderChange);
document.getElementById('btn-noise-suffixes')?.addEventListener('click', onNoiseSuffixesClick);

document.getElementById('candidates-list')?.addEventListener('click', (e) => {
  const acceptBtn = e.target.closest('.btn-candidate-accept');
  const dismissBtn = e.target.closest('.btn-candidate-dismiss');
  const manualBtn = e.target.closest('.btn-candidate-manual');
  if (acceptBtn) {
    resolveCandidatesBatch([
      { observedKey: acceptBtn.dataset.observedKey, action: 'accept', catalogId: acceptBtn.dataset.catalogId },
    ]);
  } else if (dismissBtn) {
    resolveCandidatesBatch([{ observedKey: dismissBtn.dataset.observedKey, action: 'dismiss' }]);
  } else if (manualBtn) {
    fillCandidateToForm(manualBtn.dataset.observedKey);
  }
});

// ============================================
// models.dev 在线价格参考弹窗
// ============================================

const MODELS_DEV_PRICE_FIELDS = [
  ['new-input-price', 'input'],
  ['new-output-price', 'output'],
  ['new-cache-read-price', 'cacheRead'],
  ['new-cache-write-price', 'cacheWrite'],
];

let modelsDevCatalog = null;
let modelsDevSelectedKey = null;

async function fetchModelsDevCatalog() {
  const res = await fetch('/api/models-dev/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function getModelsDevElements() {
  return {
    modal: document.getElementById('models-dev-modal'),
    search: document.getElementById('models-dev-search'),
    status: document.getElementById('models-dev-status'),
    list: document.getElementById('models-dev-list'),
    fillBtn: document.getElementById('models-dev-fill'),
    confirm: document.getElementById('models-dev-fill-confirm'),
  };
}

function closeModelsDevModal() {
  const { modal, confirm, fillBtn } = getModelsDevElements();
  if (modal) modal.hidden = true;
  if (confirm) confirm.hidden = true;
  modelsDevSelectedKey = null;
  if (fillBtn) fillBtn.disabled = true;
}

function renderModelsDevList(filter = '') {
  const { list } = getModelsDevElements();
  if (!list) return;
  list.innerHTML = '';
  const keyword = filter.trim().toLowerCase();
  const models = (modelsDevCatalog?.models || []).filter((m) => {
    if (!keyword) return true;
    return (
      m.key.toLowerCase().includes(keyword) ||
      (m.displayName || '').toLowerCase().includes(keyword)
    );
  });
  for (const m of models) {
    const li = document.createElement('li');
    li.dataset.key = m.key;
    li.setAttribute('role', 'option');
    li.className = 'models-dev-item';
    const dash = '—';
    const price =
      `I:${m.cost.input != null ? '$' + m.cost.input : dash} ` +
      `O:${m.cost.output != null ? '$' + m.cost.output : dash} ` +
      `CR:${m.cost.cacheRead != null ? '$' + m.cost.cacheRead : dash} ` +
      `CW:${m.cost.cacheWrite != null ? '$' + m.cost.cacheWrite : dash}`;
    li.innerHTML = `<span class="models-dev-item-key">${escapeHtml(m.key)}</span>` +
      `<span class="models-dev-item-price">${escapeHtml(price)}</span>`;
    if (m.key === modelsDevSelectedKey) li.classList.add('is-selected');
    li.addEventListener('click', () => {
      modelsDevSelectedKey = m.key;
      const { fillBtn, list: currentList } = getModelsDevElements();
      if (fillBtn) fillBtn.disabled = false;
      currentList?.querySelectorAll('.models-dev-item').forEach((node) => {
        node.classList.toggle('is-selected', node.dataset.key === m.key);
      });
    });
    list.appendChild(li);
  }
}

function showModelsDevError() {
  const { status, list } = getModelsDevElements();
  if (list) list.innerHTML = '';
  if (!status) return;
  status.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = t('pricing.modelsDevFailed');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.dataset.action = 'retry';
  retry.textContent = t('pricing.modelsDevRetry');
  retry.addEventListener('click', () => {
    loadModelsDevCatalogIntoModal();
  });
  status.appendChild(text);
  status.appendChild(retry);
}

async function loadModelsDevCatalogIntoModal() {
  const { status, list } = getModelsDevElements();
  if (status) status.textContent = t('pricing.modelsDevLoading');
  if (list) list.innerHTML = '';
  try {
    modelsDevCatalog = await fetchModelsDevCatalog();
    if (status) {
      status.innerHTML = '';
      if (modelsDevCatalog.stale) {
        const badge = document.createElement('span');
        badge.className = 'models-dev-stale-badge';
        badge.textContent = t('pricing.modelsDevStale');
        status.appendChild(badge);
      }
    }
    renderModelsDevList(getModelsDevElements().search?.value || '');
  } catch {
    showModelsDevError();
  }
}

function openModelsDevModal() {
  const { modal, search, confirm } = getModelsDevElements();
  if (!modal) return;
  modal.hidden = false;
  if (confirm) confirm.hidden = true;
  if (search) {
    search.value = '';
    search.focus();
  }
  if (modelsDevCatalog) {
    const { status } = getModelsDevElements();
    if (status) {
      status.innerHTML = '';
      if (modelsDevCatalog.stale) {
        const badge = document.createElement('span');
        badge.className = 'models-dev-stale-badge';
        badge.textContent = t('pricing.modelsDevStale');
        status.appendChild(badge);
      }
    }
    renderModelsDevList('');
  } else {
    loadModelsDevCatalogIntoModal();
  }
}

function writeModelsDevPrices(cost, strategy) {
  for (const [fieldId, prop] of MODELS_DEV_PRICE_FIELDS) {
    const el = document.getElementById(fieldId);
    if (!el) continue;
    if (strategy === 'blank' && el.value.trim() !== '') continue;
    el.value = cost[prop] == null ? '' : String(cost[prop]);
  }
}

function fillSelectedModelsDevPrice(strategy) {
  const row = modelsDevCatalog?.models.find((m) => m.key === modelsDevSelectedKey);
  if (!row) return;
  writeModelsDevPrices(row.cost, strategy);
  closeModelsDevModal();
  showPricingToast(
    t(strategy === 'overwrite' ? 'pricing.modelsDevFilledOverwrite' : 'pricing.modelsDevFilledBlank'),
    { variant: 'success' },
  );
  const section = document.getElementById('add-pricing-section');
  if (section && typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function handleModelsDevFillClick() {
  if (pricingTableEditingKey !== null) {
    showToast('请先完成或取消表格中正在编辑的行', { variant: 'error' });
    return;
  }
  const row = modelsDevCatalog?.models.find((m) => m.key === modelsDevSelectedKey);
  if (!row) return;
  const allEmpty = MODELS_DEV_PRICE_FIELDS.every(([fieldId]) => {
    const el = document.getElementById(fieldId);
    return !el || el.value.trim() === '';
  });
  if (allEmpty) {
    fillSelectedModelsDevPrice('overwrite');
    return;
  }
  const { confirm } = getModelsDevElements();
  if (confirm) confirm.hidden = false;
}

function initModelsDevModal() {
  const { modal, search, fillBtn, cancelBtn } = {
    ...getModelsDevElements(),
    cancelBtn: document.getElementById('models-dev-cancel'),
  };
  if (!modal) return;

  document.getElementById('fetch-models-dev-btn')?.addEventListener('click', openModelsDevModal);

  modal.querySelectorAll('[data-action="close"]').forEach((el) => {
    el.addEventListener('click', closeModelsDevModal);
  });
  cancelBtn?.addEventListener('click', closeModelsDevModal);

  search?.addEventListener('input', () => {
    renderModelsDevList(search.value);
  });

  fillBtn?.addEventListener('click', handleModelsDevFillClick);

  modal.querySelectorAll('#models-dev-fill-confirm [data-strategy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const strategy = btn.dataset.strategy;
      const { confirm } = getModelsDevElements();
      if (strategy === 'cancel') {
        if (confirm) confirm.hidden = true;
        return;
      }
      fillSelectedModelsDevPrice(strategy);
    });
  });
}

initModelsDevModal();

// 测试钩子（jsdom 用）
window.__modelsDev = { openModelsDevModal, closeModelsDevModal, fillSelectedModelsDevPrice };

document.getElementById('pricing-help-copy-btn')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const source = document.getElementById('pricing-help-copy-content');
  const text = source?.innerText?.trim() ?? '';
  if (!text) {
    showPricingToast(t('pricing.noCopyContent'));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showPricingToast(t('pricing.copyDone'));
  } catch {
    showPricingToast(t('pricing.copyFailed'));
  }
});

// 初始化
initLocaleControls();
loadData().then(() => syncNewMatchTypeUI());
