import { providerError } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import type { Logger } from '../http/logger.ts';

export interface GuardContext {
  readonly providerId: string;
  readonly logger: Logger;
}

/**
 * The outermost layer of every adapter's `stream()`, which must never throw: a source that
 * throws (a bug) ends with an `unknown` error, one that ends without a terminal event ends with
 * `invalid_response`, and iteration stops at the first terminal event. Leaving the loop early
 * (terminal, consumer `break`, throw) closes the source, whose `finally` releases the connection.
 */
export async function* guardStream(
  source: AsyncIterable<ModelEvent>,
  context: GuardContext,
): AsyncGenerator<ModelEvent, void, undefined> {
  try {
    for await (const event of source) {
      yield event;
      if (event.type === 'done' || event.type === 'error') return;
    }
  } catch (error) {
    // Only the error's class is logged: its message may quote request content.
    context.logger.warn('provider stream threw', {
      providerId: context.providerId,
      error: error instanceof Error ? error.name : typeof error,
    });
    yield { type: 'error', error: providerError('unknown', context.providerId) };
    return;
  }
  yield { type: 'error', error: providerError('invalid_response', context.providerId) };
}
