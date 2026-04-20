import { describe, it, expect } from 'vitest';
import { filterDataByDateRange } from '../../../src/data-filter.js';

const bucket = (input, output) => ({
  input, output, cacheRead: 0, cacheWrite: 0,
  totalTokens: input + output, totalCost: input / 100 + output / 100, requests: 1,
});

const fullData = {
  summary: {},
  byDate: {
    '2026-04-15': bucket(100, 50),
    '2026-04-16': bucket(200, 100),
    '2026-04-17': bucket(300, 150),
  },
  byDateProvider: {
    '2026-04-15': { openai: bucket(100, 50) },
    '2026-04-16': { anthropic: bucket(200, 100) },
    '2026-04-17': { openai: bucket(300, 150) },
  },
  byDateModel: {
    '2026-04-15': { 'openai/gpt-4o': bucket(100, 50) },
    '2026-04-16': { 'anthropic/claude-sonnet-4': bucket(200, 100) },
    '2026-04-17': { 'openai/gpt-4o': bucket(300, 150) },
  },
  sessions: [
    { id: 's1', byDate: { '2026-04-15': bucket(100, 50) }, lastTimestamp: '2026-04-15T00:00:00Z' },
    { id: 's2', byDate: { '2026-04-17': bucket(300, 150) }, lastTimestamp: '2026-04-17T00:00:00Z' },
  ],
  generatedAt: '2026-04-20T00:00:00Z',
};

describe('filterDataByDateRange', () => {
  it('returns original data when no range', () => {
    expect(filterDataByDateRange(fullData, null, null)).toBe(fullData);
  });

  it('filters by from only', () => {
    const r = filterDataByDateRange(fullData, '2026-04-16', null);
    expect(Object.keys(r.byDate).sort()).toEqual(['2026-04-16', '2026-04-17']);
    expect(r.summary.totalInput).toBe(500);
  });

  it('filters by to only', () => {
    const r = filterDataByDateRange(fullData, null, '2026-04-15');
    expect(Object.keys(r.byDate)).toEqual(['2026-04-15']);
  });

  it('collapses byDateProvider into byProvider over range', () => {
    const r = filterDataByDateRange(fullData, '2026-04-15', '2026-04-16');
    expect(r.byProvider).toHaveProperty('openai');
    expect(r.byProvider).toHaveProperty('anthropic');
    expect(r.byProvider.openai.input).toBe(100);
    expect(r.byProvider.anthropic.input).toBe(200);
  });

  it('collapses byDateModel into byModel with provider/model split', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.byModel['openai/gpt-4o'].provider).toBe('openai');
    expect(r.byModel['openai/gpt-4o'].model).toBe('gpt-4o');
    expect(r.byModel['openai/gpt-4o'].input).toBe(300);
  });

  it('filters sessions by byDate and recomputes totals', () => {
    const r = filterDataByDateRange(fullData, '2026-04-17', null);
    expect(r.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(r.sessions[0].totalInput).toBe(300);
    expect(r.summary.totalSessions).toBe(1);
  });

  it('drops sessions with no overlap in range', () => {
    const r = filterDataByDateRange(fullData, '2026-04-18', null);
    expect(r.sessions).toEqual([]);
    expect(r.summary.totalSessions).toBe(0);
  });
});
