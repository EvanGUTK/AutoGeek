import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ERROR_KINDS,
  PROVIDER_ERROR_MESSAGES,
  PROVIDER_ERROR_RETRYABLE,
  ProviderErrorSchema,
  providerError,
} from './provider-error.ts';

describe('provider error kinds', () => {
  it('are exactly the contract taxonomy', () => {
    expect([...PROVIDER_ERROR_KINDS]).toEqual([
      'auth',
      'permission',
      'not_found',
      'invalid_request',
      'context_length',
      'rate_limit',
      'quota',
      'overloaded',
      'server',
      'network',
      'timeout',
      'aborted',
      'invalid_response',
      'credential_mismatch',
      'unknown',
    ]);
  });

  it('have a distinct, non-empty constant message each', () => {
    const messages = PROVIDER_ERROR_KINDS.map((kind) => PROVIDER_ERROR_MESSAGES[kind]);
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(PROVIDER_ERROR_KINDS.length);
  });

  it('mark exactly rate_limit, overloaded, server, network and timeout retryable', () => {
    const retryable = PROVIDER_ERROR_KINDS.filter((kind) => PROVIDER_ERROR_RETRYABLE[kind]);
    expect(retryable).toEqual(['rate_limit', 'overloaded', 'server', 'network', 'timeout']);
  });
});

describe('providerError', () => {
  it('fills the constant message and the retryable flag from the kind', () => {
    expect(providerError('rate_limit', 'anthropic', { status: 429, retryAfterMs: 2000 })).toEqual({
      kind: 'rate_limit',
      message: PROVIDER_ERROR_MESSAGES.rate_limit,
      retryable: true,
      providerId: 'anthropic',
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it('forwards requestId and detail when given', () => {
    const error = providerError('server', 'p', { requestId: 'req_9', detail: 'excerpt' });
    expect(error.requestId).toBe('req_9');
    expect(error.detail).toBe('excerpt');
  });

  it('omits optional fields that were not given', () => {
    const error = providerError('auth', 'openai');
    expect(Object.keys(error).sort()).toEqual(['kind', 'message', 'providerId', 'retryable']);
    expect(error.retryable).toBe(false);
  });

  it('produces values the schema accepts for every kind', () => {
    for (const kind of PROVIDER_ERROR_KINDS) {
      expect(ProviderErrorSchema.safeParse(providerError(kind, 'p')).success).toBe(true);
    }
  });
});

describe('ProviderErrorSchema', () => {
  const valid = providerError('server', 'google', {
    status: 503,
    requestId: 'req_123',
    retryAfterMs: 0,
    detail: 'upstream said no',
  });

  it('accepts a fully populated error', () => {
    expect(ProviderErrorSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a message that is not the constant for its kind (no vendor text)', () => {
    const leaky = { ...valid, message: 'Error from vendor: invalid key sk-123' };
    expect(ProviderErrorSchema.safeParse(leaky).success).toBe(false);
  });

  it('rejects a retryable flag that disagrees with the kind', () => {
    expect(ProviderErrorSchema.safeParse({ ...valid, retryable: false }).success).toBe(false);
    const auth = providerError('auth', 'p');
    expect(ProviderErrorSchema.safeParse({ ...auth, retryable: true }).success).toBe(false);
  });

  it.each([
    ['an unknown kind', { kind: 'exploded' }],
    ['an empty providerId', { providerId: '' }],
    ['a status below 100', { status: 99 }],
    ['a status above 599', { status: 600 }],
    ['a fractional status', { status: 200.5 }],
    ['a negative retryAfterMs', { retryAfterMs: -1 }],
    ['a fractional retryAfterMs', { retryAfterMs: 1.5 }],
    ['an empty requestId', { requestId: '' }],
    ['extra fields', { stack: 'at x' }],
  ])('rejects %s', (_name, patch) => {
    expect(ProviderErrorSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('bounds detail to 2 KiB of UTF-8', () => {
    expect(ProviderErrorSchema.safeParse({ ...valid, detail: 'a'.repeat(2048) }).success).toBe(
      true,
    );
    expect(ProviderErrorSchema.safeParse({ ...valid, detail: 'a'.repeat(2049) }).success).toBe(
      false,
    );
    // 1025 two-byte characters are 2050 bytes.
    expect(ProviderErrorSchema.safeParse({ ...valid, detail: 'é'.repeat(1025) }).success).toBe(
      false,
    );
  });
});
