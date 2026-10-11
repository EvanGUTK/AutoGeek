import { err, ok, providerError } from '@autogeek/core';
import type { ProviderError, ProviderErrorKind, Result } from '@autogeek/core';
import { kindForStatus, readRequestId, readShouldRetry } from './errors.ts';
import type { Logger } from './logger.ts';
import { toDetail } from './redact.ts';
import { DEFAULT_RETRY_POLICY, decideRetry } from './retry.ts';
import type { RetryPolicy } from './retry.ts';
import { parseRetryAfter } from './retry-after.ts';

export interface TransportDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  /** Resolves after `ms`, or early once `signal` aborts. Never rejects. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly logger: Logger;
}

export interface TransportTimeouts {
  /** From sending the request until response headers arrive. */
  readonly firstByteMs: number;
  /** Longest gap between two body chunks. */
  readonly idleMs: number;
}

export const DEFAULT_TIMEOUTS: TransportTimeouts = { firstByteMs: 120_000, idleMs: 120_000 };

/** Error bodies beyond this are cut off; the excerpt only feeds the 2 KiB `detail`. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface HttpRequest {
  readonly providerId: string;
  readonly url: string;
  /** Built by the adapter, revealing the credential inline. Never logged. */
  readonly headers: Readonly<Record<string, string>>;
  /** JSON request body. Contains user code: never logged. */
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeouts?: TransportTimeouts;
  readonly retry?: RetryPolicy;
  /** Exact secret values to redact from error excerpts; called only when redacting. */
  readonly secrets?: () => readonly string[];
  /** Refines the status mapping from the vendor error body (context length, quota, ...). */
  readonly classify?: (status: number, body: string) => ProviderErrorKind | undefined;
}

export type BodyRead =
  | { readonly type: 'chunk'; readonly bytes: Uint8Array }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly error: ProviderError };

export interface StreamingResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly requestId?: string;
  /** Next body chunk. Never rejects. After `end` or `error` the connection is released. */
  read(): Promise<BodyRead>;
  /** Releases the connection without reading the rest. Idempotent; never rejects. */
  close(): Promise<void>;
}

// Abort reason marking our own deadline, so a timeout is never mistaken for a caller abort.
const TIMEOUT = Symbol('transport-timeout');

/**
 * POSTs `request` and returns the open 2xx response, retrying failures that happen before a
 * response is accepted (see `decideRetry`). Redirects are never followed: undici strips
 * `Authorization` on a cross-origin redirect but not `x-api-key` / `x-goog-api-key`, so any 3xx
 * is `invalid_response` and its body is discarded unread.
 */
export async function openStream(
  request: HttpRequest,
  deps: TransportDeps,
): Promise<Result<StreamingResponse, ProviderError>> {
  const policy = request.retry ?? DEFAULT_RETRY_POLICY;
  const target = describeUrl(request.url);
  for (let attempt = 1; ; attempt += 1) {
    const started = deps.now();
    const outcome = await attemptOnce(request, deps);
    const fields = {
      providerId: request.providerId,
      target,
      attempt,
      elapsedMs: deps.now() - started,
    };
    if (outcome.ok) {
      deps.logger.debug('provider request accepted', {
        ...fields,
        status: outcome.value.status,
        requestId: outcome.value.requestId,
      });
      return outcome;
    }
    const { error, shouldRetry } = outcome.error;
    const decision = decideRetry({
      error,
      attempt,
      outputStarted: false,
      ...(shouldRetry === undefined ? {} : { shouldRetry }),
      policy,
      random: deps.random,
    });
    deps.logger.debug('provider request failed', {
      ...fields,
      kind: error.kind,
      status: error.status,
      requestId: error.requestId,
      retryInMs: decision.retry ? decision.delayMs : undefined,
      detail: error.detail,
    });
    if (!decision.retry) return err(error);
    await deps.sleep(decision.delayMs, request.signal);
    if (request.signal.aborted) return err(providerError('aborted', request.providerId));
  }
}

interface AttemptFailure {
  readonly error: ProviderError;
  readonly shouldRetry?: boolean;
}

async function attemptOnce(
  request: HttpRequest,
  deps: TransportDeps,
): Promise<Result<StreamingResponse, AttemptFailure>> {
  const { providerId } = request;
  if (request.signal.aborted) return err({ error: providerError('aborted', providerId) });
  const timeouts = request.timeouts ?? DEFAULT_TIMEOUTS;
  const deadline = new AbortController();
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let timer = setTimeout(() => {
    deadline.abort(TIMEOUT);
  }, timeouts.firstByteMs);
  const failure = (cause: unknown): AttemptFailure => ({
    error: providerError(classifyThrown(cause, request.signal, deadline.signal), providerId),
  });

  let response: Response;
  try {
    response = await deps.fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'manual',
    });
  } catch (cause) {
    clearTimeout(timer);
    return err(failure(cause));
  }
  clearTimeout(timer);

  const requestId = readRequestId(response.headers);
  const extras = { status: response.status, ...(requestId === undefined ? {} : { requestId }) };

  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response.body, deps.logger);
    return err({ error: providerError('invalid_response', providerId, extras) });
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    await cancelReader(reader, deps.logger);
  };
  const readChunk = async (): Promise<BodyRead> => {
    if (released || reader === undefined) {
      released = true;
      return { type: 'end' };
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      deadline.abort(TIMEOUT);
    }, timeouts.idleMs);
    try {
      const next = await reader.read();
      clearTimeout(timer);
      if (next.done) {
        released = true;
        return { type: 'end' };
      }
      return { type: 'chunk', bytes: next.value };
    } catch (cause) {
      await release();
      return { type: 'error', error: failure(cause).error };
    }
  };

  if (response.status < 200 || response.status >= 300) {
    const body = await readErrorBody(readChunk);
    await release();
    if (body.type === 'error') return err({ error: body.error });
    const kind = request.classify?.(response.status, body.text) ?? kindForStatus(response.status);
    const retryAfterMs = parseRetryAfter(response.headers, deps.now());
    const detail = body.text === '' ? undefined : toDetail(body.text, request.secrets?.() ?? []);
    const shouldRetry = readShouldRetry(response.headers);
    return err({
      error: providerError(kind, providerId, {
        ...extras,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(detail === undefined ? {} : { detail }),
      }),
      ...(shouldRetry === undefined ? {} : { shouldRetry }),
    });
  }

  return ok({
    status: response.status,
    headers: response.headers,
    ...(requestId === undefined ? {} : { requestId }),
    read: readChunk,
    close: release,
  });
}

type ErrorBody =
  { readonly type: 'text'; readonly text: string } | Extract<BodyRead, { type: 'error' }>;

async function readErrorBody(read: () => Promise<BodyRead>): Promise<ErrorBody> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_ERROR_BODY_BYTES) {
    const next = await read();
    if (next.type === 'error') return next;
    if (next.type === 'end') break;
    chunks.push(next.bytes);
    size += next.bytes.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { type: 'text', text: new TextDecoder().decode(bytes.subarray(0, MAX_ERROR_BODY_BYTES)) };
}

function classifyThrown(
  cause: unknown,
  callerSignal: AbortSignal,
  deadline: AbortSignal,
): ProviderErrorKind {
  if (callerSignal.aborted) return 'aborted';
  if (deadline.aborted && deadline.reason === TIMEOUT) return 'timeout';
  // fetch reports DNS, TCP, TLS and mid-body socket failures as TypeError.
  if (cause instanceof TypeError) return 'network';
  return 'unknown';
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, logger: Logger): Promise<void> {
  if (body === null) return;
  await body.cancel().catch((cause: unknown) => {
    logCancelFailure(cause, logger);
  });
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  logger: Logger,
): Promise<void> {
  if (reader === undefined) return;
  await reader.cancel().catch((cause: unknown) => {
    logCancelFailure(cause, logger);
  });
}

/**
 * Cancelling a body whose connection already failed rejects with that same failure, which was
 * already reported to the caller; the connection is released either way. Logged, not rethrown.
 */
function logCancelFailure(cause: unknown, logger: Logger): void {
  logger.debug('provider body cancel failed', {
    error: cause instanceof Error ? cause.name : typeof cause,
  });
}

/** Origin and path only: never the query string, which some vendors accept keys in. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (cause) {
    if (cause instanceof TypeError) return '<invalid url>';
    throw cause;
  }
}
