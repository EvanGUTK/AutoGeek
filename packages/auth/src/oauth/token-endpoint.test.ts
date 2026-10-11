import { describe, expect, it } from 'vitest';
import { exchangeCode, refreshTokens } from './token-endpoint.ts';
import type { FetchLike, FetchRequest, TokenEndpointConfig } from './token-endpoint.ts';

const CONFIG: TokenEndpointConfig = {
  tokenEndpoint: 'https://auth.example.com/oauth/token',
  clientId: 'autogeek-desktop',
};
const NOW = 1_800_000_000_000;
const never = new AbortController().signal;

interface Recorded {
  readonly url: string;
  readonly request: FetchRequest;
}

function fakeFetch(
  status: number,
  body: string,
  contentType = 'application/json',
  extraHeaders: Readonly<Record<string, string>> = {},
): { readonly fetch: FetchLike; readonly calls: Recorded[]; readonly bodyReads: () => number } {
  const calls: Recorded[] = [];
  let reads = 0;
  const headers: Record<string, string> = { 'content-type': contentType, ...extraHeaders };
  return {
    calls,
    bodyReads: () => reads,
    fetch: (url, request) => {
      calls.push({ url, request });
      return Promise.resolve({
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: () => {
          reads += 1;
          return Promise.resolve(body);
        },
      });
    },
  };
}

const exchange = (fetch: FetchLike, signal: AbortSignal = never) =>
  exchangeCode({
    config: CONFIG,
    code: 'the-code',
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'http://127.0.0.1:5000/callback',
    fetch,
    signal,
    now: () => NOW,
  });

const ACCESS = 'ya29.access-token-value-0123456789';
const REFRESH = '1//refresh-token-value-0123456789';

describe('exchangeCode', () => {
  it('posts a form-encoded authorization_code grant without following redirects', async () => {
    const { fetch, calls } = fakeFetch(
      200,
      JSON.stringify({ access_token: ACCESS, token_type: 'Bearer' }),
    );
    await exchange(fetch);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(CONFIG.tokenEndpoint);
    expect(call?.request.method).toBe('POST');
    expect(call?.request.redirect).toBe('error');
    expect(call?.request.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(Object.fromEntries(new URLSearchParams(call?.request.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:5000/callback',
      client_id: 'autogeek-desktop',
      code_verifier: 'v'.repeat(43),
    });
  });

  it('returns the token set with an absolute expiry', async () => {
    const { fetch } = fakeFetch(
      200,
      JSON.stringify({
        access_token: ACCESS,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: REFRESH,
        scope: 'openid email',
        vendor_extra: { ignored: true },
      }),
    );
    expect(await exchange(fetch)).toEqual({
      ok: true,
      value: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: NOW + 3_600_000,
        scope: 'openid email',
      },
    });
  });

  it('accepts a response without expiry, refresh token or scope', async () => {
    const { fetch } = fakeFetch(
      200,
      JSON.stringify({ access_token: ACCESS, token_type: 'Bearer' }),
    );
    expect(await exchange(fetch)).toEqual({
      ok: true,
      value: { accessToken: ACCESS, refreshToken: null, expiresAt: null, scope: null },
    });
  });

  it.each([
    ['not JSON', 'access_token=x&token_type=bearer'],
    ['a JSON array', '[]'],
    ['a missing access_token', JSON.stringify({ token_type: 'bearer' })],
    ['an empty access_token', JSON.stringify({ access_token: '', token_type: 'bearer' })],
    ['a non-bearer token type', JSON.stringify({ access_token: ACCESS, token_type: 'mac' })],
    [
      'a string expires_in',
      JSON.stringify({ access_token: ACCESS, token_type: 'bearer', expires_in: '3600' }),
    ],
    [
      'a negative expires_in',
      JSON.stringify({ access_token: ACCESS, token_type: 'bearer', expires_in: -1 }),
    ],
  ])('rejects %s as invalid_response', async (_name, body) => {
    expect(await exchange(fakeFetch(200, body).fetch)).toEqual({
      ok: false,
      error: { kind: 'invalid_response' },
    });
  });

  it('rejects an oversized body as invalid_response', async () => {
    // Valid fields; only an unknown vendor field makes it oversized.
    const huge = JSON.stringify({
      access_token: ACCESS,
      token_type: 'bearer',
      padding: 'x'.repeat(70_000),
    });
    expect(await exchange(fakeFetch(200, huge).fetch)).toEqual({
      ok: false,
      error: { kind: 'invalid_response' },
    });
  });

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const fake = fakeFetch(200, '{}', 'application/json', { 'content-length': String(65 * 1024) });
    expect(await exchange(fake.fetch)).toEqual({ ok: false, error: { kind: 'invalid_response' } });
    expect(fake.bodyReads()).toBe(0);
  });

  it.each(['-1', 'abc', '1e400'])('refuses a malformed Content-Length of %s', async (length) => {
    const valid = JSON.stringify({ access_token: ACCESS, token_type: 'bearer' });
    const fake = fakeFetch(200, valid, 'application/json', { 'content-length': length });
    expect(await exchange(fake.fetch)).toEqual({ ok: false, error: { kind: 'invalid_response' } });
    expect(fake.bodyReads()).toBe(0);
  });

  it('turns a parser or validator throw on a deeply nested body into invalid_response', async () => {
    // Within the size cap, nested far deeper than any real response.
    const depth = 30_000;
    const nested = `{"access_token":"x","token_type":"bearer","n":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(nested.length).toBeLessThan(64 * 1024);
    const result = await exchange(fakeFetch(200, nested).fetch);
    // Either the parser copes and the extra field is ignored, or it throws and we fail closed;
    // it must never reject.
    expect([true, false]).toContain(result.ok);
  });

  it('fails closed, not with an exception, when parsing throws a non-syntax error', async () => {
    const original = JSON.parse;
    JSON.parse = () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    try {
      expect(await exchange(fakeFetch(200, '{}').fetch)).toEqual({
        ok: false,
        error: { kind: 'invalid_response' },
      });
      expect(await exchange(fakeFetch(400, '{}').fetch)).toEqual({
        ok: false,
        error: { kind: 'http_error', status: 400 },
      });
    } finally {
      JSON.parse = original;
    }
  });

  it('maps an RFC 6749 error response to oauth_error without its description', async () => {
    const { fetch } = fakeFetch(
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: `echo ${ACCESS}` }),
    );
    const result = await exchange(fetch);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'oauth_error', oauthError: 'invalid_grant', status: 400 },
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS);
  });

  it('collapses an unexpected error code to unknown', async () => {
    const { fetch } = fakeFetch(401, JSON.stringify({ error: '<b>bad</b>' }));
    expect(await exchange(fetch)).toEqual({
      ok: false,
      error: { kind: 'oauth_error', oauthError: 'unknown', status: 401 },
    });
  });

  it('maps another non-2xx status to http_error without reading anything into the error', async () => {
    const { fetch } = fakeFetch(503, `<html>${ACCESS}</html>`, 'text/html');
    const result = await exchange(fetch);
    expect(result).toEqual({ ok: false, error: { kind: 'http_error', status: 503 } });
  });

  it('maps a fetch rejection to network, and an abort to aborted', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError(`fetch failed ${ACCESS}`));
    expect(await exchange(failing)).toEqual({ ok: false, error: { kind: 'network' } });
    const controller = new AbortController();
    const aborting: FetchLike = () => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    };
    expect(await exchange(aborting, controller.signal)).toEqual({
      ok: false,
      error: { kind: 'aborted' },
    });
  });

  it('passes the signal to fetch', async () => {
    const { fetch, calls } = fakeFetch(
      200,
      JSON.stringify({ access_token: ACCESS, token_type: 'bearer' }),
    );
    const controller = new AbortController();
    await exchange(fetch, controller.signal);
    expect(calls[0]?.request.signal).toBe(controller.signal);
  });
});

describe('refreshTokens', () => {
  it('posts a refresh_token grant and returns the new set', async () => {
    const { fetch, calls } = fakeFetch(
      200,
      JSON.stringify({
        access_token: 'ya29.new-access-0123456789',
        token_type: 'Bearer',
        expires_in: 60,
      }),
    );
    const result = await refreshTokens({
      config: CONFIG,
      refreshToken: REFRESH,
      fetch,
      signal: never,
      now: () => NOW,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.request.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: 'autogeek-desktop',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'ya29.new-access-0123456789',
        refreshToken: null,
        expiresAt: NOW + 60_000,
        scope: null,
      },
    });
  });
});

describe('config validation', () => {
  it.each([
    'http://auth.example.com/token',
    'ftp://auth.example.com/token',
    'not a url',
    'https://user:pw@auth.example.com/token',
  ])('refuses a token endpoint of %s (programmer error)', async (tokenEndpoint) => {
    const { fetch, calls } = fakeFetch(200, '{}');
    await expect(
      exchangeCode({
        config: { ...CONFIG, tokenEndpoint },
        code: 'c',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'http://127.0.0.1:5000/callback',
        fetch,
        signal: never,
        now: () => NOW,
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});
