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
    body: JSON.stringify(config)
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

// 渲染价格表格
function renderPricingTable(config) {
  const tbody = document.getElementById('pricing-tbody');
  const models = Object.entries(config.pricing);

  if (models.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 40px;">
          暂无价格配置，添加配置后生效
        </td>
      </tr>
    `;
    return;
  }

  const rows = models.map(([model, prices]) => `
    <tr data-model="${model}">
      <td><strong>${model}</strong></td>
      <td><input type="number" class="pricing-input" data-field="input" value="${prices.input}" step="0.01"></td>
      <td><input type="number" class="pricing-input" data-field="output" value="${prices.output}" step="0.01"></td>
      <td><input type="number" class="pricing-input" data-field="cacheRead" value="${prices.cacheRead || ''}" step="0.01" placeholder="留空使用 10%"></td>
      <td><input type="number" class="pricing-input" data-field="cacheWrite" value="${prices.cacheWrite || ''}" step="0.01" placeholder="留空使用 10%"></td>
      <td><button class="btn-delete" data-model="${model}">删除</button></td>
    </tr>
  `).join('');
  tbody.innerHTML = rows;
}

// 填充模型选择下拉框
function populateModelSelect(availableModels, configuredModels) {
  const select = document.getElementById('new-model-select');
  const configuredKeys = Object.keys(configuredModels);

  const options = availableModels
    .filter(model => !configuredKeys.includes(model))
    .map(model => `<option value="${model}">${model}</option>`)
    .join('');

  select.innerHTML = `<option value="">选择模型...</option>${options}`;
}

// 加载数据
let pricingConfig = null;

async function loadData() {
  try {
    pricingConfig = await fetchPricingConfig();
    const { models } = await fetchAvailableModels();

    renderPricingTable(pricingConfig);
    populateModelSelect(models, pricingConfig.pricing);
  } catch (error) {
    alert('加载价格配置失败: ' + error.message);
  }
}

// 保存配置
async function savePricingConfig() {
  try {
    // 收集表格数据
    const newPricing = {};
    document.querySelectorAll('#pricing-tbody tr[data-model]').forEach(row => {
      const model = row.dataset.model;
      const input = parseFloat(row.querySelector('[data-field="input"]').value);
      const output = parseFloat(row.querySelector('[data-field="output"]').value);
      const cacheRead = row.querySelector('[data-field="cacheRead"]').value;
      const cacheWrite = row.querySelector('[data-field="cacheWrite"]').value;

      if (isNaN(input) || isNaN(output) || input < 0 || output < 0) {
        throw new Error(`${model} 的 Input 和 Output 价格必须为有效的非负数`);
      }

      newPricing[model] = {
        input,
        output,
        cacheRead: cacheRead ? parseFloat(cacheRead) : null,
        cacheWrite: cacheWrite ? parseFloat(cacheWrite) : null,
      };
    });

    pricingConfig.pricing = newPricing;
    pricingConfig.updated = new Date().toISOString();

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

  pricingConfig.pricing[model] = {
    input,
    output,
    cacheRead,
    cacheWrite,
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
}

// 删除价格
function deletePricing(model) {
  if (!confirm(`确定要删除 ${model} 的价格配置吗？`)) {
    return;
  }

  delete pricingConfig.pricing[model];
  renderPricingTable(pricingConfig);

  // 重新填充选择框
  fetchAvailableModels().then(({ models }) => {
    populateModelSelect(models, pricingConfig.pricing);
  });
}

// 事件监听
document.getElementById('save-pricing-btn').addEventListener('click', savePricingConfig);
document.getElementById('reset-pricing-btn').addEventListener('click', resetConfig);
document.getElementById('add-pricing-btn').addEventListener('click', addPricing);

document.getElementById('pricing-tbody').addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-delete')) {
    const model = e.target.dataset.model;
    deletePricing(model);
  }
});

// 初始化
loadData();
