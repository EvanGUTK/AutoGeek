import { describe, expect, it } from 'vitest';
import { isAbortError } from './errors.ts';
import { abortReason } from './abort.ts';

describe('abortReason', () => {
  it('returns the default AbortError reason as is', () => {
    const signal = AbortSignal.abort();
    expect(abortReason(signal)).toBe(signal.reason);
    expect(isAbortError(abortReason(signal))).toBe(true);
  });

  it('returns an Error reason supplied by the caller untouched', () => {
    const reason = new Error('shutting down');
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortReason(controller.signal)).toBe(reason);
  });

  it('wraps a non-Error reason in an AbortError', () => {
    const controller = new AbortController();
    controller.abort('because');
    const error = abortReason(controller.signal);
    expect(error).toBeInstanceOf(Error);
    expect(isAbortError(error)).toBe(true);
    expect(error.cause).toBe('because');
  });

  it('throws a programmer error when the signal is not aborted', () => {
    expect(() => abortReason(new AbortController().signal)).toThrow(/not aborted/);
  });
});
