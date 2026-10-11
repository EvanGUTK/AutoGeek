import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CoreErrorSchema,
  ERROR_CODES,
  ERROR_MESSAGES,
  coreError,
  createCoreErrorSchema,
  fromZodError,
  isAbortError,
  toCoreError,
} from './errors.ts';

describe('coreError', () => {
  it('builds a plain serializable error with the constant message for its code', () => {
    expect(coreError('not_found')).toEqual({
      code: 'not_found',
      message: ERROR_MESSAGES.not_found,
    });
  });

  it('carries variable information only in details, never in the message', () => {
    const error = coreError('conflict', { path: 'secret/file.ts' });
    expect(error).toEqual({
      code: 'conflict',
      message: ERROR_MESSAGES.conflict,
      details: { path: 'secret/file.ts' },
    });
    expect(error.message).not.toContain('secret/file.ts');
  });

  it('omits details when none are provided', () => {
    expect('details' in coreError('conflict')).toBe(false);
  });
});

describe('ERROR_MESSAGES', () => {
  it('has a non-empty constant message for every code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it('has distinct messages so codes stay distinguishable in logs', () => {
    expect(new Set(Object.values(ERROR_MESSAGES)).size).toBe(ERROR_CODES.length);
  });
});

describe('CoreErrorSchema', () => {
  it('accepts every declared code with its constant message', () => {
    for (const code of ERROR_CODES) {
      expect(CoreErrorSchema.safeParse({ code, message: ERROR_MESSAGES[code] }).success).toBe(true);
    }
  });

  it('rejects a message that is not the constant for its code', () => {
    const parsed = CoreErrorSchema.safeParse({
      code: 'not_found',
      message: 'No such file /etc/passwd',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown codes, missing messages and non-JSON details', () => {
    expect(CoreErrorSchema.safeParse({ code: 'nope', message: 'm' }).success).toBe(false);
    expect(CoreErrorSchema.safeParse({ code: 'internal' }).success).toBe(false);
    expect(
      CoreErrorSchema.safeParse({
        code: 'internal',
        message: ERROR_MESSAGES.internal,
        details: { f: () => 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects unexpected extra fields so stack traces cannot ride along', () => {
    expect(
      CoreErrorSchema.safeParse({
        code: 'internal',
        message: ERROR_MESSAGES.internal,
        stack: 'at secret.ts:1',
      }).success,
    ).toBe(false);
  });

  it('contains the codes other packages were promised', () => {
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        'invalid_input',
        'unauthorized_sender',
        'not_found',
        'outside_workspace',
        'sensitive_path',
        'untrusted_workspace',
        'conflict',
        'too_large',
        'cancelled',
        'secure_storage_unavailable',
        'unknown_key',
        'no_longer_pending',
        'unavailable',
        'internal',
        'permission_denied',
        'timeout',
        'io',
        'unsupported',
      ]),
    );
  });
});

describe('fromZodError', () => {
  const schema = z.object({ name: z.string(), nested: z.object({ n: z.number() }) });

  it('maps validation failures to invalid_input with issue paths and messages', () => {
    const parsed = schema.safeParse({ name: 1, nested: { n: 'x' } });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    const error = fromZodError(parsed.error);
    expect(error.code).toBe('invalid_input');
    expect(CoreErrorSchema.safeParse(error).success).toBe(true);
    expect(error.details).toEqual({
      issues: [
        { path: 'name', message: expect.any(String) as unknown },
        { path: 'nested.n', message: expect.any(String) as unknown },
      ],
    });
  });

  it('never echoes the rejected input value', () => {
    const secret = 'sk-live-SUPERSECRET';
    const parsed = z.object({ apiKey: z.number() }).safeParse({ apiKey: secret });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    expect(JSON.stringify(fromZodError(parsed.error))).not.toContain(secret);
  });

  it('does not echo rejected values for enums or literals either', () => {
    const secret = 'sk-live-SUPERSECRET';
    const parsed = z
      .object({ mode: z.enum(['a', 'b']), k: z.literal('x') })
      .safeParse({ mode: secret, k: secret });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    expect(JSON.stringify(fromZodError(parsed.error))).not.toContain(secret);
  });
});

describe('isAbortError', () => {
  it('recognises DOMException AbortError from AbortSignal.abort()', () => {
    expect(isAbortError(AbortSignal.abort().reason)).toBe(true);
  });

  it('recognises timeouts as non-abort and plain errors as non-abort', () => {
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it('recognises an Error named AbortError', () => {
    const error = new Error('stopped');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });
});

describe('toCoreError', () => {
  it('maps aborts to cancelled', () => {
    expect(toCoreError(AbortSignal.abort().reason, 'ref-1').code).toBe('cancelled');
  });

  it('maps anything else to internal carrying only the correlation id, never the thrown message', () => {
    const thrown = new Error('connect failed for key sk-live-SUPERSECRET');
    const error = toCoreError(thrown, 'ref-42');
    expect(error.code).toBe('internal');
    expect(error.message).toBe(ERROR_MESSAGES.internal);
    expect(error.details).toEqual({ ref: 'ref-42' });
    expect(JSON.stringify(error)).not.toContain('SUPERSECRET');
    expect(CoreErrorSchema.safeParse(error).success).toBe(true);
  });

  it('handles non-Error throwables', () => {
    expect(toCoreError('boom', 'ref-7').code).toBe('internal');
    expect(toCoreError(undefined, 'ref-8').code).toBe('internal');
  });
});

describe('createCoreErrorSchema', () => {
  const AuthDetails = z.strictObject({
    domain: z.literal('auth'),
    kind: z.enum(['store_corrupt', 'locked']),
  });
  const AuthErrorSchema = createCoreErrorSchema(
    ['secure_storage_unavailable', 'internal'],
    AuthDetails,
  );
  const message = ERROR_MESSAGES.secure_storage_unavailable;

  it('accepts the declared details shape and a missing details field', () => {
    const details = { domain: 'auth', kind: 'locked' };
    expect(
      AuthErrorSchema.safeParse({ code: 'secure_storage_unavailable', message, details }).success,
    ).toBe(true);
    expect(AuthErrorSchema.safeParse({ code: 'secure_storage_unavailable', message }).success).toBe(
      true,
    );
  });

  it('rejects details that do not match the declared shape', () => {
    const bad = { domain: 'auth', kind: 'nope' };
    expect(
      AuthErrorSchema.safeParse({ code: 'secure_storage_unavailable', message, details: bad })
        .success,
    ).toBe(false);
    expect(
      AuthErrorSchema.safeParse({
        code: 'secure_storage_unavailable',
        message,
        details: { domain: 'auth', kind: 'locked', path: '/secret' },
      }).success,
    ).toBe(false);
  });

  it('rejects codes outside the allowed set even when the message matches', () => {
    expect(
      AuthErrorSchema.safeParse({ code: 'not_found', message: ERROR_MESSAGES.not_found }).success,
    ).toBe(false);
  });

  it('keeps the constant-message invariant', () => {
    expect(
      AuthErrorSchema.safeParse({ code: 'secure_storage_unavailable', message: 'Keychain at /x' })
        .success,
    ).toBe(false);
  });

  it('is what CoreErrorSchema is built from: any JSON details, every code', () => {
    expect(
      CoreErrorSchema.safeParse({ code: 'io', message: ERROR_MESSAGES.io, details: [1] }).success,
    ).toBe(true);
  });
});
