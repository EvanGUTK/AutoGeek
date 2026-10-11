import { providerError } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { createSseDecoder } from '../http/sse.ts';
import type { SseEvent } from '../http/sse.ts';
import { openStream } from '../http/transport.ts';
import type { HttpRequest, TransportDeps } from '../http/transport.ts';
import type { EventWriter } from '../stream/writer.ts';

/** Generous DoS bounds: one line or event this large is not a real vendor stream. */
export const SSE_LIMITS = { maxLineLength: 16 * 1024 * 1024, maxEventLength: 16 * 1024 * 1024 };

export interface SseStreamHandler {
  handle(event: SseEvent): ModelEvent[];
  /** The body ended; returns the terminal events if the vendor never sent its own. */
  end(): ModelEvent[];
}

/**
 * Opens an SSE response and feeds its events to a vendor handler until a terminal event. The
 * connection is released in `finally`, which also runs when the consumer stops iterating early.
 * Every failure becomes the writer's terminal `error` (usage first, when the vendor reported it).
 */
export async function* runSseStream(
  http: HttpRequest,
  deps: TransportDeps,
  writer: EventWriter,
  handler: SseStreamHandler,
): AsyncGenerator<ModelEvent, void, undefined> {
  const opened = await openStream(http, deps);
  if (!opened.ok) {
    yield* writer.fail(opened.error);
    return;
  }
  const response = opened.value;
  const decoder = createSseDecoder(SSE_LIMITS);
  // A function call, so narrowing from the loop condition does not hide the change that
  // handler.handle() makes to the writer.
  const finished = (): boolean => writer.finished;
  try {
    while (!finished()) {
      const next = await response.read();
      if (next.type === 'error') {
        yield* writer.fail(next.error);
        return;
      }
      if (next.type === 'end') {
        decoder.end();
        yield* handler.end();
        return;
      }
      const decoded = decoder.push(next.bytes);
      if (!decoded.ok) {
        yield* writer.fail(providerError('invalid_response', http.providerId));
        return;
      }
      for (const event of decoded.value) {
        // Events already read must not outrun a cancellation the caller has asked for.
        if (http.signal.aborted) {
          yield* writer.fail(providerError('aborted', http.providerId));
          return;
        }
        yield* handler.handle(event);
        if (finished()) return;
      }
    }
  } finally {
    await response.close();
  }
}
