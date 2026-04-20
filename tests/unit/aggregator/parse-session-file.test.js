import { describe, it, expect } from 'vitest';
import { normalizeArchivedAt, parseSessionFile } from '../../../aggregator.js';

describe('normalizeArchivedAt', () => {
  it('restores colons in the time portion only', () => {
    expect(normalizeArchivedAt('2026-04-15T13-05-48.786Z')).toBe('2026-04-15T13:05:48.786Z');
  });

  it('keeps date portion intact', () => {
    expect(normalizeArchivedAt('2026-04-15T00-00-00.000Z').startsWith('2026-04-15T')).toBe(true);
  });
});

describe('parseSessionFile', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef';

  it('parses active session', () => {
    expect(parseSessionFile(`${UUID}.jsonl`)).toEqual({
      sessionId: UUID, status: 'active', archivedAt: null, filename: `${UUID}.jsonl`,
    });
  });

  it('parses reset session with archived timestamp', () => {
    const r = parseSessionFile(`${UUID}.jsonl.reset.2026-04-15T13-05-48.786Z`);
    expect(r.status).toBe('reset');
    expect(r.archivedAt).toBe('2026-04-15T13:05:48.786Z');
    expect(r.sessionId).toBe(UUID);
  });

  it('parses deleted session', () => {
    const r = parseSessionFile(`${UUID}.jsonl.deleted.2026-04-15T13-05-48.786Z`);
    expect(r.status).toBe('deleted');
    expect(r.archivedAt).toBe('2026-04-15T13:05:48.786Z');
  });

  it('skips checkpoint variants', () => {
    expect(parseSessionFile(`${UUID}.checkpoint.abc.jsonl`)).toBeNull();
    expect(parseSessionFile(`${UUID}.checkpoint.xyz-123.jsonl`)).toBeNull();
  });

  it('skips non-session files', () => {
    expect(parseSessionFile('sessions.json')).toBeNull();
    expect(parseSessionFile('probe-xyz.jsonl')).toBeNull();
    expect(parseSessionFile('readme.txt')).toBeNull();
  });

  it('skips filenames without UUID prefix', () => {
    expect(parseSessionFile('random.jsonl')).toBeNull();
    expect(parseSessionFile('not-a-uuid-at-all.jsonl')).toBeNull();
  });
});
