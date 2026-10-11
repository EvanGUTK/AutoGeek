import { z } from 'zod';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

/** A public (secretless) OAuth client's token endpoint. PKCE replaces the client secret. */
export interface TokenEndpointConfig {
  readonly tokenEndpoint: string;
  readonly clientId: string;
}

export interface FetchRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  /** A token request is never re-sent to wherever a redirect points. */
  readonly redirect: 'error';
}

export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The subset of WHATWG `fetch` the token client uses; injected for tests and for main's net stack. */
export type FetchLike = (url: string, request: FetchRequest) => Promise<FetchResponse>;

export interface TokenSet {
  readonly accessToken: string;
  /** Null when the response carried none; on refresh the caller then keeps the previous one. */
  readonly refreshToken: string | null;
  /** Epoch milliseconds by the local clock at receipt, or null when the server gave no lifetime. */
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

/** Never carries a token, a response body or vendor text. */
export type TokenError =
  | { readonly kind: 'network' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'invalid_response' }
  | { readonly kind: 'http_error'; readonly status: number }
  | { readonly kind: 'oauth_error'; readonly oauthError: string; readonly status: number };

/** A token response is well under 1 KiB; anything over this is refused before it is parsed. */
const MAX_BODY_CHARS = 64 * 1024;
const OAUTH_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/;

/** RFC 6749 §5.1. Unknown vendor fields are allowed and ignored. */
const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().refine((type) => type.toLowerCase() === 'bearer'),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(10 * 365 * 24 * 3600)
    .optional(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  scope: z.string().max(4096).optional(),
});

/** RFC 6749 §5.2. */
const ErrorResponseSchema = z.looseObject({ error: z.string() });

/** Throws RangeError unless `endpoint` is an absolute https URL without credentials. */
export function assertTokenEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (thrown) {
    throw new RangeError('token endpoint must be an absolute https URL', { cause: thrown });
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new RangeError('token endpoint must be an https URL without credentials');
  }
}

function interpret(status: number, text: string, receivedAt: number): Result<TokenSet, TokenError> {
  const json: unknown = JSON.parse(text);
  if (status < 200 || status > 299) {
    const parsedError = ErrorResponseSchema.safeParse(json);
    if (!parsedError.success) return err({ kind: 'http_error', status });
    const code = parsedError.data.error;
    return err({
      kind: 'oauth_error',
      oauthError: OAUTH_ERROR_PATTERN.test(code) ? code : 'unknown',
      status,
    });
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) return err({ kind: 'invalid_response' });
  const { access_token, expires_in, refresh_token, scope } = parsed.data;
  return ok({
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    expiresAt: expires_in === undefined ? null : receivedAt + expires_in * 1000,
    scope: scope ?? null,
  });
}

/**
 * Interprets a bounded body. Total: any throw from parsing or validation (a SyntaxError, or a
 * RangeError from pathological nesting) becomes `invalid_response`, or `http_error` for a non-2xx
 * status, never an exception. Nothing from the body is kept in the error.
 */
function interpretSafely(
  status: number,
  text: string,
  receivedAt: number,
): Result<TokenSet, TokenError> {
  try {
    return interpret(status, text, receivedAt);
  } catch {
    return err(
      status >= 200 && status <= 299
        ? { kind: 'invalid_response' }
        : { kind: 'http_error', status },
    );
  }
}

function declaredLengthExceeds(response: FetchResponse, limit: number): boolean {
  const declared = response.headers.get('content-length');
  if (declared === null) return false;
  const length = Number(declared);
  return !Number.isSafeInteger(length) || length < 0 || length > limit;
}

interface BoundedReply {
  readonly status: number;
  readonly text: string;
}

/**
 * POSTs a form to an https OAuth endpoint (redirects refused) and reads a bounded reply: a declared
 * or actual body over the cap is `invalid_response`, a rejected fetch is `network` (or `aborted`).
 */
async function postForm(
  endpoint: string,
  params: Readonly<Record<string, string>>,
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<Result<BoundedReply, TokenError>> {
  assertTokenEndpoint(endpoint);
  let response: FetchResponse;
  let text: string;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      signal,
      redirect: 'error',
    });
    if (declaredLengthExceeds(response, MAX_BODY_CHARS)) return err({ kind: 'invalid_response' });
    text = await response.text();
  } catch (thrown) {
    if (!(thrown instanceof Error)) throw thrown;
    return err({ kind: signal.aborted ? 'aborted' : 'network' });
  }
  if (text.length > MAX_BODY_CHARS) return err({ kind: 'invalid_response' });
  return ok({ status: response.status, text });
}

interface TokenRequest {
  readonly config: TokenEndpointConfig;
  readonly params: Readonly<Record<string, string>>;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

async function requestTokens(request: TokenRequest): Promise<Result<TokenSet, TokenError>> {
  const { config, params, fetch, signal, now } = request;
  const reply = await postForm(
    config.tokenEndpoint,
    { ...params, client_id: config.clientId },
    fetch,
    signal,
  );
  if (!reply.ok) return reply;
  return interpretSafely(reply.value.status, reply.value.text, now());
}

export interface ExchangeCodeInput {
  readonly config: TokenEndpointConfig;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

/** Exchanges an authorization code for tokens (RFC 6749 §4.1.3 with RFC 7636 `code_verifier`). */
export function exchangeCode(input: ExchangeCodeInput): Promise<Result<TokenSet, TokenError>> {
  return requestTokens({
    config: input.config,
    params: {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    fetch: input.fetch,
    signal: input.signal,
    now: input.now,
  });
}

export interface RefreshTokensInput {
  readonly config: TokenEndpointConfig;
  readonly refreshToken: string;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

/** Uses a refresh token (RFC 6749 §6). Call through a single-flight per credential. */
export function refreshTokens(input: RefreshTokensInput): Promise<Result<TokenSet, TokenError>> {
  return requestTokens({
    config: input.config,
    params: { grant_type: 'refresh_token', refresh_token: input.refreshToken },
    fetch: input.fetch,
    signal: input.signal,
    now: input.now,
  });
}
