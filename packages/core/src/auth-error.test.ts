import { describe, expect, it } from 'vitest';
import {
  AUTH_DOMAIN_KINDS,
  AUTH_ERROR_CODES,
  AUTH_ERROR_KINDS,
  AUTH_ERROR_PROJECTION,
  AUTH_STORAGE_KINDS,
  AUTH_UNIVERSAL_KINDS,
  AuthCoreErrorSchema,
  AuthErrorDetailsSchema,
  AuthErrorKindSchema,
  authCoreError,
} from './auth-error.ts';
import { CoreErrorSchema, ERROR_CODES, ERROR_MESSAGES } from './errors.ts';

const known = new Set<string>(ERROR_CODES);

describe('AuthErrorKind', () => {
  // A snapshot on purpose: adding or removing a kind is a contract change for the renderer, which
  // switches over details.kind exhaustively.
  it('is exactly the approved set', () => {
    expect([...AUTH_ERROR_KINDS].sort()).toEqual([
      'base_url_not_editable',
      'confirm_declined',
      'confirm_too_long',
      'duplicate',
      'encryption_unavailable',
      'insecure_backend',
      'invalid_base_url',
      'not_found',
      'oauth_aborted',
      'oauth_provider_error',
      'oauth_state_mismatch',
      'oauth_timeout',
      'refresh_failed',
      'revocation_failed',
      'store_corrupt',
      'store_io',
      'validation_failed',
      'validator_unreachable',
    ]);
  });

  it('is closed and has no duplicates', () => {
    expect(AUTH_ERROR_KINDS).toHaveLength(18);
    expect(new Set(AUTH_ERROR_KINDS).size).toBe(AUTH_ERROR_KINDS.length);
    expect(AuthErrorKindSchema.safeParse('internal').success).toBe(false);
    expect(AuthErrorKindSchema.safeParse('NOT_FOUND').success).toBe(false);
  });
});

describe('AUTH_ERROR_PROJECTION', () => {
  it('is total over AuthErrorKind and has no other keys', () => {
    expect(Object.keys(AUTH_ERROR_PROJECTION).sort()).toEqual([...AUTH_ERROR_KINDS].sort());
  });

  it('targets only codes that exist in ERROR_CODES', () => {
    const targets = Object.values(AUTH_ERROR_PROJECTION);
    expect(targets.filter((code) => !known.has(code))).toEqual([]);
    expect(AUTH_ERROR_CODES.filter((code) => !known.has(code))).toEqual([]);
  });

  it('declares exactly the codes it targets', () => {
    expect([...new Set(Object.values(AUTH_ERROR_PROJECTION))].sort()).toEqual(
      [...AUTH_ERROR_CODES].sort(),
    );
  });

  it('maps the domain-independent kinds to their universal codes', () => {
    expect(AUTH_UNIVERSAL_KINDS.map((kind) => [kind, AUTH_ERROR_PROJECTION[kind]])).toEqual([
      ['not_found', 'not_found'],
      ['invalid_base_url', 'invalid_base_url'],
      ['base_url_not_editable', 'base_url_not_editable'],
      ['confirm_declined', 'user_declined'],
      ['confirm_too_long', 'too_long'],
    ]);
  });

  it('sends exactly the storage kinds to secure_storage_unavailable', () => {
    const kinds = AUTH_ERROR_KINDS.filter(
      (kind) => AUTH_ERROR_PROJECTION[kind] === 'secure_storage_unavailable',
    );
    expect(kinds).toEqual(['encryption_unavailable', 'insecure_backend']);
    expect(kinds).toEqual([...AUTH_STORAGE_KINDS]);
  });

  it('sends exactly the 11 domain kinds to domain_error', () => {
    const kinds = AUTH_ERROR_KINDS.filter((kind) => AUTH_ERROR_PROJECTION[kind] === 'domain_error');
    expect(kinds).toHaveLength(11);
    expect(kinds).toEqual([...AUTH_DOMAIN_KINDS]);
  });
});

describe('authCoreError', () => {
  it.each(AUTH_ERROR_KINDS)('projects %s to a valid error with the constant message', (kind) => {
    const error = authCoreError(kind);
    expect(error.code).toBe(AUTH_ERROR_PROJECTION[kind]);
    expect(error.message).toBe(ERROR_MESSAGES[error.code]);
    expect(AuthCoreErrorSchema.safeParse(error).success).toBe(true);
    expect(CoreErrorSchema.safeParse(error).success).toBe(true);
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
  });

  it.each(AUTH_UNIVERSAL_KINDS)('sends %s with no details', (kind) => {
    expect(authCoreError(kind)).toEqual({
      code: AUTH_ERROR_PROJECTION[kind],
      message: ERROR_MESSAGES[AUTH_ERROR_PROJECTION[kind]],
    });
  });

  it.each([...AUTH_STORAGE_KINDS, ...AUTH_DOMAIN_KINDS])(
    'sends %s with { domain, kind }',
    (kind) => {
      expect(authCoreError(kind).details).toEqual({ domain: 'auth', kind });
    },
  );
});

describe('AuthCoreErrorSchema', () => {
  const storage = (kind: string) => ({
    code: 'secure_storage_unavailable',
    message: ERROR_MESSAGES.secure_storage_unavailable,
    details: { domain: 'auth', kind },
  });
  const domain = (kind: string) => ({
    code: 'domain_error',
    message: ERROR_MESSAGES.domain_error,
    details: { domain: 'auth', kind },
  });

  it('rejects details that do not belong to the code', () => {
    expect(AuthCoreErrorSchema.safeParse(storage('store_io')).success).toBe(false);
    expect(AuthCoreErrorSchema.safeParse(domain('insecure_backend')).success).toBe(false);
    expect(AuthCoreErrorSchema.safeParse(domain('not_found')).success).toBe(false);
  });

  it('requires details on secure_storage_unavailable and domain_error', () => {
    for (const code of ['secure_storage_unavailable', 'domain_error'] as const) {
      expect(AuthCoreErrorSchema.safeParse({ code, message: ERROR_MESSAGES[code] }).success).toBe(
        false,
      );
    }
  });

  it('rejects details on a universal code', () => {
    const error = {
      code: 'not_found',
      message: ERROR_MESSAGES.not_found,
      details: { domain: 'auth', kind: 'store_io' },
    };
    expect(AuthCoreErrorSchema.safeParse(error).success).toBe(false);
  });

  it('rejects codes auth never returns, other messages, other domains and extra fields', () => {
    expect(
      AuthCoreErrorSchema.safeParse({ code: 'conflict', message: ERROR_MESSAGES.conflict }).success,
    ).toBe(false);
    expect(
      AuthCoreErrorSchema.safeParse({ ...domain('store_io'), message: 'sk-live' }).success,
    ).toBe(false);
    expect(
      AuthCoreErrorSchema.safeParse({
        ...domain('store_io'),
        details: { domain: 'provider', kind: 'store_io' },
      }).success,
    ).toBe(false);
    expect(
      AuthCoreErrorSchema.safeParse({
        ...domain('store_io'),
        details: { domain: 'auth', kind: 'store_io', path: '/home/me/vault' },
      }).success,
    ).toBe(false);
    expect(AuthCoreErrorSchema.safeParse({ ...domain('store_io'), cause: 'x' }).success).toBe(
      false,
    );
  });

  it('accepts exactly the storage and domain kinds as details', () => {
    const accepted = AUTH_ERROR_KINDS.filter(
      (kind) => AuthErrorDetailsSchema.safeParse({ domain: 'auth', kind }).success,
    );
    expect(accepted).toEqual([...AUTH_STORAGE_KINDS, ...AUTH_DOMAIN_KINDS]);
  });
});
