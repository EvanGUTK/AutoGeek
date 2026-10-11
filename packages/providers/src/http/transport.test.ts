import type { ProviderError, Result } from '@autogeek/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer } from '../testing/http-server.ts';
import type { FakeHandler, FakeServer } from '../testing/http-server.ts';
import type { LogFields, Logger } from './logger.ts';
import { DEFAULT_RETRY_POLICY } from './retry.ts';
import { openStream } from './transport.ts';
import type { BodyRead, HttpRequest, StreamingResponse, TransportDeps } from './transport.ts';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRET';
const USER_CODE = 'function proprietary() { return 42; }';

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(handler: FakeHandler): Promise<FakeServer> {
  server = await startFakeServer(handler);
  return server;
}

function harness() {
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, fields }),
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
  };
  const deps: TransportDeps = {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger,
  };
  return { deps, logs, sleeps };
}

function request(origin: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    providerId: 'anthropic',
    url: `${origin}/v1/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': SECRET },
    body: JSON.stringify({ code: USER_CODE }),
    signal: new AbortController().signal,
    timeouts: { firstByteMs: 2000, idleMs: 2000 },
    secrets: () => [SECRET],
    ...overrides,
  };
}

async function readAll(response: StreamingResponse): Promise<{ text: string; last: BodyRead }> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const next = await response.read();
    if (next.type !== 'chunk') return { text, last: next };
    text += decoder.decode(next.bytes, { stream: true });
  }
}

function expectOk<T>(result: Result<T, ProviderError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr(result: Result<unknown, ProviderError>): ProviderError {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

function assertLogsClean(logs: readonly LogEntry[]): void {
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain('proprietary');
  expect(logs.some((entry) => entry.level === 'info')).toBe(false);
}

describe('openStream', () => {
  it('POSTs the body and headers and streams the 2xx body back', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
      res.write('data: a\n\n');
      setTimeout(() => res.end('data: b\n\n'), 10);
    });
    const { deps, logs } = harness();
    const response = expectOk(await openStream(request(fake.origin), deps));
    expect(response.status).toBe(200);
    expect(response.requestId).toBe('req_1');
    expect(await readAll(response)).toEqual({
      text: 'data: a\n\ndata: b\n\n',
      last: { type: 'end' },
    });
    const [recorded] = fake.requests;
    expect(recorded?.method).toBe('POST');
    expect(recorded?.path).toBe('/v1/messages');
    expect(recorded?.headers['x-api-key']).toBe(SECRET);
    expect(recorded?.body).toBe(JSON.stringify({ code: USER_CODE }));
    assertLogsClean(logs);
  });

  it('maps 401 to auth with a redacted detail and the request id', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(401, { 'request-id': 'req_401', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `invalid x-api-key ${SECRET}` } }));
    });
    const { deps, logs } = harness();
    const error = expectErr(await openStream(request(fake.origin), deps));
    expect(error).toMatchObject({
      kind: 'auth',
      status: 401,
      requestId: 'req_401',
      retryable: false,
    });
    expect(error.detail).toContain('invalid x-api-key');
    expect(error.detail).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(1);
    assertLogsClean(logs);
  });

  it('lets the adapter refine the kind from the error body', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(400);
      res.end('{"error":{"type":"invalid_request_error","message":"prompt is too long"}}');
    });
    const { deps } = harness();
    const error = expectErr(
      await openStream(
        request(fake.origin, {
          classify: (status, body) =>
            status === 400 && body.includes('prompt is too long') ? 'context_length' : undefined,
        }),
        deps,
      ),
    );
    expect(error.kind).toBe('context_length');
  });

  it('retries 429 after the Retry-After hint and returns the later success', async () => {
    let calls = 0;
    const fake = await serve((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '1' });
        res.end('slow down');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    const { deps, sleeps } = harness();
    const response = expectOk(await openStream(request(fake.origin), deps));
    expect(await readAll(response)).toEqual({ text: 'ok', last: { type: 'end' } });
    expect(sleeps).toEqual([1000]);
    expect(fake.requests).toHaveLength(2);
  });

  it('gives up after the attempt budget and keeps the last retry hint', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(529, { 'retry-after': '2' });
      res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    });
    const { deps, sleeps } = harness();
    const error = expectErr(await openStream(request(fake.origin), deps));
    expect(error).toMatchObject({ kind: 'overloaded', status: 529, retryAfterMs: 2000 });
    expect(fake.requests).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('does not retry when the server says x-should-retry: false', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(500, { 'x-should-retry': 'false' });
      res.end();
    });
    const { deps } = harness();
    expect(expectErr(await openStream(request(fake.origin), deps)).kind).toBe('server');
    expect(fake.requests).toHaveLength(1);
  });

  it('never follows a redirect and never reads its body', async () => {
    const fake = await serve((req, res) => {
      if (req.path === '/v1/messages') {
        res.writeHead(307, { location: '/elsewhere' });
        res.end(`redirect body ${SECRET}`);
        return;
      }
      res.writeHead(200);
      res.end('followed');
    });
    const { deps, logs } = harness();
    const error = expectErr(await openStream(request(fake.origin), deps));
    expect(error).toMatchObject({ kind: 'invalid_response', status: 307 });
    expect(error.detail).toBeUndefined();
    expect(fake.requests.map((r) => r.path)).toEqual(['/v1/messages']);
    assertLogsClean(logs);
  });

  it('times out waiting for headers and releases the socket', async () => {
    const fake = await serve(() => {
      // Never responds.
    });
    const { deps } = harness();
    const error = expectErr(
      await openStream(
        request(fake.origin, {
          timeouts: { firstByteMs: 50, idleMs: 2000 },
          retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
        }),
        deps,
      ),
    );
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    await fake.waitForNoSockets();
  });

  it('times out when the body stalls and releases the socket', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const { deps } = harness();
    const response = expectOk(
      await openStream(request(fake.origin, { timeouts: { firstByteMs: 2000, idleMs: 50 } }), deps),
    );
    const { text, last } = await readAll(response);
    expect(text).toBe('data: first\n\n');
    expect(last).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
    await fake.waitForNoSockets();
  });

  it('returns aborted without any I/O when the signal is already aborted', async () => {
    const fake = await serve((_req, res) => {
      res.end();
    });
    const controller = new AbortController();
    controller.abort();
    const { deps } = harness();
    const error = expectErr(
      await openStream(request(fake.origin, { signal: controller.signal }), deps),
    );
    expect(error).toMatchObject({ kind: 'aborted', retryable: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('aborts while waiting for headers and releases the socket', async () => {
    const controller = new AbortController();
    const fake = await serve(() => {
      setTimeout(() => {
        controller.abort();
      }, 20);
    });
    const { deps } = harness();
    const error = expectErr(
      await openStream(request(fake.origin, { signal: controller.signal }), deps),
    );
    expect(error.kind).toBe('aborted');
    await fake.waitForNoSockets();
  });

  it('aborts mid-body: the next read reports aborted and the socket closes', async () => {
    const controller = new AbortController();
    const fake = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const { deps } = harness();
    const response = expectOk(
      await openStream(request(fake.origin, { signal: controller.signal }), deps),
    );
    expect((await response.read()).type).toBe('chunk');
    controller.abort();
    expect(await response.read()).toMatchObject({ type: 'error', error: { kind: 'aborted' } });
    await fake.waitForNoSockets();
  });

  it('reports a mid-stream disconnect as a network error', async () => {
    const fake = await serve((_req, res, socket) => {
      res.writeHead(200);
      res.write('data: first\n\n');
      setTimeout(() => socket.destroy(), 20);
    });
    const { deps } = harness();
    const response = expectOk(await openStream(request(fake.origin), deps));
    const { last } = await readAll(response);
    expect(last).toMatchObject({ type: 'error', error: { kind: 'network', retryable: true } });
    await fake.waitForNoSockets();
  });

  it('close() releases an unfinished body and is idempotent', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const { deps } = harness();
    const response = expectOk(await openStream(request(fake.origin), deps));
    await response.close();
    await response.close();
    expect(await response.read()).toEqual({ type: 'end' });
    await fake.waitForNoSockets();
  });

  it('maps a refused connection to network after retrying', async () => {
    const fake = await serve((_req, res) => {
      res.end();
    });
    const { origin } = fake;
    await fake.close();
    server = undefined;
    const { deps, sleeps } = harness();
    const error = expectErr(await openStream(request(origin), deps));
    expect(error).toMatchObject({ kind: 'network', retryable: true });
    expect(sleeps).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts - 1);
  });

  it('stops retrying when aborted during the backoff sleep', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const controller = new AbortController();
    const { deps } = harness();
    const error = expectErr(
      await openStream(request(fake.origin, { signal: controller.signal }), {
        ...deps,
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    );
    expect(error.kind).toBe('aborted');
    expect(fake.requests).toHaveLength(1);
  });

  it('caps a huge error body and still releases the connection', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(400);
      const block = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(block);
      res.end();
    });
    const { deps } = harness();
    const error = expectErr(await openStream(request(fake.origin), deps));
    expect(error.kind).toBe('invalid_request');
    expect(new TextEncoder().encode(error.detail ?? '').length).toBeLessThanOrEqual(2048);
    await fake.waitForNoSockets();
  });

  it('logs only metadata, never at info level, with the URL query stripped', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(500);
      res.end(`boom ${USER_CODE} ${SECRET}`);
    });
    const { deps, logs } = harness();
    await openStream(
      request(fake.origin, {
        url: `${fake.origin}/v1/messages?key=${SECRET}`,
        retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      }),
      deps,
    );
    expect(logs.map((entry) => entry.fields?.['target'])).toEqual([`${fake.origin}/v1/messages`]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(logs.every((entry) => entry.level === 'debug')).toBe(true);
  });
});
