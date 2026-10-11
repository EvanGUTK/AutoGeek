import { describe, expect, it } from 'vitest';
import { err, ok } from '../result.ts';
import { revokeToken } from './token-endpoint.ts';
import type { FetchLike, FetchRequest } from './token-endpoint.ts';

const TOKEN = '1//refresh-token-to-revoke-0123456789';
const never = new AbortController().signal;

function reply(
  status: number,
  body: string,
): { readonly fetch: FetchLike; readonly requests: FetchRequest[]; readonly urls: string[] } {
  const requests: FetchRequest[] = [];
  const urls: string[] = [];
  return {
    requests,
    urls,
    fetch: (url, req) => {
      urls.push(url);
      requests.push(req);
      return Promise.resolve({
        status,
        headers: { get: () => null },
        text: () => Promise.resolve(body),
      });
    },
  };
}

const revoke = (fetch: FetchLike, endpoint = 'https://auth.example.com/revoke') =>
  revokeToken({
    revocationEndpoint: endpoint,
    clientId: 'cid',
    token: TOKEN,
    tokenTypeHint: 'refresh_token',
    fetch,
    signal: never,
  });

describe('revokeToken', () => {
  it('posts the token with its type hint and client id, refusing redirects', async () => {
    const r = reply(200, '');
    expect(await revoke(r.fetch)).toEqual(ok(undefined));
    expect(r.urls).toEqual(['https://auth.example.com/revoke']);
    expect(r.requests[0]?.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(r.requests[0]?.body))).toEqual({
      token: TOKEN,
      token_type_hint: 'refresh_token',
      client_id: 'cid',
    });
  });

  it('treats any 200 as revoked and ignores the body (RFC 7009 §2.2)', async () => {
    expect(await revoke(reply(200, '<html>not json</html>').fetch)).toEqual(ok(undefined));
  });

  it('maps an RFC 7009 error response to oauth_error', async () => {
    expect(
      await revoke(reply(400, JSON.stringify({ error: 'unsupported_token_type' })).fetch),
    ).toEqual(err({ kind: 'oauth_error', oauthError: 'unsupported_token_type', status: 400 }));
  });

  it('maps another failure to http_error and never echoes the token', async () => {
    const result = await revoke(reply(503, `<html>${TOKEN}</html>`).fetch);
    expect(result).toEqual(err({ kind: 'http_error', status: 503 }));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('treats a 2xx other than 200 as a failure', async () => {
    expect(await revoke(reply(204, '').fetch)).toEqual(err({ kind: 'http_error', status: 204 }));
  });

  it('maps a network failure', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    expect(await revoke(failing)).toEqual(err({ kind: 'network' }));
  });

  it('refuses a non-https revocation endpoint before any I/O', async () => {
    const r = reply(200, '');
    await expect(revoke(r.fetch, 'http://auth.example.com/revoke')).rejects.toThrow(RangeError);
    expect(r.urls).toEqual([]);
  });
});
