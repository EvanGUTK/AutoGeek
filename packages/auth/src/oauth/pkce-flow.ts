import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { startLoopbackListener } from './loopback.ts';
import type { LoopbackListener } from './loopback.ts';
import { createCodeVerifier, createState, deriveCodeChallenge } from './pkce.ts';
import { assertTokenEndpoint, exchangeCode } from './token-endpoint.ts';
import type { FetchLike, TokenError, TokenSet } from './token-endpoint.ts';

/** Per-provider configuration of the generic engine. No provider-specific flow exists (D-002). */
export interface OAuthProviderConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Extra authorization request parameters; may not override any parameter the engine sets. */
  readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
}

/** Opens the URL in the user's default browser (main process, `shell.openExternal`). */
export type OpenExternal = (url: string) => Promise<Result<void, 'open_failed'>>;

export type PkceFlowError =
  | { readonly kind: 'oauth_timeout' }
  | { readonly kind: 'oauth_aborted' }
  | { readonly kind: 'oauth_provider_error'; readonly oauthError: string }
  | { readonly kind: 'open_failed' }
  | { readonly kind: 'listen_failed' }
  | { readonly kind: 'token_error'; readonly error: TokenError };

export interface PkceFlowInput {
  readonly config: OAuthProviderConfig;
  readonly openExternal: OpenExternal;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  /** How long to wait for the browser to come back. */
  readonly timeoutMs: number;
  readonly now: () => number;
}

const RESERVED_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
]);

function authorizationBase(config: OAuthProviderConfig): URL {
  let url: URL;
  try {
    url = new URL(config.authorizationEndpoint);
  } catch (thrown) {
    throw new RangeError('authorization endpoint must be an absolute https URL', { cause: thrown });
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new RangeError('authorization endpoint must be https without credentials or fragment');
  }
  const extra = Object.keys(config.extraAuthorizationParams ?? {});
  for (const name of [...url.searchParams.keys(), ...extra]) {
    if (RESERVED_PARAMS.has(name)) {
      throw new RangeError(`authorization parameter ${name} is set by the engine`);
    }
  }
  return url;
}

function authorizationUrl(
  base: URL,
  config: OAuthProviderConfig,
  redirectUri: string,
  state: string,
  codeVerifier: string,
): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(config.extraAuthorizationParams ?? {})) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', deriveCodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function awaitCallbackAndExchange(
  input: PkceFlowInput,
  listener: LoopbackListener,
  authUrl: string,
  codeVerifier: string,
): Promise<Result<TokenSet, PkceFlowError>> {
  const opened = await input.openExternal(authUrl);
  if (!opened.ok) return err({ kind: 'open_failed' });
  const callback = await listener.result;
  if (!callback.ok) {
    switch (callback.error.kind) {
      case 'timeout':
        return err({ kind: 'oauth_timeout' });
      case 'aborted':
        return err({ kind: 'oauth_aborted' });
      case 'provider_error':
        return err({ kind: 'oauth_provider_error', oauthError: callback.error.oauthError });
    }
  }
  const tokens = await exchangeCode({
    config: { tokenEndpoint: input.config.tokenEndpoint, clientId: input.config.clientId },
    code: callback.value.code,
    codeVerifier,
    redirectUri: listener.redirectUri,
    fetch: input.fetch,
    signal: input.signal,
    now: input.now,
  });
  return tokens.ok ? ok(tokens.value) : err({ kind: 'token_error', error: tokens.error });
}

/**
 * Runs one OAuth 2.0 authorization code flow with PKCE (S256) through a loopback redirect
 * (RFC 8252): fresh verifier and state, a one-shot 127.0.0.1 listener, the browser for consent,
 * then the code exchange. Configuration errors throw RangeError before anything starts. The
 * listener is closed on every path. The verifier never leaves this process except in the token
 * request body.
 */
export async function runPkceFlow(input: PkceFlowInput): Promise<Result<TokenSet, PkceFlowError>> {
  const base = authorizationBase(input.config);
  assertTokenEndpoint(input.config.tokenEndpoint);
  const codeVerifier = createCodeVerifier();
  const state = createState();
  const started = await startLoopbackListener({
    expectedState: state,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!started.ok) {
    return err(started.error === 'aborted' ? { kind: 'oauth_aborted' } : { kind: 'listen_failed' });
  }
  const listener = started.value;
  try {
    const authUrl = authorizationUrl(base, input.config, listener.redirectUri, state, codeVerifier);
    return await awaitCallbackAndExchange(input, listener, authUrl, codeVerifier);
  } finally {
    listener.close();
    await listener.closed;
  }
}
