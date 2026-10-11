import type { ProviderError } from '@autogeek/core';

export interface RetryPolicy {
  /** Total attempts, the first one included. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Cap for backoff and for honoring server hints; a longer hint ends retrying. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
};

export interface RetryInput {
  readonly error: ProviderError;
  /** Attempts made so far, starting at 1. */
  readonly attempt: number;
  /**
   * True once any event reached the consumer. A retry would then duplicate text or, worse, a
   * tool call, so it never happens.
   */
  readonly outputStarted: boolean;
  /** The server's `x-should-retry` verdict, when present. */
  readonly shouldRetry?: boolean;
  readonly policy: RetryPolicy;
  /** Uniform in [0, 1). Injected for deterministic tests. */
  readonly random: () => number;
}

export type RetryDecision =
  { readonly retry: true; readonly delayMs: number } | { readonly retry: false };

const STOP: RetryDecision = { retry: false };

/** Bounded retry with full jitter (delay uniform in [0, min(cap, base * 2^(attempt-1)))). */
export function decideRetry(input: RetryInput): RetryDecision {
  const { error, policy } = input;
  if (error.kind === 'aborted' || input.outputStarted) return STOP;
  if (input.attempt >= policy.maxAttempts) return STOP;
  if (!(input.shouldRetry ?? error.retryable)) return STOP;
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs > policy.maxDelayMs
      ? STOP
      : { retry: true, delayMs: error.retryAfterMs };
  }
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (input.attempt - 1));
  const sample = input.random();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON) : 0;
  return { retry: true, delayMs: Math.floor(unit * ceiling) };
}
