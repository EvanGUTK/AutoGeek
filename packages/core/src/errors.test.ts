import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  isTimeoutError,
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

describe('the closed ErrorCode set', () => {
  // A snapshot on purpose: adding or removing a code is a contract change that must be reviewed
  // (every channel owner and the UI switch over this set). Reconciled against
  // docs/ipc-channels.md §1.3, docs/agent-contract.md and docs/ui-spec.md.
  it('is exactly the reconciled list', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'base_url_not_editable',
        'cancelled',
        'conflict',
        'domain_error',
        'internal',
        'invalid_base_url',
        'invalid_input',
        'io',
        'no_longer_pending',
        'not_found',
        'outside_workspace',
        'permission_denied',
        'protected_path',
        'secure_storage_unavailable',
        'sensitive_path',
        'timeout',
        'too_large',
        'too_long',
        'too_many',
        'unauthorized_sender',
        'unavailable',
        'unknown_key',
        'unsupported',
        'untrusted_workspace',
        'user_declined',
      ].sort(),
    );
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('covers every code in the common-error table of docs/ipc-channels.md §1.3', async () => {
    const doc = await readFile(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'ipc-channels.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('### 1.3'), doc.indexOf('### 1.4'));
    const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1] ?? '');
    expect(documented.length).toBeGreaterThan(10);
    expect(documented.filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual(
      [],
    );
  });

  it.each([
    'domain_error',
    'user_declined',
    'too_long',
    'invalid_base_url',
    'base_url_not_editable',
    'protected_path',
    'too_many',
  ] as const)('gives %s a constant message that names no variable content', (code) => {
    const message = ERROR_MESSAGES[code];
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/[{}$%<>]/);
    expect(CoreErrorSchema.safeParse({ code, message }).success).toBe(true);
  });

  it('accepts domain details {domain, kind} next to any code, with the constant message', () => {
    const error = coreError('secure_storage_unavailable', {
      domain: 'auth',
      kind: 'insecure_backend',
    });
    expect(CoreErrorSchema.safeParse(error).success).toBe(true);
    expect(error.message).toBe(ERROR_MESSAGES.secure_storage_unavailable);
  });
});

describe('timeouts (review K4)', () => {
  async function timedOutReason(): Promise<unknown> {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return signal.reason;
  }

  it('recognises the TimeoutError that AbortSignal.timeout() aborts with', async () => {
    const reason = await timedOutReason();
    expect(isTimeoutError(reason)).toBe(true);
    expect(isAbortError(reason)).toBe(false);
  });

  it('does not mistake other errors or values for a timeout', () => {
    expect(isTimeoutError(new Error('x'))).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
    expect(isTimeoutError(AbortSignal.abort().reason)).toBe(false);
  });

  it('maps a timeout to the timeout code, not internal', async () => {
    const error = toCoreError(await timedOutReason(), 'ref-1');
    expect(error).toEqual({ code: 'timeout', message: ERROR_MESSAGES.timeout });
  });
});

describe('fromZodError never echoes caller-supplied key names (review K3)', () => {
  const secret = 'sk-live-SUPERSECRET';

  it('does not name unrecognized keys', () => {
    const parsed = z.strictObject({ name: z.string() }).safeParse({ name: 'x', [secret]: 1 });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    const serialized = JSON.stringify(fromZodError(parsed.error));
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('Unrecognized');
  });

  it('keeps the issue path for ordinary schema properties', () => {
    const parsed = z.strictObject({ nested: z.strictObject({ n: z.number() }) }).safeParse({
      nested: { n: 'x' },
    });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    expect(fromZodError(parsed.error).details).toEqual({
      issues: [{ path: 'nested.n', message: expect.any(String) as unknown }],
    });
  });

  it('does not echo the value that failed an enum, literal or union', () => {
    const schema = z.strictObject({
      mode: z.enum(['a', 'b']),
      kind: z.literal('x'),
      either: z.union([z.literal(1), z.literal(2)]),
    });
    const parsed = schema.safeParse({ mode: secret, kind: secret, either: secret });
    if (parsed.success) {
      expect.unreachable('expected a validation failure');
    }
    expect(JSON.stringify(fromZodError(parsed.error))).not.toContain(secret);
  });
});
