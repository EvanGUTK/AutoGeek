import { checkModelEventOrder, providerError } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../http/logger.ts';
import { guardStream } from './guard.ts';

/** Yields to the event loop, as a real network source does between chunks. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function recordingLogger() {
  const warnings: { message: string; fields: LogFields | undefined }[] = [];
  const logger: Logger = {
    debug() {
      // Not recorded.
    },
    info() {
      // Not recorded.
    },
    warn(message, fields) {
      warnings.push({ message, fields });
    },
  };
  return { logger, warnings };
}

async function collect(source: AsyncIterable<ModelEvent>, logger: Logger): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of guardStream(source, { providerId: 'openai', logger }))
    events.push(event);
  expect(checkModelEventOrder(events)).toEqual([]);
  return events;
}

describe('guardStream', () => {
  it('passes a well-formed stream through', async () => {
    async function* source(): AsyncGenerator<ModelEvent> {
      await tick();
      yield { type: 'text_delta', text: 'a' };
      yield { type: 'text_done' };
      yield { type: 'done', stopReason: 'end_turn' };
    }
    const { logger } = recordingLogger();
    expect(await collect(source(), logger)).toHaveLength(3);
  });

  it('turns a stream that ends without a terminal into invalid_response', async () => {
    async function* source(): AsyncGenerator<ModelEvent> {
      await tick();
      yield { type: 'text_delta', text: 'a' };
    }
    const { logger } = recordingLogger();
    const events = await collect(source(), logger);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: providerError('invalid_response', 'openai'),
    });
  });

  it('turns a thrown programmer error into a terminal unknown error and logs its name only', async () => {
    async function* source(): AsyncGenerator<ModelEvent> {
      await tick();
      yield { type: 'text_delta', text: 'a' };
      throw new RangeError('secret prompt text');
    }
    const { logger, warnings } = recordingLogger();
    const events = await collect(source(), logger);
    expect(events.at(-1)).toEqual({ type: 'error', error: providerError('unknown', 'openai') });
    expect(warnings).toEqual([
      { message: 'provider stream threw', fields: { providerId: 'openai', error: 'RangeError' } },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('secret prompt text');
  });

  it('stops at the terminal event and closes the source', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<ModelEvent> {
      await tick();
      try {
        yield { type: 'done', stopReason: 'end_turn' };
        yield { type: 'text_delta', text: 'late' };
      } finally {
        closed = true;
      }
    }
    const { logger } = recordingLogger();
    expect(await collect(source(), logger)).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
    expect(closed).toBe(true);
  });

  it('closes the source when the consumer stops early', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<ModelEvent> {
      await tick();
      try {
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'text_delta', text: 'b' };
      } finally {
        closed = true;
      }
    }
    const { logger } = recordingLogger();
    for await (const event of guardStream(source(), { providerId: 'openai', logger })) {
      expect(event.type).toBe('text_delta');
      break;
    }
    expect(closed).toBe(true);
  });
});
