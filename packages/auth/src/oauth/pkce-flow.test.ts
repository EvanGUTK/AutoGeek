import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { runPkceFlow } from './pkce-flow.ts';
import type { OAuthProviderConfig, OpenExternal } from './pkce-flow.ts';
import type { FetchLike, FetchRequest } from './token-endpoint.ts';

const CONFIG: OAuthProviderConfig = {
  authorizationEndpoint: 'https://auth.example.com/authorize?tenant=t1',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'autogeek-desktop',
  scopes: ['openid', 'offline_access'],
  extraAuthorizationParams: { prompt: 'consent' },
};
const NOW = 1_800_000_000_000;

function hit(redirectUri: string, query: string): Promise<number> {
  const url = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}?${query}`,
        headers: { connection: 'close' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(true);
    });
  });
}

interface Browser {
  readonly open: OpenExternal;
  readonly opened: URL[];
}

/** Simulates the user's browser: records the URL, then redirects back like the provider would. */
function browser(respond: (auth: URL) => string | null): Browser {
  const opened: URL[] = [];
  return {
    opened,
    open: (url) => {
      const auth = new URL(url);
      opened.push(auth);
      const query = respond(auth);
      if (query !== null) {
        const redirectUri = auth.searchParams.get('redirect_uri') ?? '';
        setTimeout(() => {
          void hit(redirectUri, query);
        }, 5);
      }
      return Promise.resolve(ok(undefined));
    },
  };
}

const approve = (auth: URL) => `code=granted-code&state=${auth.searchParams.get('state') ?? ''}`;

/** A token endpoint that checks the PKCE binding like a real server. */
function tokenServer(): {
  readonly fetch: FetchLike;
  readonly bodies: URLSearchParams[];
  challenge: string;
} {
  const state = {
    bodies: [] as URLSearchParams[],
    challenge: '',
  };
  const fetch: FetchLike = (_url, req: FetchRequest) => {
    const body = new URLSearchParams(req.body);
    state.bodies.push(body);
    const derived = createHash('sha256')
      .update(body.get('code_verifier') ?? '')
      .digest('base64url');
    const valid = body.get('code') === 'granted-code' && derived === state.challenge;
    return Promise.resolve({
      status: valid ? 200 : 400,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: () =>
        Promise.resolve(
          JSON.stringify(
            valid
              ? {
                  access_token: 'ya29.access-0123456789abcdef',
                  token_type: 'Bearer',
                  expires_in: 3600,
                  refresh_token: '1//refresh-0123456789abcdef',
                }
              : { error: 'invalid_grant' },
          ),
        ),
    });
  };
  return {
    fetch,
    bodies: state.bodies,
    get challenge() {
      return state.challenge;
    },
    set challenge(value: string) {
      state.challenge = value;
    },
  };
}

function run(
  b: Browser,
  options: {
    readonly fetch?: FetchLike;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
) {
  const server = tokenServer();
  const open: OpenExternal = (url) => {
    server.challenge = new URL(url).searchParams.get('code_challenge') ?? '';
    return b.open(url);
  };
  return {
    server,
    result: runPkceFlow({
      config: CONFIG,
      openExternal: open,
      fetch: options.fetch ?? server.fetch,
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: options.timeoutMs ?? 5_000,
      now: () => NOW,
    }),
  };
}

describe('runPkceFlow', () => {
  it('completes the authorization code flow with PKCE and returns tokens', async () => {
    const b = browser(approve);
    const { result, server } = run(b);
    expect(await result).toEqual(
      ok({
        accessToken: 'ya29.access-0123456789abcdef',
        refreshToken: '1//refresh-0123456789abcdef',
        expiresAt: NOW + 3_600_000,
        scope: null,
      }),
    );
    const auth = b.opened[0];
    expect(`${auth?.origin ?? ''}${auth?.pathname ?? ''}`).toBe(
      'https://auth.example.com/authorize',
    );
    expect(Object.fromEntries(auth?.searchParams ?? [])).toMatchObject({
      tenant: 't1',
      prompt: 'consent',
      response_type: 'code',
      client_id: 'autogeek-desktop',
      scope: 'openid offline_access',
      code_challenge_method: 'S256',
    });
    expect(auth?.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.bodies[0]?.get('redirect_uri')).toBe(auth?.searchParams.get('redirect_uri'));
    const port = Number(new URL(auth?.searchParams.get('redirect_uri') ?? '').port);
    expect(await refuses(port)).toBe(true);
  });

  it('never puts the code verifier in the browser URL', async () => {
    const b = browser(approve);
    const { result, server } = run(b);
    await result;
    const verifier = server.bodies[0]?.get('code_verifier') ?? '';
    expect(verifier).toHaveLength(43);
    expect(b.opened[0]?.toString()).not.toContain(verifier);
  });

  it('reports a provider error from the redirect', async () => {
    const b = browser(
      (auth) => `error=access_denied&state=${auth.searchParams.get('state') ?? ''}`,
    );
    expect(await run(b).result).toEqual(
      err({ kind: 'oauth_provider_error', oauthError: 'access_denied' }),
    );
  });

  it('times out when the browser never comes back, and stops listening', async () => {
    const b = browser(() => null);
    expect(await run(b, { timeoutMs: 50 }).result).toEqual(err({ kind: 'oauth_timeout' }));
    const port = Number(new URL(b.opened[0]?.searchParams.get('redirect_uri') ?? '').port);
    expect(await refuses(port)).toBe(true);
  });

  it('aborts while waiting for the browser', async () => {
    const controller = new AbortController();
    const b = browser(() => {
      setTimeout(() => {
        controller.abort();
      }, 5);
      return null;
    });
    expect(await run(b, { signal: controller.signal }).result).toEqual(
      err({ kind: 'oauth_aborted' }),
    );
  });

  it('stops listening when the browser cannot be opened', async () => {
    let redirect = '';
    const failing: Browser = {
      opened: [],
      open: (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
        return Promise.resolve(err('open_failed'));
      },
    };
    expect(await run(failing).result).toEqual(err({ kind: 'open_failed' }));
    expect(await refuses(Number(new URL(redirect).port))).toBe(true);
  });

  it('maps a token endpoint failure', async () => {
    const b = browser(approve);
    const rejecting: FetchLike = () =>
      Promise.resolve({
        status: 400,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        text: () => Promise.resolve(JSON.stringify({ error: 'invalid_grant' })),
      });
    expect(await run(b, { fetch: rejecting }).result).toEqual(
      err({
        kind: 'token_error',
        error: { kind: 'oauth_error', oauthError: 'invalid_grant', status: 400 },
      }),
    );
  });

  it.each([
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
    'scope',
  ])('refuses an extra authorization param that would override %s', async (name) => {
    const opened: string[] = [];
    const pending = runPkceFlow({
      config: { ...CONFIG, extraAuthorizationParams: { [name]: 'x' } },
      openExternal: (url): Promise<Result<void, 'open_failed'>> => {
        opened.push(url);
        return Promise.resolve(ok(undefined));
      },
      fetch: tokenServer().fetch,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      now: () => NOW,
    });
    await expect(pending).rejects.toThrow(RangeError);
    expect(opened).toEqual([]);
  });

  it.each([
    'http://auth.example.com/authorize',
    'https://u:p@auth.example.com/authorize',
    'https://auth.example.com/authorize#frag',
  ])('refuses an authorization endpoint of %s', async (authorizationEndpoint) => {
    const pending = runPkceFlow({
      config: { ...CONFIG, authorizationEndpoint },
      openExternal: () => Promise.resolve(ok(undefined)),
      fetch: tokenServer().fetch,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      now: () => NOW,
    });
    await expect(pending).rejects.toThrow(RangeError);
  });

  it('refuses an http token endpoint before opening the browser', async () => {
    const opened: string[] = [];
    const pending = runPkceFlow({
      config: { ...CONFIG, tokenEndpoint: 'http://auth.example.com/token' },
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve(ok(undefined));
      },
      fetch: tokenServer().fetch,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      now: () => NOW,
    });
    await expect(pending).rejects.toThrow(RangeError);
    expect(opened).toEqual([]);
  });
});
