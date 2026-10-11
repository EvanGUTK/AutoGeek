import { z } from 'zod';

export const PROVIDER_ERROR_KINDS = [
  'auth', // 401, bad or expired key or token
  'permission', // 403, key valid but model/region/feature not allowed
  'not_found', // 404, unknown model or endpoint
  'invalid_request', // 400/413/422, a request we built that the vendor rejected
  'context_length', // input exceeds the model's window (vendor-specific detection)
  'rate_limit', // 429, transient
  'quota', // out of credits / insufficient_quota / 402, needs user action
  'overloaded', // 529 / 503 overloaded
  'server', // other 5xx
  'network', // DNS/TCP/TLS/reset before or during the stream
  'timeout', // first-byte or idle timeout
  'aborted', // caller's signal
  'invalid_response', // unparseable stream / schema violation / stream ended without a terminal vendor event
  'credential_mismatch', // credential.providerId !== provider id (no I/O performed)
  'unknown',
] as const;

export const ProviderErrorKindSchema = z.enum(PROVIDER_ERROR_KINDS);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

/**
 * `ProviderError.message` is a CONSTANT per kind and never interpolated: vendor text can contain
 * secrets, prompts or file contents. Variable context goes in `status`, `requestId` and `detail`.
 */
export const PROVIDER_ERROR_MESSAGES: Readonly<Record<ProviderErrorKind, string>> = {
  auth: 'Authentication with the provider failed.',
  permission: 'The provider denied access to this model or feature.',
  not_found: 'The provider does not know this model or endpoint.',
  invalid_request: 'The provider rejected the request.',
  context_length: 'The conversation is too long for this model.',
  rate_limit: 'The provider is rate limiting requests.',
  quota: 'The provider account is out of quota or credits.',
  overloaded: 'The provider is overloaded.',
  server: 'The provider reported a server error.',
  network: 'A network error occurred while contacting the provider.',
  timeout: 'The provider did not respond in time.',
  aborted: 'The request was cancelled.',
  invalid_response: 'The provider sent a response that could not be understood.',
  credential_mismatch: 'The credential does not belong to this provider.',
  unknown: 'An unknown provider error occurred.',
};

/** Safe for the caller to retry the whole request later (the adapter already retried internally). */
export const PROVIDER_ERROR_RETRYABLE: Readonly<Record<ProviderErrorKind, boolean>> = {
  auth: false,
  permission: false,
  not_found: false,
  invalid_request: false,
  context_length: false,
  rate_limit: true,
  quota: false,
  overloaded: true,
  server: true,
  network: true,
  timeout: true,
  aborted: false,
  invalid_response: false,
  credential_mismatch: false,
  unknown: false,
};

const MAX_DETAIL_BYTES = 2048;

export const ProviderErrorSchema = z
  .strictObject({
    kind: ProviderErrorKindSchema,
    message: z.string(),
    retryable: z.boolean(),
    providerId: z.string().min(1),
    status: z.number().int().min(100).max(599).optional(),
    /** Vendor request id header, for support. */
    requestId: z.string().min(1).optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    /**
     * Redacted vendor body excerpt, at most 2 KiB. Main-process LOGS ONLY: never sent to the
     * model and never crosses the IPC bridge to the renderer.
     */
    detail: z
      .string()
      .refine((text) => new TextEncoder().encode(text).length <= MAX_DETAIL_BYTES, {
        message: `detail must be at most ${String(MAX_DETAIL_BYTES)} bytes`,
      })
      .optional(),
  })
  .refine((error) => error.message === PROVIDER_ERROR_MESSAGES[error.kind], {
    message: 'message must be the constant message for its kind',
    path: ['message'],
  })
  .refine((error) => error.retryable === PROVIDER_ERROR_RETRYABLE[error.kind], {
    message: 'retryable is fixed by the kind',
    path: ['retryable'],
  });
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

export interface ProviderErrorExtras {
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly detail?: string;
}

export function providerError(
  kind: ProviderErrorKind,
  providerId: string,
  extras: ProviderErrorExtras = {},
): ProviderError {
  return {
    kind,
    message: PROVIDER_ERROR_MESSAGES[kind],
    retryable: PROVIDER_ERROR_RETRYABLE[kind],
    providerId,
    ...(extras.status === undefined ? {} : { status: extras.status }),
    ...(extras.requestId === undefined ? {} : { requestId: extras.requestId }),
    ...(extras.retryAfterMs === undefined ? {} : { retryAfterMs: extras.retryAfterMs }),
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
  };
}
