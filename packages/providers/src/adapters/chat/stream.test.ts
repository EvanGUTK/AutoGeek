import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../http/logger.ts';
import type { SseEvent } from '../../http/sse.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { createChatStream, errorKind } from './stream.ts';

const sse = (data: unknown): SseEvent => ({
  event: 'message',
  data: typeof data === 'string' ? data : JSON.stringify(data),
});
const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) => sse({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const DONE = sse('[DONE]');

function run(events: readonly SseEvent[], end = false): ModelEvent[] {
  const writer = createEventWriter();
  const stream = createChatStream({
    writer,
    providerId: 'openrouter',
    model: 'm',
    logger: NOOP_LOGGER,
    secrets: () => ['sk-or-v1-SECRETSECRET'],
  });
  const out = events.flatMap((event) => stream.handle(event));
  if (end) out.push(...stream.end());
  for (const event of out) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(out)).toEqual([]);
  return out;
}

describe('createChatStream', () => {
  it('reads reasoning from reasoning or reasoning_content, then text', () => {
    expect(
      run([chunk({ reasoning_content: 'hmm' }), chunk({ content: 'Hi' }), chunk({}, 'stop'), DONE]),
    ).toEqual([
      { type: 'reasoning_delta', text: 'hmm' },
      { type: 'reasoning_done', text: 'hmm' },
      { type: 'text_delta', text: 'Hi' },
      { type: 'text_done' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('merges streamed reasoning_details by index into replayable metadata', () => {
    const events = run([
      chunk({
        reasoning: 'A',
        reasoning_details: [
          { type: 'reasoning.text', text: 'A', index: 0, format: 'anthropic-claude-v1' },
        ],
      }),
      chunk({
        reasoning: 'B',
        reasoning_details: [{ type: 'reasoning.text', text: 'B', signature: 'sig', index: 0 }],
      }),
      chunk({ content: 'ok' }),
      chunk({}, 'stop'),
      DONE,
    ]);
    expect(events[2]).toEqual({
      type: 'reasoning_done',
      text: 'AB',
      providerMetadata: {
        origin: { providerId: 'openrouter', modelId: 'm' },
        data: {
          reasoningDetails: [
            {
              type: 'reasoning.text',
              text: 'AB',
              index: 0,
              format: 'anthropic-claude-v1',
              signature: 'sig',
            },
          ],
        },
      },
    });
  });

  it('assembles interleaved parallel calls by index and treats stop-with-calls as tool use', () => {
    const events = run([
      chunk({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'g', arguments: '{"b"' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ':2}' } }] }),
      chunk({}, 'stop'),
      DONE,
    ]);
    expect(events).toEqual([
      { type: 'tool_call', id: 'c1', name: 'f', input: {} },
      { type: 'tool_call', id: 'c2', name: 'g', input: { b: 2 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('accepts whole calls without an index (array position) and calls without ids', () => {
    const events = run([
      chunk(
        {
          tool_calls: [
            { function: { name: 'f', arguments: '{"a":1}' } },
            { function: { name: 'g', arguments: '' } },
          ],
        },
        'tool_calls',
      ),
      DONE,
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_call', id: 'call', name: 'f', input: { a: 1 } },
      { type: 'tool_call', id: 'call_1', name: 'g', input: {} },
    ]);
  });

  it('marks the last call truncated on length', () => {
    const events = run([
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":"b' } }] }),
      chunk({}, 'length'),
      DONE,
    ]);
    expect(events).toEqual([
      { type: 'tool_call_invalid', id: 'c', name: 'f', rawInput: '{"a":"b', reason: 'truncated' },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
  });

  it('takes usage from a choice-less chunk, subtracting cached prompt tokens only', () => {
    const events = run([
      chunk({ content: 'x' }, 'stop'),
      sse({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
      DONE,
    ]);
    expect(events.at(-2)).toEqual({
      type: 'usage',
      inputTokens: 70,
      outputTokens: 9,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      reasoningTokens: 4,
    });
  });

  it('keeps the first finish reason when OpenRouter repeats it on the usage chunk', () => {
    const events = run([
      chunk({ content: 'x' }, 'length'),
      chunk({ content: '' }, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      DONE,
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('maps refusal content and content_filter to refusal', () => {
    expect(run([chunk({ refusal: 'No.' }, 'stop'), DONE]).at(-1)).toEqual({
      type: 'done',
      stopReason: 'refusal',
    });
    expect(run([chunk({ content: 'x' }, 'content_filter'), DONE]).at(-1)).toEqual({
      type: 'done',
      stopReason: 'refusal',
    });
  });

  it('maps OpenRouter mid-stream errors with redacted detail', () => {
    const events = run([
      chunk({ content: 'par' }),
      sse({
        error: { code: 429, message: 'Rate limit sk-or-v1-SECRETSECRET' },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: expect.objectContaining({
        kind: 'rate_limit',
        detail: '429: Rate limit [REDACTED]',
      }) as unknown,
    });
  });

  it('completes on end without [DONE] when a finish reason was seen, else fails', () => {
    expect(run([chunk({ content: 'x' }, 'stop')], true).at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
    });
    expect(run([chunk({ content: 'x' })], true).at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'invalid_response' },
    });
  });

  it('fails on malformed JSON', () => {
    expect(run([sse('{"choices":')]).at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'invalid_response' },
    });
  });
});

describe('errorKind', () => {
  it.each([
    [429, undefined, 'rate_limit'],
    [402, undefined, 'quota'],
    [401, undefined, 'auth'],
    [503, undefined, 'server'],
    [400, 'context_length_exceeded', 'context_length'],
    [400, 'exceed_context_size_error', 'context_length'],
    [502, 'provider_overloaded', 'overloaded'],
    ['server_error', undefined, 'server'],
    ['weird', undefined, 'unknown'],
  ] as const)('maps code %s / type %s to %s', (code, type, kind) => {
    expect(errorKind(code, type)).toBe(kind);
  });
});
