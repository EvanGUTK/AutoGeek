import { describe, expect, it } from 'vitest';
import { andThen, err, map, mapErr, ok, unwrapOr } from './result.ts';
import type { Result } from './result.ts';

// Fixtures return the declared union (not the narrowed Ok/Err) so tests exercise real inference.
const success = (value: number): Result<number, string> => ok(value);
const failure = (error: string): Result<number, string> => err(error);

describe('Result', () => {
  it('ok carries a value and narrows on the ok flag', () => {
    const result = success(2);
    if (result.ok) {
      expect(result.value).toBe(2);
    } else {
      expect.unreachable('expected ok');
    }
  });

  it('ok() with no argument is a void success', () => {
    expect(ok()).toEqual({ ok: true, value: undefined });
  });

  it('err carries an error and narrows on the ok flag', () => {
    const result = failure('boom');
    if (!result.ok) {
      expect(result.error).toBe('boom');
    } else {
      expect.unreachable('expected err');
    }
  });

  it('map transforms ok values and leaves errors untouched', () => {
    expect(map(success(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(failure('e'), (n) => n * 3)).toEqual(err('e'));
  });

  it('mapErr transforms errors and leaves ok values untouched', () => {
    expect(mapErr(failure('e'), (e) => e.length)).toEqual(err(1));
    expect(mapErr(success(1), (e) => e.length)).toEqual(ok(1));
  });

  it('andThen chains successes and short-circuits on the first error', () => {
    const half = (n: number): Result<number, string> =>
      n % 2 === 0 ? ok(n / 2) : err(`odd: ${String(n)}`);
    expect(andThen(success(8), half)).toEqual(ok(4));
    expect(andThen(andThen(success(6), half), half)).toEqual(err('odd: 3'));
    expect(andThen(failure('first'), half)).toEqual(err('first'));
  });

  it('unwrapOr returns the value or the fallback', () => {
    expect(unwrapOr(success(1), 9)).toBe(1);
    expect(unwrapOr(failure('e'), 9)).toBe(9);
  });
});
