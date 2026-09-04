import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/charts.js', () => ({
  renderCharts: vi.fn(),
  destroyCharts: vi.fn(),
}));

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

function ensureLocalStorage() {
  if (typeof localStorage?.setItem === 'function') return;
  const values = new Map();
  const mock = {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: mock });
}

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function bucket(totalCost, costSource, canonical) {
  return {
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1500,
    totalCost,
    requests: 1,
    costSource,
    canonical,
  };
}

function byModelRow(key, totalCost, costSource, canonical) {
  const provider = key.split('/')[0];
  return {
    provider,
    model: key.slice(provider.length + 1),
    canonical,
    costSource,
    costBreakdown: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0 },
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1500,
    totalCost,
    requests: 1,
  };
}

// nvidia/deepseek-ai/deepseek-v4-flash 与 bohe/deepseek-v4-flash 的 canonical
// 均为 deepseek-v4-flash，用于验证 canonical 分组聚合
function makeStats() {
  const today = todayStr();
  const cells = {
    'openai/gpt-5': bucket(2, 'manual', 'gpt-5'),
    'nvidia/deepseek-ai/deepseek-v4-flash': bucket(6, 'models.dev', 'deepseek-v4-flash'),
    'bohe/deepseek-v4-flash': bucket(2, 'openclaw', 'deepseek-v4-flash'),
  };
  return {
    summary: {
      totalInput: 3000,
      totalOutput: 1500,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 4500,
      totalCost: 10,
      totalRequests: 3,
      totalSessions: 0,
      costBySource: { manual: 2, 'models.dev': 6, pattern: 0, openclaw: 2 },
    },
    byDate: {
      [today]: { input: 3000, output: 1500, cacheRead: 0, cacheWrite: 0, totalTokens: 4500, totalCost: 10, requests: 3 },
    },
    byDateProvider: {
      [today]: {
        openai: bucket(2, 'manual', 'gpt-5'),
        nvidia: bucket(6, 'models.dev', 'deepseek-v4-flash'),
        bohe: bucket(2, 'openclaw', 'deepseek-v4-flash'),
      },
    },
    byDateModel: { [today]: cells },
    byModel: {
      'openai/gpt-5': byModelRow('openai/gpt-5', 2, 'manual', 'gpt-5'),
      'nvidia/deepseek-ai/deepseek-v4-flash': byModelRow('nvidia/deepseek-ai/deepseek-v4-flash', 6, 'models.dev', 'deepseek-v4-flash'),
      'bohe/deepseek-v4-flash': byModelRow('bohe/deepseek-v4-flash', 2, 'openclaw', 'deepseek-v4-flash'),
    },
    sessions: [],
    sources: [],
    generatedAt: `${today}T12:00:00.000Z`,
  };
}

async function loadDashboard(stats) {
  ensureLocalStorage();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  document.documentElement.className = 'theme-light';
  globalThis.fetch = vi.fn(async (url) => {
    if (typeof url === 'string' && url.startsWith('/api/stats')) {
      return new Response(JSON.stringify(stats), { status: 200 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.resetModules();
  await import('../../../src/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function switchToModelDimension() {
  document.querySelector('#breakdown-dimension [data-dimension="model"]').click();
}

function breakdownRows() {
  return [...document.querySelectorAll('#breakdown-tbody tr')];
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('stats canonical view', () => {
  it('groups byModel rows by canonical when toggle is on', async () => {
    const stats = makeStats();
    await loadDashboard(stats);
    switchToModelDimension();

    expect(breakdownRows()).toHaveLength(3);

    const toggle = document.getElementById('model-group-canonical');
    expect(toggle).not.toBeNull();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    const rows = breakdownRows();
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.textContent.includes('deepseek-v4-flash'));
    expect(merged).toBeDefined();
    // 6 + 2 = $8.00（tokens/cost 求和）
    expect(merged.querySelector('.cost-value').textContent).toBe('$8.00');
    expect(merged.querySelector('.token-value').textContent).toBe('3.0K');

    // 展示层聚合不得改动原始 stats 数据结构
    expect(Object.keys(stats.byModel)).toHaveLength(3);
    expect(stats.byModel['bohe/deepseek-v4-flash'].totalCost).toBe(2);

    // 关闭 toggle 恢复 3 行
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(breakdownRows()).toHaveLength(3);
  });

  it('renders cost source badge per row', async () => {
    await loadDashboard(makeStats());
    switchToModelDimension();

    const badges = [...document.querySelectorAll('#breakdown-tbody .badge')].map((b) => b.textContent);
    expect(badges).toContain('models.dev');
    expect(badges).toContain('手动');
    expect(badges).toContain('账面价');

    // canonical !== model 时在模型名旁小字显示 canonical
    const aliased = breakdownRows().find((r) => r.textContent.includes('nvidia/deepseek-ai/deepseek-v4-flash'));
    expect(aliased.querySelector('.canonical-name')?.textContent).toBe('deepseek-v4-flash');
    // canonical === model 时不显示小字
    const plain = breakdownRows().find((r) => r.textContent.includes('bohe/deepseek-v4-flash'));
    expect(plain.querySelector('.canonical-name')).toBeNull();
  });

  it('renders cost-by-source breakdown from summary.costBySource', async () => {
    await loadDashboard(makeStats());

    const section = document.getElementById('cost-source-section');
    expect(section).not.toBeNull();
    expect(section.hidden).toBe(false);
    expect(section.querySelector('#cost-source-title').textContent).toBe('成本构成（按计费来源）');

    const rows = [...section.querySelectorAll('.cost-source-row')];
    // 0 值来源（pattern）被过滤
    expect(rows.map((r) => r.dataset.costSource)).toEqual(['manual', 'models.dev', 'openclaw']);

    const openclawRow = section.querySelector('[data-cost-source="openclaw"]');
    expect(openclawRow.textContent).toContain('账面价');
    expect(openclawRow.textContent).toContain('$2.00');
    expect(openclawRow.textContent).toContain('20.0%');
    expect(openclawRow.querySelector('.share-bar-fill').style.width).toBe('20%');
  });
});
