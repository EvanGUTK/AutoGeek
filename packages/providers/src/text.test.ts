import { describe, expect, it } from 'vitest';
import { truncateUtf8 } from './text.ts';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('truncateUtf8', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf8('abc', 3)).toBe('abc');
  });

  it('cuts on a code point boundary within the byte budget', () => {
    expect(truncateUtf8('a🙂b', 4)).toBe('a');
    expect(truncateUtf8('a🙂b', 5)).toBe('a🙂');
  });

  it('fits the suffix inside the budget', () => {
    const out = truncateUtf8('x'.repeat(100), 10, '…');
    expect(out).toBe('x'.repeat(7) + '…');
    expect(bytes(out)).toBe(10);
  });

  it('returns nothing when even the suffix does not fit', () => {
    expect(truncateUtf8('abcdef', 2, '…')).toBe('');
  });

  it('never splits a surrogate pair into U+FFFD', () => {
    for (let max = 0; max < 12; max += 1) {
      const out = truncateUtf8('🙂🙂🙂', max);
      expect(out).not.toContain('�');
      expect(bytes(out)).toBeLessThanOrEqual(max);
    }
  });
});
