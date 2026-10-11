import { describe, expect, it } from 'vitest';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import { createTokenRefresher } from './refresher.ts';
import type { OAuthTokens, TokenStore } from './refresher.ts';
import type { FetchLike, FetchRequest, TokenEndpointConfig } from './token-endpoint.ts';

const CONFIG: TokenEndpointConfig = {
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'cid',
};
const ID = 'cred_A';
const never = new AbortController().signal;

function memoryStore(
  initial: OAuthTokens,
): TokenStore & { current(): OAuthTokens; saves: number; failSaves: boolean } {
  let tokens = initial;
  const store = {
    saves: 0,
    failSaves: false,
    current: () => tokens,
    load: (id: string): Promise<Result<OAuthTokens, 'not_found'>> =>
      Promise.resolve(id === ID ? ok(tokens) : err('not_found')),
    save: (_id: string, next: OAuthTokens): Promise<Result<void, 'persist_failed'>> => {
      store.saves += 1;
      if (store.failSaves) return Promise.resolve(err('persist_failed'));
      tokens = next;
      return Promise.resolve(ok(undefined));
    },
  };
  return store;
}

/** A token endpoint with rotating refresh tokens: each refresh token works exactly once. */
function rotatingServer(delayMs = 0): {
  readonly fetch: FetchLike;
  readonly calls: () => number;
  revoke(): void;
} {
  let generation = 0;
  let calls = 0;
  let revoked = false;
  return {
    calls: () => calls,
    revoke() {
      revoked = true;
    },
    fetch: async (_url, req: FetchRequest) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const presented = new URLSearchParams(req.body).get('refresh_token');
      const valid = !revoked && presented === `rt-${String(generation)}`;
      if (valid) generation += 1;
      return {
        status: valid ? 200 : 400,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify(
              valid
                ? {
                    access_token: `at-${String(generation)}`,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    refresh_token: `rt-${String(generation)}`,
                  }
                : { error: 'invalid_grant' },
            ),
          ),
      };
    },
  };
}

const T0 = 1_800_000_000_000;

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'at-0',
    refreshToken: 'rt-0',
    expiresAt: T0 + 3_600_000,
    obtainedAt: T0,
    ...overrides,
  };
}

function refresher(store: TokenStore, fetch: FetchLike, now: () => number) {
  return createTokenRefresher({ store, fetch, now, skewMs: 60_000, requestTimeoutMs: 5_000 });
}

describe('createTokenRefresher', () => {
  it('returns the stored token while it is comfortably fresh, without a request', async () => {
    const server = rotatingServer();
    const r = refresher(memoryStore(tokens()), server.fetch, () => T0 + 1000);
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-0'));
    expect(server.calls()).toBe(0);
  });

  it('refreshes inside the skew window and persists the rotated refresh token first', async () => {
    const store = memoryStore(tokens());
    const server = rotatingServer();
    const now = T0 + 3_600_000 - 30_000;
    const r = refresher(store, server.fetch, () => now);
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-1'));
    expect(store.current()).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: now + 3_600_000,
      obtainedAt: now,
    });
  });

  it('shares one refresh among concurrent callers so a rotating token is used once', async () => {
    const store = memoryStore(tokens({ expiresAt: T0 }));
    const server = rotatingServer(20);
    const r = refresher(store, server.fetch, () => T0 + 1);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => r.accessToken(ID, CONFIG, { signal: never })),
    );
    expect(results).toEqual(Array.from({ length: 5 }, () => ok('at-1')));
    expect(server.calls()).toBe(1);
  });

  it('does not refresh again for a caller arriving after a refresh finished', async () => {
    const store = memoryStore(tokens({ expiresAt: T0 }));
    const server = rotatingServer();
    let now = T0 + 1;
    const r = refresher(store, server.fetch, () => now);
    await r.accessToken(ID, CONFIG, { signal: never });
    now += 1000;
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-1'));
    expect(server.calls()).toBe(1);
  });

  it('keeps the previous refresh token when the response omits one', async () => {
    const store = memoryStore(tokens({ expiresAt: T0 }));
    const fetch: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({ access_token: 'at-x', token_type: 'bearer', expires_in: 60 }),
          ),
      });
    const r = refresher(store, fetch, () => T0 + 1);
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-x'));
    expect(store.current().refreshToken).toBe('rt-0');
  });

  it('uses half the lifetime as the skew for short-lived tokens, so it does not refresh on every call', async () => {
    const store = memoryStore(tokens({ obtainedAt: T0, expiresAt: T0 + 40_000 }));
    const server = rotatingServer();
    const r = refresher(store, server.fetch, () => T0 + 10_000);
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-0'));
    expect(server.calls()).toBe(0);
  });

  it('treats a token without expiry as fresh until it is rejected', async () => {
    const server = rotatingServer();
    const r = refresher(memoryStore(tokens({ expiresAt: null })), server.fetch, () => T0 + 10 ** 9);
    expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(ok('at-0'));
    expect(server.calls()).toBe(0);
  });

  describe('after the provider rejected a token', () => {
    it('refreshes when the rejected token is still the stored one', async () => {
      const server = rotatingServer();
      const r = refresher(memoryStore(tokens()), server.fetch, () => T0 + 1);
      expect(await r.accessToken(ID, CONFIG, { signal: never, rejected: 'at-0' })).toEqual(
        ok('at-1'),
      );
    });

    it('refreshes for a rejecting caller that joined a flight started without its token', async () => {
      const base = memoryStore(tokens());
      const slowStore: TokenStore = {
        load: async (id) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return base.load(id);
        },
        save: (id, next) => base.save(id, next),
      };
      const server = rotatingServer();
      const r = refresher(slowStore, server.fetch, () => T0 + 1);
      const plain = r.accessToken(ID, CONFIG, { signal: never });
      const rejecting = r.accessToken(ID, CONFIG, { signal: never, rejected: 'at-0' });
      expect(await plain).toEqual(ok('at-0'));
      expect(await rejecting).toEqual(ok('at-1'));
      expect(server.calls()).toBe(1);
    });

    it('returns the newer token without refreshing when someone already replaced it', async () => {
      const store = memoryStore(tokens({ accessToken: 'at-1', refreshToken: 'rt-0' }));
      const server = rotatingServer();
      const r = refresher(store, server.fetch, () => T0 + 1);
      expect(await r.accessToken(ID, CONFIG, { signal: never, rejected: 'at-0' })).toEqual(
        ok('at-1'),
      );
      expect(server.calls()).toBe(0);
    });
  });

  describe('failures', () => {
    it('reports reauth_required when the token is stale and there is no refresh token', async () => {
      const r = refresher(
        memoryStore(tokens({ expiresAt: T0, refreshToken: null })),
        rotatingServer().fetch,
        () => T0 + 1,
      );
      expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(
        err({ kind: 'reauth_required' }),
      );
    });

    it('reports reauth_required on invalid_grant and leaves the store unchanged', async () => {
      const store = memoryStore(tokens({ expiresAt: T0 }));
      const server = rotatingServer();
      server.revoke();
      const r = refresher(store, server.fetch, () => T0 + 1);
      expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(
        err({ kind: 'reauth_required' }),
      );
      expect(store.current()).toEqual(tokens({ expiresAt: T0 }));
    });

    it('reports refresh_failed for other token endpoint errors', async () => {
      const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
      const r = refresher(memoryStore(tokens({ expiresAt: T0 })), failing, () => T0 + 1);
      expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(
        err({ kind: 'refresh_failed', error: { kind: 'network' } }),
      );
    });

    it('does not hand out a refreshed token it could not persist', async () => {
      const store = memoryStore(tokens({ expiresAt: T0 }));
      store.failSaves = true;
      const r = refresher(store, rotatingServer().fetch, () => T0 + 1);
      expect(await r.accessToken(ID, CONFIG, { signal: never })).toEqual(
        err({ kind: 'persist_failed' }),
      );
    });

    it('reports not_found for an unknown credential', async () => {
      const r = refresher(memoryStore(tokens()), rotatingServer().fetch, () => T0);
      expect(await r.accessToken('cred_missing', CONFIG, { signal: never })).toEqual(
        err({ kind: 'not_found' }),
      );
    });

    it('lets a caller abort its wait while the shared refresh completes for others', async () => {
      const store = memoryStore(tokens({ expiresAt: T0 }));
      const server = rotatingServer(30);
      const r = refresher(store, server.fetch, () => T0 + 1);
      const controller = new AbortController();
      const quitter = r.accessToken(ID, CONFIG, { signal: controller.signal });
      const stayer = r.accessToken(ID, CONFIG, { signal: never });
      controller.abort();
      expect(await quitter).toEqual(err({ kind: 'aborted' }));
      expect(await stayer).toEqual(ok('at-1'));
      expect(store.current().refreshToken).toBe('rt-1');
    });
  });
});
