import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { createSingleFlight } from './single-flight.ts';
import { refreshTokens } from './token-endpoint.ts';
import type { FetchLike, TokenEndpointConfig, TokenError } from './token-endpoint.ts';

/** What the vault stores for an OAuth credential. Times are epoch ms by the local clock. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
  readonly obtainedAt: number;
}

/** Durable token storage, implemented by the vault. `save` must be durable when it returns ok. */
export interface TokenStore {
  load(credentialId: string): Promise<Result<OAuthTokens, 'not_found'>>;
  save(credentialId: string, tokens: OAuthTokens): Promise<Result<void, 'persist_failed'>>;
}

export type RefreshError =
  | { readonly kind: 'not_found' }
  /** No usable refresh token (missing, revoked or expired): the user must sign in again. */
  | { readonly kind: 'reauth_required' }
  | { readonly kind: 'refresh_failed'; readonly error: TokenError }
  /** The refresh worked but could not be stored; the new token is not handed out. */
  | { readonly kind: 'persist_failed' }
  | { readonly kind: 'aborted' };

export interface AccessTokenOptions {
  readonly signal: AbortSignal;
  /** The access token the provider just rejected (401); forces a refresh if it is still current. */
  readonly rejected?: string;
}

export interface TokenRefresher {
  accessToken(
    credentialId: string,
    config: TokenEndpointConfig,
    options: AccessTokenOptions,
  ): Promise<Result<string, RefreshError>>;
}

export interface TokenRefresherOptions {
  readonly store: TokenStore;
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** Refresh this long before expiry, to tolerate clock skew and request latency. */
  readonly skewMs: number;
  /** Bounds the shared refresh request; deliberately independent of any one caller's signal. */
  readonly requestTimeoutMs: number;
}

/**
 * Fresh until `skew` before expiry, but never more than half the token's lifetime early, so a
 * short-lived token is not refreshed on every call. A token without expiry stays fresh until a
 * provider rejects it.
 */
function isFresh(tokens: OAuthTokens, now: number, skewMs: number): boolean {
  if (tokens.expiresAt === null) return true;
  const lifetime = tokens.expiresAt - tokens.obtainedAt;
  const margin = Math.min(skewMs, Math.max(0, lifetime / 2));
  return now < tokens.expiresAt - margin;
}

function isAbortError(thrown: unknown): boolean {
  return thrown instanceof Error && thrown.name === 'AbortError';
}

/**
 * Hands out OAuth access tokens, refreshing when needed. Every call for a credential runs through
 * one single-flight and re-reads the stored tokens inside it, so with rotating refresh tokens a
 * refresh token is presented exactly once even when callers race. A rotated refresh token is saved
 * before the new access token is returned.
 */
export function createTokenRefresher(options: TokenRefresherOptions): TokenRefresher {
  const { store, fetch, now, skewMs, requestTimeoutMs } = options;
  const flight = createSingleFlight<string, Result<string, RefreshError>>();

  async function refreshIfNeeded(
    credentialId: string,
    config: TokenEndpointConfig,
    rejected: string | undefined,
  ): Promise<Result<string, RefreshError>> {
    const loaded = await store.load(credentialId);
    if (!loaded.ok) return err({ kind: 'not_found' });
    const current = loaded.value;
    const forced = rejected !== undefined && rejected === current.accessToken;
    if (!forced && isFresh(current, now(), skewMs)) return ok(current.accessToken);
    if (current.refreshToken === null) return err({ kind: 'reauth_required' });

    const refreshed = await refreshTokens({
      config,
      refreshToken: current.refreshToken,
      fetch,
      signal: AbortSignal.timeout(requestTimeoutMs),
      now,
    });
    if (!refreshed.ok) {
      const { error } = refreshed;
      return err(
        error.kind === 'oauth_error' && error.oauthError === 'invalid_grant'
          ? { kind: 'reauth_required' }
          : { kind: 'refresh_failed', error },
      );
    }
    const next: OAuthTokens = {
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken ?? current.refreshToken,
      expiresAt: refreshed.value.expiresAt,
      obtainedAt: now(),
    };
    const saved = await store.save(credentialId, next);
    if (!saved.ok) return err({ kind: 'persist_failed' });
    return ok(next.accessToken);
  }

  async function joinFlight(
    credentialId: string,
    config: TokenEndpointConfig,
    options: AccessTokenOptions,
  ): Promise<Result<string, RefreshError>> {
    try {
      return await flight.run(
        credentialId,
        () => refreshIfNeeded(credentialId, config, options.rejected),
        options.signal,
      );
    } catch (thrown) {
      if (isAbortError(thrown)) return err({ kind: 'aborted' });
      throw thrown;
    }
  }

  return {
    async accessToken(credentialId, config, options) {
      const result = await joinFlight(credentialId, config, options);
      // A caller that joined a flight started without its `rejected` token may get that same token
      // back; one more round then sees it is still current and refreshes.
      if (options.rejected !== undefined && result.ok && result.value === options.rejected) {
        return joinFlight(credentialId, config, options);
      }
      return result;
    },
  };
}
