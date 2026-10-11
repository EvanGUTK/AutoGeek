import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../http/logger.ts';
import type { LogFields, Logger } from '../../http/logger.ts';
import type { SseEvent } from '../../http/sse.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { createAnthropicStream } from './stream.ts';

const MODEL = 'claude-opus-5-5';
const ORIGIN = { providerId: 'anthropic', modelId: MODEL };

function sse(data: Record<string, unknown>): SseEvent {
  const type = typeof data['type'] === 'string' ? data['type'] : 'message';
  return { event: type, data: JSON.stringify(data) };
}

const start = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 1 }) =>
  sse({ type: 'message_start', message: { id: 'msg_1', model: MODEL, content: [], usage } });
const blockStart = (index: number, block: Record<string, unknown>) =>
  sse({ type: 'content_block_start', index, content_block: block });
const delta = (index: number, value: Record<string, unknown>) =>
  sse({ type: 'content_block_delta', index, delta: value });
const blockStop = (index: number) => sse({ type: 'content_block_stop', index });
const messageDelta = (stopReason: string, usage: Record<string, unknown> = { output_tokens: 20 }) =>
  sse({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage });
const stop = sse({ type: 'message_stop' });

function run(events: readonly SseEvent[], options: { end?: boolean; logger?: Logger } = {}) {
  const writer = createEventWriter();
  const stream = createAnthropicStream({
    writer,
    model: MODEL,
    logger: options.logger ?? NOOP_LOGGER,
    secrets: () => ['sk-ant-secret-value'],
  });
  const out: ModelEvent[] = events.flatMap((event) => stream.handle(event));
  if (options.end === true) out.push(...stream.end());
  for (const event of out) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(out)).toEqual([]);
  return out;
}

describe('createAnthropicStream: text', () => {
  it('streams text and ends with usage and done', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      sse({ type: 'ping' }),
      delta(0, { type: 'text_delta', text: 'Hel' }),
      delta(0, { type: 'text_delta', text: 'lo' }),
      blockStop(0),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'text_done' },
      { type: 'usage', inputTokens: 10, outputTokens: 20 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('treats stop_sequence as end_turn', () => {
    const events = run([start(), messageDelta('stop_sequence'), stop]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('maps refusal', () => {
    const events = run([start(), messageDelta('refusal'), stop]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it('maps model_context_window_exceeded to max_tokens', () => {
    const events = run([start(), messageDelta('model_context_window_exceeded'), stop]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('ends an unknown stop reason as end_turn and warns', () => {
    const warnings: (LogFields | undefined)[] = [];
    const logger: Logger = { ...NOOP_LOGGER, warn: (_m, fields) => warnings.push(fields) };
    const events = run([start(), messageDelta('something_new'), stop], { logger });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    expect(warnings).toEqual([{ providerId: 'anthropic', stopReason: 'something_new' }]);
  });
});

describe('createAnthropicStream: thinking', () => {
  it('emits thinking with its signature as provider metadata', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'Let me ' }),
      delta(0, { type: 'thinking_delta', thinking: 'think.' }),
      delta(0, { type: 'signature_delta', signature: 'EqQB' }),
      blockStop(0),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'Answer' }),
      blockStop(1),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events.slice(0, 4)).toEqual([
      { type: 'reasoning_delta', text: 'Let me ' },
      { type: 'reasoning_delta', text: 'think.' },
      {
        type: 'reasoning_done',
        text: 'Let me think.',
        providerMetadata: { origin: ORIGIN, data: { signature: 'EqQB' } },
      },
      { type: 'text_delta', text: 'Answer' },
    ]);
  });

  it('emits omitted thinking as an empty reasoning part with its signature', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: '' }),
      delta(0, { type: 'signature_delta', signature: 'sig' }),
      blockStop(0),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events[0]).toEqual({
      type: 'reasoning_done',
      text: '',
      providerMetadata: { origin: ORIGIN, data: { signature: 'sig' } },
    });
  });

  it('emits redacted thinking with its data', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'redacted_thinking', data: 'EmwK' }),
      blockStop(0),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events[0]).toEqual({
      type: 'reasoning_done',
      text: '',
      providerMetadata: { origin: ORIGIN, data: { redactedData: 'EmwK' } },
    });
  });

  it('records the model that actually answered as the origin', () => {
    const events = run([
      sse({
        type: 'message_start',
        message: { model: 'claude-opus-5', usage: { input_tokens: 1 } },
      }),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'signature_delta', signature: 's' }),
      blockStop(0),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events[0]).toMatchObject({
      providerMetadata: { origin: { providerId: 'anthropic', modelId: 'claude-opus-5' } },
    });
  });
});

describe('createAnthropicStream: tool calls', () => {
  const tool = (index: number, id: string, json: string[]) => [
    blockStart(index, { type: 'tool_use', id, name: 'read', input: {} }),
    ...json.map((partial) => delta(index, { type: 'input_json_delta', partial_json: partial })),
    blockStop(index),
  ];

  it('assembles a call from input_json_delta fragments', () => {
    const events = run([
      start(),
      ...tool(0, 'toolu_1', ['', '{"path":', '"a.ts"}']),
      messageDelta('tool_use'),
      stop,
    ]);
    expect(events).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } },
      { type: 'usage', inputTokens: 10, outputTokens: 20 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('emits parallel calls consecutively and in order', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Reading both.' }),
      blockStop(0),
      ...tool(1, 'toolu_a', ['{"path":"a"}']),
      ...tool(2, 'toolu_b', ['{"path":"b"}']),
      messageDelta('tool_use'),
      stop,
    ]);
    expect(events.map((e) => (e.type === 'tool_call' ? e.id : e.type))).toEqual([
      'text_delta',
      'text_done',
      'toolu_a',
      'toolu_b',
      'usage',
      'done',
    ]);
  });

  it('treats a call without input as {}', () => {
    const events = run([start(), ...tool(0, 'toolu_1', []), messageDelta('tool_use'), stop]);
    expect(events[0]).toMatchObject({ type: 'tool_call', input: {} });
  });

  it('reports malformed tool JSON as tool_call_invalid', () => {
    const events = run([
      start(),
      ...tool(0, 'toolu_1', ['{"path": "a']),
      messageDelta('tool_use'),
      stop,
    ]);
    expect(events[0]).toEqual({
      type: 'tool_call_invalid',
      id: 'toolu_1',
      name: 'read',
      rawInput: '{"path": "a',
      reason: 'invalid_json',
    });
  });

  it('marks the last call truncated at max_tokens even when its JSON parses', () => {
    const events = run([
      start(),
      ...tool(0, 'toolu_1', ['{"path":"a"}']),
      ...tool(1, 'toolu_2', ['{"content":"partial"}']),
      messageDelta('max_tokens'),
      stop,
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'read', input: { path: 'a' } },
      {
        type: 'tool_call_invalid',
        id: 'toolu_2',
        name: 'read',
        rawInput: '{"content":"partial"}',
        reason: 'truncated',
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('flushes a held call when a later block starts', () => {
    const events = run([
      start(),
      ...tool(0, 'toolu_1', ['{}']),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'after' }),
      blockStop(1),
      messageDelta('max_tokens'),
      stop,
    ]);
    expect(events[0]).toMatchObject({ type: 'tool_call', id: 'toolu_1' });
  });
});

describe('createAnthropicStream: usage', () => {
  it('maps cache counters 1:1 and overwrites cumulative fields, never summing', () => {
    const events = run([
      start({
        input_tokens: 50,
        output_tokens: 2,
        cache_read_input_tokens: 1800,
        cache_creation_input_tokens: 248,
      }),
      messageDelta('end_turn', { output_tokens: 300 }),
      messageDelta('end_turn', {
        output_tokens: 503,
        input_tokens: null,
        output_tokens_details: { thinking_tokens: 312 },
      }),
      stop,
    ]);
    expect(events[0]).toEqual({
      type: 'usage',
      inputTokens: 50,
      outputTokens: 503,
      cacheReadTokens: 1800,
      cacheWriteTokens: 248,
      reasoningTokens: 312,
    });
  });
});

describe('createAnthropicStream: failures and tolerance', () => {
  it('maps a mid-stream error event, with usage first and a redacted detail', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'par' }),
      sse({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded sk-ant-secret-value' },
      }),
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 1 },
      {
        type: 'error',
        error: expect.objectContaining({
          kind: 'overloaded',
          retryable: true,
          detail: 'overloaded_error: Overloaded [REDACTED]',
        }) as unknown,
      },
    ]);
  });

  it('drops a held call when the stream fails', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }),
      blockStop(0),
      sse({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
    ]);
    expect(events.map((e) => e.type)).toEqual(['usage', 'error']);
  });

  it('turns a body that ends without message_stop into invalid_response', () => {
    const events = run(
      [
        start(),
        blockStart(0, { type: 'text', text: '' }),
        delta(0, { type: 'text_delta', text: 'x' }),
      ],
      { end: true },
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'invalid_response' } });
  });

  it('adds nothing at end() after message_stop', () => {
    expect(run([start(), messageDelta('end_turn'), stop], { end: true }).at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
    });
  });

  it('ignores unknown events, block types, delta types and fields', () => {
    const events = run([
      start(),
      sse({ type: 'brand_new_event', payload: 1 }),
      blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{}' }),
      blockStop(0),
      blockStart(1, { type: 'text', text: '', citations: null, future_field: { a: 1 } }),
      delta(1, { type: 'citations_delta', citation: { type: 'char_location' } }),
      delta(1, { type: 'text_delta', text: 'ok', extra: true }),
      delta(1, { type: 'future_delta' }),
      blockStop(1),
      messageDelta('end_turn'),
      stop,
    ]);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_done', 'usage', 'done']);
  });

  it.each([
    ['unparseable JSON', { event: 'message_delta', data: '{"type":' }],
    [
      'a known event with a wrong shape',
      { event: 'content_block_delta', data: '{"type":"content_block_delta","index":"x"}' },
    ],
    [
      'a delta for a block that never started',
      sse({ type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'x' } }),
    ],
    ['data without a type', { event: 'message', data: '[1,2]' }],
  ])('fails with invalid_response on %s', (_label, event) => {
    const events = run([start(), event]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'invalid_response' } });
  });
});
