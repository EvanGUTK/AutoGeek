import { z } from 'zod';
import { ERROR_MESSAGES, createCoreErrorSchema } from './errors.ts';
import type { ErrorCode } from './errors.ts';

/**
 * `AuthError` is @autogeek/auth's internal failure taxonomy. It never crosses IPC as itself: at the
 * bridge every kind is projected onto a `CoreError` by `AUTH_ERROR_PROJECTION`, by this principle:
 *
 *   A condition that is domain-independent maps to the universal code. A condition whose useful
 *   explanation is domain-specific stays a domain kind (`domain_error`), or rides as details
 *   `{ domain: 'auth', kind }` on a universal code.
 *
 * The kinds are split into the three groups below by where they cross; `AUTH_ERROR_KINDS` is their
 * concatenation. The set is closed and snapshot-tested: adding a kind is a contract change for the
 * renderer, which switches over `details.kind` exhaustively (docs/ipc-channels.md §6).
 */

/** Domain-independent conditions: each crosses as a universal code, with no details. */
export const AUTH_UNIVERSAL_KINDS = [
  'not_found',
  'invalid_base_url',
  'base_url_not_editable',
  'confirm_declined',
  'confirm_too_long',
] as const;

/** No usable secure storage: crosses as `secure_storage_unavailable` with `{ domain, kind }`. */
export const AUTH_STORAGE_KINDS = ['encryption_unavailable', 'insecure_backend'] as const;

/** Failures only auth can explain: cross as `domain_error` with `{ domain, kind }`. */
export const AUTH_DOMAIN_KINDS = [
  'store_corrupt',
  'store_io',
  'duplicate',
  'validation_failed',
  'validator_unreachable',
  'oauth_state_mismatch',
  'oauth_timeout',
  'oauth_aborted',
  'oauth_provider_error',
  'refresh_failed',
  'revocation_failed',
] as const;

export const AUTH_ERROR_KINDS = [
  ...AUTH_UNIVERSAL_KINDS,
  ...AUTH_STORAGE_KINDS,
  ...AUTH_DOMAIN_KINDS,
] as const;

export const AuthErrorKindSchema = z.enum(AUTH_ERROR_KINDS);
export type AuthErrorKind = z.infer<typeof AuthErrorKindSchema>;

/**
 * Where each kind crosses the bridge. Total over `AuthErrorKind` (`satisfies` makes a missing or
 * unknown kind a compile error), and every target is an `ErrorCode`.
 */
export const AUTH_ERROR_PROJECTION = {
  not_found: 'not_found',
  invalid_base_url: 'invalid_base_url',
  base_url_not_editable: 'base_url_not_editable',
  confirm_declined: 'user_declined',
  confirm_too_long: 'too_long',
  encryption_unavailable: 'secure_storage_unavailable',
  insecure_backend: 'secure_storage_unavailable',
  store_corrupt: 'domain_error',
  store_io: 'domain_error',
  duplicate: 'domain_error',
  validation_failed: 'domain_error',
  validator_unreachable: 'domain_error',
  oauth_state_mismatch: 'domain_error',
  oauth_timeout: 'domain_error',
  oauth_aborted: 'domain_error',
  oauth_provider_error: 'domain_error',
  refresh_failed: 'domain_error',
  revocation_failed: 'domain_error',
} as const satisfies Readonly<Record<AuthErrorKind, ErrorCode>>;

/** Every code an `auth.*` channel can return because of an `AuthError`. */
export const AUTH_ERROR_CODES = [
  'not_found',
  'invalid_base_url',
  'base_url_not_editable',
  'user_declined',
  'too_long',
  'secure_storage_unavailable',
  'domain_error',
] as const satisfies readonly ErrorCode[];

export const AuthStorageErrorDetailsSchema = z.strictObject({
  domain: z.literal('auth'),
  kind: z.enum(AUTH_STORAGE_KINDS),
});

export const AuthDomainErrorDetailsSchema = z.strictObject({
  domain: z.literal('auth'),
  kind: z.enum(AUTH_DOMAIN_KINDS),
});

export const AuthErrorDetailsSchema = z.union([
  AuthStorageErrorDetailsSchema,
  AuthDomainErrorDetailsSchema,
]);
export type AuthErrorDetails = z.infer<typeof AuthErrorDetailsSchema>;

function detailsMatchCode(code: ErrorCode, details: AuthErrorDetails | undefined): boolean {
  if (code === 'secure_storage_unavailable') {
    return AuthStorageErrorDetailsSchema.safeParse(details).success;
  }
  if (code === 'domain_error') {
    return AuthDomainErrorDetailsSchema.safeParse(details).success;
  }
  return details === undefined;
}

/**
 * A projected `AuthError` as it crosses IPC. Strict, constant message per code, and `details` are
 * present exactly for `secure_storage_unavailable` (a storage kind) and `domain_error` (a domain
 * kind).
 */
export const AuthCoreErrorSchema = createCoreErrorSchema(
  AUTH_ERROR_CODES,
  AuthErrorDetailsSchema,
).refine((error) => detailsMatchCode(error.code, error.details), {
  message: 'details must match the code',
  path: ['details'],
});
export type AuthCoreError = z.infer<typeof AuthCoreErrorSchema>;

function isStorageKind(kind: AuthErrorKind): kind is (typeof AUTH_STORAGE_KINDS)[number] {
  return AUTH_ERROR_PROJECTION[kind] === 'secure_storage_unavailable';
}

function isDomainKind(kind: AuthErrorKind): kind is (typeof AUTH_DOMAIN_KINDS)[number] {
  return AUTH_ERROR_PROJECTION[kind] === 'domain_error';
}

/** Projects an internal kind onto the error that crosses IPC. Only the kind goes in. */
export function authCoreError(kind: AuthErrorKind): AuthCoreError {
  const code = AUTH_ERROR_PROJECTION[kind];
  const message = ERROR_MESSAGES[code];
  if (isStorageKind(kind) || isDomainKind(kind)) {
    return { code, message, details: { domain: 'auth', kind } };
  }
  return { code, message };
}
