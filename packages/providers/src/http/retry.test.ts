import { providerError } from '@autogeek/core';
import type { ProviderErrorKind } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, decideRetry } from './retry.ts';
import type { RetryInput } from './retry.ts';

function input(kind: ProviderErrorKind, overrides: Partial<RetryInput> = {}): RetryInput {
  return {
    error: providerError(kind, 'anthropic'),
    attempt: 1,
    outputStarted: false,
    policy: DEFAULT_RETRY_POLICY,
    random: () => 0.5,
    ...overrides,
  };
}

describe('decideRetry', () => {
  it.each(['rate_limit', 'overloaded', 'server', 'network', 'timeout'] as const)(
    'retries a retryable %s error with full jitter',
    (kind) => {
      expect(decideRetry(input(kind))).toEqual({ retry: true, delayMs: 250 });
      expect(decideRetry(input(kind, { attempt: 2 }))).toEqual({ retry: true, delayMs: 500 });
    },
  );

  it.each([
    'auth',
    'permission',
    'not_found',
    'invalid_request',
    'context_length',
    'quota',
    'invalid_response',
    'credential_mismatch',
    'unknown',
  ] as const)('does not retry %s', (kind) => {
    expect(decideRetry(input(kind))).toEqual({ retry: false });
  });

  it('never retries once output has started, whatever the error', () => {
    expect(decideRetry(input('overloaded', { outputStarted: true }))).toEqual({ retry: false });
    expect(decideRetry(input('server', { outputStarted: true, shouldRetry: true }))).toEqual({
      retry: false,
    });
  });

  it('never retries an abort, even when the server asked for a retry', () => {
    expect(decideRetry(input('aborted', { shouldRetry: true }))).toEqual({ retry: false });
  });

  it('stops after the attempt budget', () => {
    expect(decideRetry(input('server', { attempt: DEFAULT_RETRY_POLICY.maxAttempts }))).toEqual({
      retry: false,
    });
  });

  it('lets x-should-retry: false win over a retryable kind', () => {
    expect(decideRetry(input('rate_limit', { shouldRetry: false }))).toEqual({ retry: false });
  });

  it('lets x-should-retry: true retry an otherwise final kind', () => {
    expect(decideRetry(input('unknown', { shouldRetry: true }))).toEqual({
      retry: true,
      delayMs: 250,
    });
  });

  it('waits exactly the server hint when it is within the cap', () => {
    const error = providerError('rate_limit', 'openai', { retryAfterMs: 1234 });
    expect(decideRetry(input('rate_limit', { error }))).toEqual({ retry: true, delayMs: 1234 });
  });

  it('gives up instead of sleeping past the cap, leaving the hint for the caller', () => {
    const error = providerError('rate_limit', 'openai', {
      retryAfterMs: DEFAULT_RETRY_POLICY.maxDelayMs + 1,
    });
    expect(decideRetry(input('rate_limit', { error }))).toEqual({ retry: false });
  });

  it('caps the exponential backoff', () => {
    const decision = decideRetry(
      input('server', {
        attempt: 30,
        random: () => 0.999,
        policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 40 },
      }),
    );
    expect(decision).toEqual({ retry: true, delayMs: Math.floor(0.999 * 60_000) });
  });

  it('keeps jitter inside [0, ceiling) even for a misbehaving random source', () => {
    expect(decideRetry(input('server', { random: () => 1 }))).toEqual({
      retry: true,
      delayMs: 499,
    });
    expect(decideRetry(input('server', { random: () => -3 }))).toEqual({ retry: true, delayMs: 0 });
    expect(decideRetry(input('server', { random: () => Number.NaN }))).toEqual({
      retry: true,
      delayMs: 0,
    });
  });
});
