import { providerError } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { createNdjsonDecoder } from '../http/ndjson.ts';
import { openStream } from '../http/transport.ts';
import type { HttpRequest, TransportDeps } from '../http/transport.ts';
import type { EventWriter } from '../stream/writer.ts';
import { SSE_LIMITS } from './sse-driver.ts';

export interface NdjsonStreamHandler {
  /** One parsed line; unvalidated, the handler parses it with zod. */
  handle(value: unknown): ModelEvent[];
  /** The body ended; returns the terminal events if the vendor never sent its own. */
  end(): ModelEvent[];
}

/**
 * NDJSON counterpart of `runSseStream` (Ollama's native stream): same connection release in
 * `finally`, same abort check between values that arrived in one chunk.
 */
export async function* runNdjsonStream(
  http: HttpRequest,
  deps: TransportDeps,
  writer: EventWriter,
  handler: NdjsonStreamHandler,
): AsyncGenerator<ModelEvent, void, undefined> {
  const opened = await openStream(http, deps);
  if (!opened.ok) {
    yield* writer.fail(opened.error);
    return;
  }
  const response = opened.value;
  const decoder = createNdjsonDecoder({ maxLineLength: SSE_LIMITS.maxLineLength });
  const finished = (): boolean => writer.finished;
  try {
    while (!finished()) {
      const next = await response.read();
      if (next.type === 'error') {
        yield* writer.fail(next.error);
        return;
      }
      const decoded = next.type === 'end' ? decoder.end() : decoder.push(next.bytes);
      if (!decoded.ok) {
        yield* writer.fail(providerError('invalid_response', http.providerId));
        return;
      }
      for (const value of decoded.value) {
        if (http.signal.aborted) {
          yield* writer.fail(providerError('aborted', http.providerId));
          return;
        }
        yield* handler.handle(value);
        if (finished()) return;
      }
      if (next.type === 'end') {
        yield* handler.end();
        return;
      }
    }
  } finally {
    await response.close();
  }
}
