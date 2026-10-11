import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from './retry-after.ts';

const NOW = Date.parse('2026-10-11T12:00:00Z');

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('parseRetryAfter', () => {
  it('returns undefined without any retry header', () => {
    expect(parseRetryAfter(headers({}), NOW)).toBeUndefined();
  });

  it('parses delta-seconds', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '7' }), NOW)).toBe(7000);
    expect(parseRetryAfter(headers({ 'retry-after': ' 0 ' }), NOW)).toBe(0);
  });

  it('tolerates fractional seconds and rounds up to whole milliseconds', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '1.0005' }), NOW)).toBe(1001);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfter(headers({ 'retry-after': 'Sun, 11 Oct 2026 12:00:30 GMT' }), NOW)).toBe(
      30_000,
    );
  });

  it('clamps an HTTP-date in the past to zero', () => {
    expect(parseRetryAfter(headers({ 'retry-after': 'Sun, 11 Oct 2026 11:00:00 GMT' }), NOW)).toBe(
      0,
    );
  });

  it('prefers retry-after-ms over retry-after', () => {
    expect(parseRetryAfter(headers({ 'retry-after-ms': '250.5', 'retry-after': '9' }), NOW)).toBe(
      251,
    );
  });

  it('falls back to retry-after when retry-after-ms is malformed', () => {
    expect(parseRetryAfter(headers({ 'retry-after-ms': 'soon', 'retry-after': '2' }), NOW)).toBe(
      2000,
    );
  });

  it.each(['', '-1', 'abc', '1e3', '0x10', 'Infinity', 'NaN', '12 34', 'tomorrow', '1,000'])(
    'ignores the malformed value %j',
    (value) => {
      expect(parseRetryAfter(headers({ 'retry-after': value }), NOW)).toBeUndefined();
      expect(parseRetryAfter(headers({ 'retry-after-ms': value }), NOW)).toBeUndefined();
    },
  );

  it('ignores absurdly large values instead of overflowing', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '9'.repeat(400) }), NOW)).toBeUndefined();
  });
});
