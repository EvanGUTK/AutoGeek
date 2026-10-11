import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../http/logger.ts';
import type { SseEvent } from '../../http/sse.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { createOpenAIStream } from './stream.ts';

const MODEL = 'gpt-5.5';
const ORIGIN = { providerId: 'openai', modelId: MODEL };
let sequence = 0;

function sse(data: Record<string, unknown>): SseEvent {
  sequence += 1;
  const type = typeof data['type'] === 'string' ? data['type'] : 'message';
  return { event: type, data: JSON.stringify({ ...data, sequence_number: sequence }) };
}

const created = sse({
  type: 'response.created',
  response: { id: 'resp_1', model: MODEL, status: 'in_progress', output: [], usage: null },
});
const added = (index: number, item: Record<string, unknown>) =>
  sse({ type: 'response.output_item.added', output_index: index, item });
const done = (index: number, item: Record<string, unknown>) =>
  sse({ type: 'response.output_item.done', output_index: index, item });
const textDelta = (index: number, delta: string) =>
  sse({
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: index,
    content_index: 0,
    delta,
  });
const argsDelta = (index: number, delta: string) =>
  sse({
    type: 'response.function_call_arguments.delta',
    item_id: `fc_${String(index)}`,
    output_index: index,
    delta,
  });
const USAGE = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 50 },
  output_tokens: 340,
  output_tokens_details: { reasoning_tokens: 256 },
  total_tokens: 1540,
};
const completed = (usage: Record<string, unknown> = USAGE) =>
  sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage } });

function run(events: readonly SseEvent[], end = false): ModelEvent[] {
  const writer = createEventWriter();
  const stream = createOpenAIStream({
    writer,
    model: MODEL,
    logger: NOOP_LOGGER,
    secrets: () => ['sk-proj-SECRETSECRET'],
  });
  const out = events.flatMap((event) => stream.handle(event));
  if (end) out.push(...stream.end());
  for (const event of out) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(out)).toEqual([]);
  return out;
}

const message = (index: number, parts: string[]) => [
  added(index, {
    type: 'message',
    id: 'msg_1',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  }),
  ...parts.map((part) => textDelta(index, part)),
  done(index, {
    type: 'message',
    id: 'msg_1',
    status: 'completed',
    role: 'assistant',
    content: [],
  }),
];
const call = (index: number, callId: string, fragments: string[], status = 'completed') => [
  added(index, {
    type: 'function_call',
    id: `fc_${String(index)}`,
    call_id: callId,
    name: 'read',
    arguments: '',
    status: 'in_progress',
  }),
  ...fragments.map((fragment) => argsDelta(index, fragment)),
  done(index, {
    type: 'function_call',
    id: `fc_${String(index)}`,
    call_id: callId,
    name: 'read',
    arguments: fragments.join(''),
    status,
  }),
];

describe('createOpenAIStream', () => {
  it('streams text with the message id as metadata and normalized usage', () => {
    const events = run([created, ...message(0, ['Hel', 'lo']), completed()]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'text_done', providerMetadata: { origin: ORIGIN, data: { itemId: 'msg_1' } } },
      // input excludes cached tokens; cache writes are reported but not subtracted (over-count).
      {
        type: 'usage',
        inputTokens: 176,
        outputTokens: 340,
        cacheReadTokens: 1024,
        cacheWriteTokens: 50,
        reasoningTokens: 256,
      },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('keeps the whole reasoning item, unknown fields included, for replay', () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [
        { type: 'summary_text', text: 'A' },
        { type: 'summary_text', text: 'B' },
      ],
      encrypted_content: 'gAAAA',
      future: { x: 1 },
    };
    const events = run([
      created,
      added(0, { type: 'reasoning', id: 'rs_1', summary: [] }),
      sse({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'A',
      }),
      sse({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 1,
        delta: 'B',
      }),
      done(0, item),
      completed(),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: 'reasoning_delta', text: 'A' },
      { type: 'reasoning_delta', text: '\n\nB' },
      {
        type: 'reasoning_done',
        text: 'A\n\nB',
        providerMetadata: { origin: ORIGIN, data: { item } },
      },
    ]);
  });

  it('emits reasoning without a summary as an empty part with its item', () => {
    const item = { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAAA' };
    const events = run([
      created,
      added(0, { type: 'reasoning', id: 'rs_2', summary: [] }),
      done(0, item),
      completed(),
    ]);
    expect(events[0]).toEqual({
      type: 'reasoning_done',
      text: '',
      providerMetadata: { origin: ORIGIN, data: { item } },
    });
  });

  it('assembles parallel function calls with their item ids', () => {
    const events = run([
      created,
      ...call(0, 'call_a', ['{"path":', '"a"}']),
      ...call(1, 'call_b', ['{"path":"b"}']),
      completed(),
    ]);
    expect(events.slice(0, 2)).toEqual([
      {
        type: 'tool_call',
        id: 'call_a',
        name: 'read',
        input: { path: 'a' },
        providerMetadata: { origin: ORIGIN, data: { itemId: 'fc_0' } },
      },
      {
        type: 'tool_call',
        id: 'call_b',
        name: 'read',
        input: { path: 'b' },
        providerMetadata: { origin: ORIGIN, data: { itemId: 'fc_1' } },
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('reports malformed arguments as tool_call_invalid', () => {
    const events = run([created, ...call(0, 'call_a', ['{"path":']), completed()]);
    expect(events[0]).toMatchObject({
      type: 'tool_call_invalid',
      reason: 'invalid_json',
      rawInput: '{"path":',
    });
  });

  it('treats an incomplete item or an unfinished call at max_output_tokens as truncated', () => {
    const incomplete = sse({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: USAGE,
      },
    });
    const viaStatus = run([created, ...call(0, 'call_a', ['{"a":1}'], 'incomplete'), incomplete]);
    expect(viaStatus[0]).toMatchObject({ type: 'tool_call_invalid', reason: 'truncated' });
    expect(viaStatus.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });

    const unfinished = run([
      created,
      added(0, {
        type: 'function_call',
        id: 'fc_0',
        call_id: 'call_a',
        name: 'read',
        arguments: '',
      }),
      argsDelta(0, '{"a":'),
      incomplete,
    ]);
    expect(unfinished[0]).toMatchObject({
      type: 'tool_call_invalid',
      id: 'call_a',
      reason: 'truncated',
    });
  });

  it('ends with refusal when refusal content was streamed', () => {
    const events = run([
      created,
      added(0, { type: 'message', id: 'msg_1', content: [] }),
      sse({
        type: 'response.refusal.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'I cannot help.',
      }),
      done(0, { type: 'message', id: 'msg_1', content: [] }),
      completed(),
    ]);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'I cannot help.' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it('maps response.failed and error events with redacted detail', () => {
    const failed = run([
      created,
      sse({
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'rate_limit_exceeded', message: 'slow down sk-proj-SECRETSECRET' },
          usage: null,
        },
      }),
    ]);
    expect(failed).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          kind: 'rate_limit',
          detail: 'rate_limit_exceeded: slow down [REDACTED]',
        }) as unknown,
      },
    ]);
    const errored = run([
      created,
      sse({ type: 'error', code: 'server_error', message: 'boom', param: null }),
    ]);
    expect(errored.at(-1)).toMatchObject({ type: 'error', error: { kind: 'server' } });
  });

  it('ignores unknown events, item types and fields', () => {
    const events = run([
      created,
      sse({ type: 'response.in_progress', response: {} }),
      added(0, { type: 'web_search_call', id: 'ws_1' }),
      done(0, { type: 'web_search_call', id: 'ws_1' }),
      sse({ type: 'response.brand_new', x: 1 }),
      ...message(1, ['ok']),
      sse({
        type: 'response.output_text.done',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        text: 'ok',
      }),
      completed({ ...USAGE, future: 1 }),
    ]);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_done', 'usage', 'done']);
  });

  it('turns a stream without a terminal event into invalid_response', () => {
    const events = run([created, ...message(0, ['x'])], true);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'invalid_response' } });
  });

  it('fails on an item finishing that never started', () => {
    const events = run([created, done(3, { type: 'message', id: 'm' })]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'invalid_response' } });
  });
});
