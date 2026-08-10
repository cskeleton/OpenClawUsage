import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildModelDatasets,
  formatModelTotalInput,
  formatProviderTooltipLabel,
} from '../../../src/charts.js';
import { setLocale } from '../../../src/i18n.js';

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

  it('shows provider cost and one-decimal share', () => {
    expect(formatProviderTooltipLabel('openai', 2.5, 10))
      .toBe(' openai: $2.50 (25.0%)');
    expect(formatProviderTooltipLabel('openai', 0, 0))
      .toBe(' openai: $0 (0.0%)');
  });

  it('sums only input-stack segments in the model tooltip footer', () => {
    expect(formatModelTotalInput([
      { dataset: { stack: 'input' }, parsed: { y: 80 } },
      { dataset: { stack: 'input' }, parsed: { y: 20 } },
      { dataset: { stack: 'input' }, parsed: { y: 100 } },
      { dataset: { stack: 'output' }, parsed: { y: 30 } },
    ])).toBe('Total Input: 200');
  });
});
