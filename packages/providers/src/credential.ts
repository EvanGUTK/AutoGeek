import { err, ok, providerError } from '@autogeek/core';
import type { ProviderError, Result } from '@autogeek/core';

export type CredentialKind = 'api_key' | 'oauth_pkce' | 'none';

/**
 * The resolved credential an adapter receives (structurally ag-auth's `ResolvedCredential`).
 * `reveal()` is called inline while building request headers and the result is never stored.
 * `baseUrl` is the ONLY source of the request target; adapters append fixed path suffixes.
 */
export interface ProviderCredential {
  readonly credentialId: string;
  readonly providerId: string;
  readonly kind: CredentialKind;
  readonly baseUrl: string;
  reveal(): string;
}

export interface CredentialRequirements {
  readonly providerId: string;
  /** Stored kinds this adapter accepts (the catalog's `credentialKinds`). */
  readonly kinds: readonly CredentialKind[];
  /** For fixed-endpoint providers: the only origin a request may go to. */
  readonly fixedOrigin?: string;
}

/**
 * Defense in depth before any I/O: the credential must belong to this provider, be of an accepted
 * kind and, for fixed providers, point at the catalog origin. Auth already enforces this when it
 * resolves; a failure here means a wiring bug, so it maps to `credential_mismatch` and nothing is
 * sent. Never calls `reveal()`.
 */
export function checkCredential(
  credential: ProviderCredential,
  requirements: CredentialRequirements,
): Result<URL, ProviderError> {
  const mismatch = err(providerError('credential_mismatch', requirements.providerId));
  if (credential.providerId !== requirements.providerId) return mismatch;
  if (!requirements.kinds.includes(credential.kind)) return mismatch;
  if (!URL.canParse(credential.baseUrl)) return mismatch;
  const url = new URL(credential.baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return mismatch;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return mismatch;
  }
  if (requirements.fixedOrigin !== undefined && url.origin !== requirements.fixedOrigin) {
    return mismatch;
  }
  return ok(url);
}

/** `base` plus a fixed path suffix, keeping any path prefix of an editable base URL. */
export function endpoint(base: URL, suffix: string): string {
  const prefix = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}/${suffix.replace(/^\/+/, '')}`;
}
