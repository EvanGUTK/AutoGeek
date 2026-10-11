import { err, ok } from '@autogeek/core';
import type { Result } from '@autogeek/core';
import { createLineDecoder } from './lines.ts';

/** One dispatched server-sent event. `id` and `retry` are ignored: we never reconnect. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export interface SseDecoderError {
  readonly kind: 'line_too_long' | 'event_too_large';
}

export interface SseDecoderOptions {
  /** Maximum line length in UTF-16 code units. */
  readonly maxLineLength: number;
  /** Maximum `data` length of one event in UTF-16 code units, joined lines included. */
  readonly maxEventLength: number;
}

export interface SseEnd {
  /** True when the stream ended inside an event, which per the spec is discarded. */
  readonly incompleteEvent: boolean;
}

export interface SseDecoder {
  /**
   * Decodes a chunk and returns the events it completed. On error the whole chunk's events are
   * discarded and the decoder stays failed: the caller ends the stream as `invalid_response`.
   */
  push(chunk: Uint8Array): Result<SseEvent[], SseDecoderError>;
  end(): SseEnd;
}

/**
 * Server-sent events per the WHATWG HTML "event stream interpretation" rules
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation),
 * minus reconnection. Unknown fields and comments are ignored so vendor additions never break
 * the stream.
 */
export function createSseDecoder(options: SseDecoderOptions): SseDecoder {
  const lines = createLineDecoder({ maxLineLength: options.maxLineLength });
  let eventType = '';
  let data = '';
  let hasData = false;
  let failed: SseDecoderError | undefined;

  function processLine(line: string, events: SseEvent[]): SseDecoderError | undefined {
    if (line === '') {
      if (hasData) events.push({ event: eventType === '' ? 'message' : eventType, data });
      eventType = '';
      data = '';
      hasData = false;
      return undefined;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      eventType = value;
    } else if (field === 'data') {
      data = hasData ? `${data}\n${value}` : value;
      hasData = true;
      if (data.length > options.maxEventLength) return { kind: 'event_too_large' };
    }
    return undefined;
  }

  return {
    push(chunk) {
      if (failed !== undefined) return err(failed);
      const decoded = lines.push(chunk);
      if (!decoded.ok) {
        failed = decoded.error;
        return err(failed);
      }
      const events: SseEvent[] = [];
      for (const line of decoded.value) {
        const error = processLine(line, events);
        if (error !== undefined) {
          failed = error;
          data = '';
          return err(failed);
        }
      }
      return ok(events);
    },
    end() {
      if (failed !== undefined) return { incompleteEvent: false };
      const pending = lines.end();
      const incompleteEvent =
        hasData || pending.some((line) => line !== '' && !line.startsWith(':'));
      eventType = '';
      data = '';
      hasData = false;
      return { incompleteEvent };
    },
  };
}
