import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

export const CALLBACK_PATH = '/callback';

/** Bound IPv4 loopback only (RFC 8252 §7.3, §8.3): never `localhost`, never all interfaces. */
const LOOPBACK_HOST = '127.0.0.1';
const MAX_CODE_LENGTH = 4096;
/** RFC 6749 error codes are short ASCII tokens; anything else is not echoed. */
const OAUTH_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/;

export type CallbackFailure =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'provider_error'; readonly oauthError: string };

export interface LoopbackListener {
  /** `http://127.0.0.1:<port>/callback`, for the authorization request's `redirect_uri`. */
  readonly redirectUri: string;
  /** Settles exactly once: the first valid callback, a timeout, an abort, or `close()`. */
  readonly result: Promise<Result<{ readonly code: string }, CallbackFailure>>;
  /** Resolves once the server has stopped accepting connections. */
  readonly closed: Promise<void>;
  /** Stops listening; an unsettled result settles as `aborted`. Idempotent. */
  close(): void;
}

export interface LoopbackOptions {
  readonly expectedState: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
} as const;

/** Constant pages: nothing from the request is ever reflected. */
const PAGES = {
  done: '<!doctype html><title>AutoGeek</title><p>Sign-in finished. You can close this tab and return to AutoGeek.</p>',
  failed:
    '<!doctype html><title>AutoGeek</title><p>Sign-in did not complete. Return to AutoGeek to try again.</p>',
  rejected: '<!doctype html><title>AutoGeek</title><p>This request was not accepted.</p>',
} as const;

function respond(
  res: ServerResponse,
  status: number,
  page: keyof typeof PAGES,
  then?: () => void,
): void {
  res.writeHead(status, PAGE_HEADERS);
  if (then === undefined) res.end(PAGES[page]);
  else res.end(PAGES[page], then);
}

function statesMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The single value of `name`, or null when it is absent or repeated (parameter pollution). */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

type Outcome =
  | { readonly type: 'reject'; readonly status: 400 | 404 | 405 }
  | { readonly type: 'code'; readonly code: string }
  | { readonly type: 'provider_error'; readonly oauthError: string };

function classify(req: IncomingMessage, boundHost: string, expectedState: string): Outcome {
  if (req.headers.host !== boundHost) return { type: 'reject', status: 400 };
  const url = new URL(req.url ?? '/', `http://${boundHost}`);
  if (url.pathname !== CALLBACK_PATH) return { type: 'reject', status: 404 };
  if (req.method !== 'GET') return { type: 'reject', status: 405 };
  const state = single(url.searchParams, 'state');
  if (state === null || !statesMatch(state, expectedState)) return { type: 'reject', status: 400 };
  const oauthError = single(url.searchParams, 'error');
  if (oauthError !== null) {
    return {
      type: 'provider_error',
      oauthError: OAUTH_ERROR_PATTERN.test(oauthError) ? oauthError : 'unknown',
    };
  }
  const code = single(url.searchParams, 'code');
  if (code === null || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return { type: 'reject', status: 400 };
  }
  return { type: 'code', code };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  if (resolve === undefined) throw new Error('Promise executor did not run synchronously');
  return { promise, resolve };
}

function listen(server: Server): Promise<Result<number, 'listen_failed'>> {
  return new Promise((resolve) => {
    const onError = (): void => {
      resolve(err('listen_failed'));
    };
    server.once('error', onError);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off('error', onError);
      const address = server.address();
      // A TCP listen always reports an AddressInfo; a string means a pipe, null means not bound.
      resolve(
        address === null || typeof address === 'string' ? err('listen_failed') : ok(address.port),
      );
    });
  });
}

/**
 * Starts a one-shot OAuth redirect listener on 127.0.0.1 at an ephemeral port.
 *
 * Only a GET to `/callback` whose `Host` is exactly the bound address and whose single `state`
 * matches (constant-time) can settle the flow. Anything else gets an error page and the listener
 * keeps waiting, so a local process or web page cannot end the user's sign-in by probing the port.
 * The first valid callback, the timeout, the abort signal or `close()` settles the result, and the
 * server then stops listening.
 */
export async function startLoopbackListener(
  options: LoopbackOptions,
): Promise<Result<LoopbackListener, 'listen_failed' | 'aborted'>> {
  const { expectedState, timeoutMs, signal } = options;
  if (signal.aborted) return err('aborted');

  const result = deferred<Result<{ readonly code: string }, CallbackFailure>>();
  const closed = deferred<undefined>();
  // Mutable flow state lives in one object: closures update it while `listen` is awaited.
  const flow: {
    boundHost: string;
    settled: boolean;
    shuttingDown: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  } = { boundHost: '', settled: false, shuttingDown: false, timer: undefined };

  // `finish` settles only once, so a request racing the shutdown cannot change the result.
  const server = createServer((req, res) => {
    const outcome = classify(req, flow.boundHost, expectedState);
    switch (outcome.type) {
      case 'reject':
        respond(res, outcome.status, 'rejected');
        return;
      case 'code':
        finish(ok({ code: outcome.code }));
        respond(res, 200, 'done', shutdown);
        return;
      case 'provider_error':
        finish(err({ kind: 'provider_error', oauthError: outcome.oauthError }));
        respond(res, 200, 'failed', shutdown);
        return;
    }
  });

  function shutdown(): void {
    if (flow.shuttingDown || !server.listening) return;
    flow.shuttingDown = true;
    server.close(() => {
      closed.resolve(undefined);
    });
    server.closeAllConnections();
  }

  function finish(outcome: Result<{ readonly code: string }, CallbackFailure>): void {
    if (flow.settled) return;
    flow.settled = true;
    clearTimeout(flow.timer);
    signal.removeEventListener('abort', onAbort);
    result.resolve(outcome);
  }

  function onAbort(): void {
    finish(err({ kind: 'aborted' }));
    shutdown();
  }

  // Registered before listening so an abort that lands while `listen` is pending is not lost.
  signal.addEventListener('abort', onAbort, { once: true });
  const listening = await listen(server);
  if (!listening.ok) {
    finish(err({ kind: 'aborted' }));
    return listening;
  }
  if (flow.settled) {
    shutdown();
    return err('aborted');
  }
  flow.boundHost = `${LOOPBACK_HOST}:${String(listening.value)}`;
  flow.timer = setTimeout(() => {
    finish(err({ kind: 'timeout' }));
    shutdown();
  }, timeoutMs);

  return ok({
    redirectUri: `http://${flow.boundHost}${CALLBACK_PATH}`,
    result: result.promise,
    closed: closed.promise.then(() => undefined),
    close: onAbort,
  });
}
