import { z } from 'zod';

/**
 * How a credential authenticates. `none` is a secretless connection record for a keyless local
 * server; it still binds a provider to a base URL. The provider catalog's `credentialKinds` uses
 * this same vocabulary.
 */
export const CREDENTIAL_KINDS = ['api_key', 'oauth_pkce', 'none'] as const;
export const CredentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/** Control (Cc) and format (Cf, including the bidi controls) characters, which can disguise text. */
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}]/u;

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch (thrown) {
    if (!(thrown instanceof TypeError)) throw thrown;
    return null;
  }
  const httpLike = url.protocol === 'https:' || url.protocol === 'http:';
  const bare = url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  return httpLike && bare ? url : null;
}

/**
 * Display-safe: http(s), no credentials, query or fragment (so nothing secret can ride along), and
 * already in canonical WHATWG form (punycode host, lowercase), so what the UI shows is exactly
 * where requests go.
 */
function isDisplaySafeBaseUrl(value: string): boolean {
  return value.length <= 2048 && parseHttpUrl(value)?.href === value;
}

/**
 * The only credential shape the renderer ever receives. Strict: no other field (and so no secret)
 * can ride along.
 */
export const CredentialRefSchema = z.strictObject({
  id: z.string().regex(/^cred_[A-Za-z0-9_-]{22}$/),
  label: z
    .string()
    .min(1)
    .max(100)
    .refine((label) => !CONTROL_OR_BIDI.test(label), 'label must not contain control characters'),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  kind: CredentialKindSchema,
  /** Present only for providers whose endpoint is editable. */
  baseUrl: z
    .string()
    .refine(isDisplaySafeBaseUrl, 'baseUrl must be a canonical http(s) URL')
    .optional(),
  createdAt: z.iso.datetime(),
  monthlyCapUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

declare const resolvedCredentialBrand: unique symbol;

/**
 * Secret material, main process only. Built only by `createResolvedCredential`.
 *
 * The secret lives in a closure, never in a property. `reveal` is an own function property, so
 * `structuredClone`, `v8.serialize` and every postMessage/IPC path (Electron IPC uses structured
 * clone) throw instead of sending it. `toJSON` throws. `String()`, template literals and
 * `util.inspect` print a redacted placeholder. The object is frozen.
 *
 * Call `reveal()` only while building the request that needs the secret, and keep no copy. It is a
 * snapshot: for OAuth the access token was fresh at resolution time, so resolve again per request.
 * `baseUrl` is the only target a provider may send the secret to.
 */
export interface ResolvedCredential {
  readonly [resolvedCredentialBrand]: true;
  readonly credentialId: string;
  readonly providerId: string;
  readonly kind: CredentialKind;
  readonly baseUrl: string;
  reveal(): string;
}

export interface ResolvedCredentialInput {
  readonly credentialId: string;
  readonly providerId: string;
  readonly kind: CredentialKind;
  /** Required unless `kind` is `none`, which must not have one. */
  readonly secret?: string | undefined;
  readonly baseUrl: string;
}

const REDACTED = '[ResolvedCredential redacted]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const issued = new WeakSet<object>();

function checkInput(input: ResolvedCredentialInput): void {
  // Constant messages only: nothing from the input (which carries the secret) is echoed.
  if (!CredentialKindSchema.safeParse(input.kind).success) {
    throw new TypeError('ResolvedCredential: unknown kind');
  }
  if (input.credentialId.length === 0 || input.providerId.length === 0) {
    throw new TypeError('ResolvedCredential: credentialId and providerId are required');
  }
  if (parseHttpUrl(input.baseUrl) === null) {
    throw new TypeError('ResolvedCredential: baseUrl must be http(s) without credentials');
  }
  const hasSecret = input.secret !== undefined && input.secret.length > 0;
  if (input.kind === 'none' ? input.secret !== undefined : !hasSecret) {
    throw new TypeError('ResolvedCredential: secret must be present exactly unless kind is none');
  }
}

export function createResolvedCredential(input: ResolvedCredentialInput): ResolvedCredential {
  checkInput(input);
  const { secret } = input;
  const reveal =
    secret === undefined
      ? (): string => {
          throw new TypeError('ResolvedCredential: a credential of kind none has no secret');
        }
      : (): string => secret;
  const credential = Object.freeze({
    credentialId: input.credentialId,
    providerId: input.providerId,
    kind: input.kind,
    baseUrl: input.baseUrl,
    reveal,
    toJSON(): never {
      throw new TypeError('ResolvedCredential cannot be serialized');
    },
    toString: (): string => REDACTED,
    [Symbol.toPrimitive]: (): string => REDACTED,
    [INSPECT]: (): string => REDACTED,
  });
  issued.add(credential);
  return brand(credential);
}

/** Only objects this module issued pass, so look-alikes and spread copies are rejected. */
export function isResolvedCredential(value: unknown): value is ResolvedCredential {
  return typeof value === 'object' && value !== null && issued.has(value);
}

function brand(
  credential: Omit<ResolvedCredential, typeof resolvedCredentialBrand>,
): ResolvedCredential {
  if (!isResolvedCredential(credential)) throw new TypeError('ResolvedCredential: not issued');
  return credential;
}
