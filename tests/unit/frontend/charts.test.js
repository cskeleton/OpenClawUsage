import { beforeEach, describe, expect, it } from 'vitest';
import * as chartHelpers from '../../../src/charts.js';
import { setLocale } from '../../../src/i18n.js';

const {
  buildModelDatasets,
  formatModelTotalInput,
  formatProviderTooltipLabel,
} = chartHelpers;

beforeEach(() => setLocale('en-US'));

describe('chart presentation helpers', () => {
  it('builds three cache-aware input segments and a separate output stack', () => {
    const datasets = buildModelDatasets([{
      input: 100, cacheWrite: 20, cacheRead: 80, output: 30,
    }]);

    expect(datasets.map((dataset) => [dataset.label, dataset.stack, dataset.data])).toEqual([
      ['Cache Read', 'input', [80]],
      ['Cache Write', 'input', [20]],
      ['Input', 'input', [100]],
      ['Output', 'output', [30]],
    ]);
    expect(datasets[0].backgroundColor).not.toBe(datasets[1].backgroundColor);
    expect(datasets[1].backgroundColor).not.toBe(datasets[2].backgroundColor);
  });

  it('rounds both outer corners on the only visible input segment', () => {
    const datasets = buildModelDatasets([{ input: 100, output: 30 }]);
    const borderRadius = datasets[2].borderRadius({ dataIndex: 0 });

    expect(borderRadius).toEqual({
      bottomLeft: 6, bottomRight: 6, topLeft: 6, topRight: 6,
    });
  });

  it('rounds both outer corners when Cache Write is the only visible input segment', () => {
    const datasets = buildModelDatasets([{ input: 0, cacheWrite: 20, cacheRead: 0, output: 30 }]);
    const borderRadius = datasets[1].borderRadius({ dataIndex: 0 });

    expect(borderRadius).toEqual({
      bottomLeft: 6, bottomRight: 6, topLeft: 6, topRight: 6,
    });
  });

  it('rounds only the actual outer edges of a multi-segment input stack', () => {
    const datasets = buildModelDatasets([{
      input: 100, cacheWrite: 20, cacheRead: 80, output: 30,
    }]);

    expect(datasets.slice(0, 3).map((dataset) => (
      dataset.borderRadius({ dataIndex: 0 })
    ))).toEqual([
      { bottomLeft: 6, bottomRight: 6, topLeft: 0, topRight: 0 },
      { bottomLeft: 0, bottomRight: 0, topLeft: 0, topRight: 0 },
      { bottomLeft: 0, bottomRight: 0, topLeft: 6, topRight: 6 },
    ]);
  });

  it('wires index interaction and model tooltip callbacks into Chart.js options', () => {
    const options = chartHelpers.buildModelChartOptions?.({
      useLogScale: false,
      tooltipConfig: { backgroundColor: '#111' },
      gridColor: '#222',
    });

    expect(options).toMatchObject({
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          backgroundColor: '#111',
          callbacks: {
            footer: formatModelTotalInput,
          },
        },
      },
      scales: {
        y: { type: 'linear', beginAtZero: true },
      },
    });
    expect(options.plugins.tooltip.callbacks.label({
      dataset: { label: 'Input' }, parsed: { y: 1234 },
    })).toBe('Input: 1,234');
  });

  it('shows provider cost and one-decimal share', () => {
    expect(formatProviderTooltipLabel('openai', 2.5, 10))
      .toBe(' openai: $2.50 (25.0%)');
    expect(formatProviderTooltipLabel('openai', 0, 0))
      .toBe(' openai: $0 (0.0%)');
  });

  it('keeps provider shares accurate when their finite costs overflow a direct total', () => {
    expect(formatProviderTooltipLabel(
      'provider-a',
      Number.MAX_VALUE,
      [Number.MAX_VALUE, Number.MAX_VALUE],
    )).toMatch(/\(50\.0%\)$/);
  });

  it('sums only input-stack segments in the model tooltip footer', () => {
    expect(formatModelTotalInput([
      { dataset: { stack: 'input' }, parsed: { y: 80 } },
      { dataset: { stack: 'input' }, parsed: { y: 20 } },
      { dataset: { stack: 'input' }, parsed: { y: 100 } },
      { dataset: { stack: 'output' }, parsed: { y: 30 } },
    ])).toBe('Total Input: 200');
  });

  it('saturates an overflowing model tooltip total at a finite value', () => {
    expect(formatModelTotalInput([
      { dataset: { stack: 'input' }, parsed: { y: Number.MAX_VALUE } },
      { dataset: { stack: 'input' }, parsed: { y: Number.MAX_VALUE } },
      { dataset: { stack: 'output' }, parsed: { y: Number.MAX_VALUE } },
    ])).toBe(`Total Input: ${Number.MAX_VALUE.toLocaleString()}`);
  });
});
