import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CALLBACK_PATH, startLoopbackListener } from './loopback.ts';
import type { LoopbackListener } from './loopback.ts';

const STATE = 'Zq9xY8wV7uT6sR5pZq9xY8wV7uT6sR5pZq9xY8wV7uT';

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

function send(
  listener: LoopbackListener,
  path: string,
  options: { readonly host?: string; readonly method?: string } = {},
): Promise<Reply> {
  const url = new URL(listener.redirectUri);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? url.host, connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function refusesConnections(port: number): Promise<boolean> {
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

const open: LoopbackListener[] = [];

async function start(
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<LoopbackListener> {
  const started = await startLoopbackListener({
    expectedState: STATE,
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal ?? new AbortController().signal,
  });
  if (!started.ok) throw new Error(`listen failed: ${started.error}`);
  open.push(started.value);
  return started.value;
}

afterEach(async () => {
  for (const listener of open.splice(0)) {
    listener.close();
    await listener.closed;
  }
});

const callback = (query: string) => `${CALLBACK_PATH}?${query}`;

describe('startLoopbackListener', () => {
  it('listens on 127.0.0.1 at an ephemeral port with a /callback redirect URI', async () => {
    const listener = await start();
    const url = new URL(listener.redirectUri);
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.pathname).toBe(CALLBACK_PATH);
  });

  it('resolves with the code on a valid callback, then stops listening', async () => {
    const listener = await start();
    const reply = await send(listener, callback(`code=auth-code-1&state=${STATE}`));
    expect(reply.status).toBe(200);
    expect(await listener.result).toEqual({ ok: true, value: { code: 'auth-code-1' } });
    await listener.closed;
    expect(await refusesConnections(Number(new URL(listener.redirectUri).port))).toBe(true);
  });

  it('serves a constant page that reflects nothing and leaks nothing', async () => {
    const listener = await start();
    const reply = await send(listener, callback(`code=<script>x</script>&state=${STATE}`));
    expect(reply.body).not.toContain('<script>x');
    expect(reply.body).not.toContain(STATE);
    expect(reply.headers['content-security-policy']).toBe("default-src 'none'");
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it.each([
    ['a wrong state', `code=c&state=${STATE.slice(0, -1)}X`],
    ['a missing state', 'code=c'],
    ['a state of a different length', `code=c&state=${STATE}A`],
    ['a duplicated state', `code=c&state=${STATE}&state=${STATE}`],
    ['a duplicated code', `code=c&code=d&state=${STATE}`],
    ['a missing code', `state=${STATE}`],
    ['an empty code', `code=&state=${STATE}`],
    ['an oversized code', `code=${'c'.repeat(4097)}&state=${STATE}`],
  ])('rejects %s with 400 and keeps waiting', async (_name, query) => {
    const listener = await start();
    expect((await send(listener, callback(query))).status).toBe(400);
    expect((await send(listener, callback(`code=ok&state=${STATE}`))).status).toBe(200);
    expect(await listener.result).toEqual({ ok: true, value: { code: 'ok' } });
  });

  it('rejects a request whose Host is not the bound loopback address (DNS rebinding)', async () => {
    const listener = await start();
    const port = new URL(listener.redirectUri).port;
    for (const host of [`localhost:${port}`, `evil.example:${port}`, '127.0.0.1', `127.0.0.1:1`]) {
      expect((await send(listener, callback(`code=c&state=${STATE}`), { host })).status).toBe(400);
    }
    expect((await send(listener, callback(`code=ok&state=${STATE}`))).status).toBe(200);
    expect((await listener.result).ok).toBe(true);
  });

  it('answers other paths with 404 and other methods with 405', async () => {
    const listener = await start();
    expect((await send(listener, `/other?code=c&state=${STATE}`)).status).toBe(404);
    expect((await send(listener, `${CALLBACK_PATH}/x?code=c&state=${STATE}`)).status).toBe(404);
    expect(
      (await send(listener, callback(`code=c&state=${STATE}`), { method: 'POST' })).status,
    ).toBe(405);
  });

  it('reports a provider error that carries the right state', async () => {
    const listener = await start();
    const reply = await send(
      listener,
      callback(
        `error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}&state=${STATE}`,
      ),
    );
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain('<b>no</b>');
    expect(await listener.result).toEqual({
      ok: false,
      error: { kind: 'provider_error', oauthError: 'access_denied' },
    });
  });

  it('collapses a provider error code outside the RFC 6749 shape to unknown', async () => {
    const listener = await start();
    await send(listener, callback(`error=${encodeURIComponent('<img src=x>')}&state=${STATE}`));
    expect(await listener.result).toEqual({
      ok: false,
      error: { kind: 'provider_error', oauthError: 'unknown' },
    });
  });

  it('ignores a provider error with a wrong state', async () => {
    const listener = await start();
    expect((await send(listener, callback('error=access_denied&state=nope'))).status).toBe(400);
    expect((await send(listener, callback(`code=ok&state=${STATE}`))).status).toBe(200);
    expect((await listener.result).ok).toBe(true);
  });

  it('times out', async () => {
    const listener = await start({ timeoutMs: 50 });
    expect(await listener.result).toEqual({ ok: false, error: { kind: 'timeout' } });
    await listener.closed;
  });

  it('aborts', async () => {
    const controller = new AbortController();
    const listener = await start({ signal: controller.signal });
    controller.abort();
    expect(await listener.result).toEqual({ ok: false, error: { kind: 'aborted' } });
    await listener.closed;
    expect(await refusesConnections(Number(new URL(listener.redirectUri).port))).toBe(true);
  });

  it('refuses to start with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = await startLoopbackListener({
      expectedState: STATE,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(started).toEqual({ ok: false, error: 'aborted' });
  });

  it('returns aborted and leaves nothing listening when aborted while binding', async () => {
    const controller = new AbortController();
    const pending = startLoopbackListener({
      expectedState: STATE,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
  });

  it('close() settles the result as aborted', async () => {
    const listener = await start();
    listener.close();
    expect(await listener.result).toEqual({ ok: false, error: { kind: 'aborted' } });
  });
});
