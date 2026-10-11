import { z } from 'zod';
import { JsonValueSchema } from './json.ts';
import type { JsonValue } from './json.ts';

/**
 * `CoreError` is the CROSS-BOUNDARY error envelope: IPC results, tool results and agent events
 * all carry it. It is deliberately small and closed.
 *
 * Domain error types keep their own richer taxonomy and are mapped INTO a `CoreError` at the
 * boundary, never replaced by it:
 * - `ProviderError`: kind `aborted` -> `cancelled`, `timeout` -> `timeout`, anything unexpected
 *   -> `internal`. The owning package decides the rest of its table and tests it.
 * - Auth/vault failures -> `secure_storage_unavailable` or `internal` as appropriate.
 * Vendor text, file contents, key material and `ProviderError.detail` never cross.
 *
 * `details: { domain, kind }` may accompany any code where the UI needs the owner's specific
 * reason (for example `secure_storage_unavailable` with `{ domain: 'auth', kind:
 * 'insecure_backend' }`, or `domain_error` for failures that have no better general code). The
 * `kind` is a closed enum from the owner's error type, validated by that channel's `errorDetails`.
 *
 * The set is closed on purpose and snapshot-tested: adding or removing a code is a contract change
 * (every channel owner and the UI switch over it), reconciled against docs/ipc-channels.md §1.3.
 *
 * Invariant: `message` is a constant per code (`ERROR_MESSAGES`) and is safe to display and log.
 * It is never interpolated with user content, paths, file contents, vendor text or secrets. All
 * variable information goes in `details`, which must be JSON-serializable and safe to show.
 */
export const ERROR_CODES = [
  // Input and addressing
  'invalid_input',
  'unauthorized_sender',
  'not_found',
  'unknown_key',
  'no_longer_pending',
  'conflict',
  'too_large',
  'unsupported',
  'too_long',
  'too_many',
  'invalid_base_url',
  'base_url_not_editable',
  // Workspace and permission boundaries
  'outside_workspace',
  'sensitive_path',
  'untrusted_workspace',
  'protected_path',
  'permission_denied',
  'user_declined',
  'secure_storage_unavailable',
  // Operation lifecycle
  'cancelled',
  'timeout',
  'unavailable',
  'io',
  'domain_error',
  'internal',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_input: 'The input was invalid.',
  unauthorized_sender: 'The caller is not authorized.',
  not_found: 'The requested item was not found.',
  unknown_key: 'The key is not recognized.',
  no_longer_pending: 'The request is no longer pending.',
  conflict: 'The item changed since it was last read.',
  too_large: 'The item exceeds the allowed size.',
  unsupported: 'The operation is not supported.',
  too_long: 'The text is too long to show for confirmation.',
  too_many: 'Too many items were requested.',
  invalid_base_url: 'The base URL cannot be used.',
  base_url_not_editable: "This provider's endpoint cannot be changed.",
  outside_workspace: 'The path is outside the trusted workspace.',
  sensitive_path: 'The path is sensitive and was not approved.',
  untrusted_workspace: 'The workspace is not trusted.',
  protected_path: 'The path is protected and cannot be modified.',
  permission_denied: 'Permission was denied.',
  user_declined: 'The user declined the request.',
  secure_storage_unavailable: 'Secure credential storage is unavailable.',
  cancelled: 'The operation was cancelled.',
  timeout: 'The operation timed out.',
  unavailable: 'The service is unavailable.',
  io: 'An input/output error occurred.',
  domain_error: 'The operation failed with a domain-specific error.',
  internal: 'An internal error occurred.',
};

/**
 * Builds an error schema restricted to `codes` whose `details` must match `details`. The
 * constant-message invariant is enforced for every code. Strict, so nothing else rides along.
 */
export function createCoreErrorSchema<
  const C extends readonly [ErrorCode, ...ErrorCode[]],
  D extends z.ZodType<JsonValue>,
>(codes: C, details: D) {
  return z
    .strictObject({
      code: z.enum(codes),
      message: z.string(),
      details: details.optional(),
    })
    .refine((error) => error.message === ERROR_MESSAGES[error.code], {
      message: 'message must be the constant message for its code',
      path: ['message'],
    });
}

export const CoreErrorSchema = createCoreErrorSchema(ERROR_CODES, JsonValueSchema);

export type CoreError = z.infer<typeof CoreErrorSchema>;

export function coreError(code: ErrorCode, details?: JsonValue): CoreError {
  const message = ERROR_MESSAGES[code];
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Converts a zod failure to `invalid_input`. Only issue paths and zod's own messages are kept;
 * the rejected input is never echoed, because it may be (or contain) a secret. Unrecognized-key
 * issues are reduced to a constant message because zod names the offending keys, which are
 * caller-supplied. Issue paths name schema properties; keys of a record are also caller data, so
 * a schema that maps secret-bearing strings as record keys would expose them in `path` and must
 * not be used on a channel.
 */
export function fromZodError(error: z.ZodError): CoreError {
  return coreError('invalid_input', {
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.code === 'unrecognized_keys' ? 'Unrecognized keys.' : issue.message,
    })),
  });
}

export function isAbortError(thrown: unknown): boolean {
  return thrown instanceof Error && thrown.name === 'AbortError';
}

/** The `TimeoutError` that `AbortSignal.timeout()` aborts with. */
export function isTimeoutError(thrown: unknown): boolean {
  return thrown instanceof Error && thrown.name === 'TimeoutError';
}

/**
 * Last-resort conversion of a thrown value at a process boundary. Aborts become `cancelled`,
 * timeouts become `timeout`; everything else is `internal` carrying only a correlation id (the caller logs the original
 * error under that id). The thrown message is dropped on purpose: it may contain secrets.
 */
export function toCoreError(thrown: unknown, correlationId: string): CoreError {
  if (isAbortError(thrown)) {
    return coreError('cancelled');
  }
  if (isTimeoutError(thrown)) {
    return coreError('timeout');
  }
  return coreError('internal', { ref: correlationId });
}
