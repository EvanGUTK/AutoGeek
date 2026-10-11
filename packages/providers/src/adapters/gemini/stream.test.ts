import { ModelEventSchema, checkModelEventOrder } from '@autogeek/core';
import type { ModelEvent } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../http/logger.ts';
import type { LogFields, Logger } from '../../http/logger.ts';
import type { SseEvent } from '../../http/sse.ts';
import { createEventWriter } from '../../stream/writer.ts';
import { createGeminiStream } from './stream.ts';

const MODEL = 'gemini-3.8-flash';
const ORIGIN = { providerId: 'google', modelId: MODEL };

const sse = (data: Record<string, unknown>): SseEvent => ({
  event: 'message',
  data: JSON.stringify(data),
});
const chunk = (
  parts: Record<string, unknown>[],
  finishReason?: string,
  usage?: Record<string, unknown>,
) =>
  sse({
    candidates: [
      {
        content: { role: 'model', parts },
        index: 0,
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
    ...(usage === undefined ? {} : { usageMetadata: usage }),
    modelVersion: MODEL,
  });

function run(
  events: readonly SseEvent[],
  options: { end?: boolean; logger?: Logger } = {},
): ModelEvent[] {
  const writer = createEventWriter();
  const stream = createGeminiStream({
    writer,
    model: MODEL,
    logger: options.logger ?? NOOP_LOGGER,
    secrets: () => ['AIzaSECRETSECRETSECRETSECRET00'],
  });
  const out = events.flatMap((event) => stream.handle(event));
  if (options.end === true) out.push(...stream.end());
  for (const event of out) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(out)).toEqual([]);
  return out;
}

describe('createGeminiStream', () => {
  it('streams thoughts and text, closing each at its signature', () => {
    const events = run([
      chunk([{ text: 'Thinking', thought: true }]),
      chunk([{ text: ' more', thought: true, thoughtSignature: 'TS' }]),
      chunk([{ text: 'Hi' }]),
      chunk([{ text: '', thoughtSignature: 'XS' }], 'STOP', {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 30,
      }),
    ]);
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Thinking' },
      { type: 'reasoning_delta', text: ' more' },
      {
        type: 'reasoning_done',
        text: 'Thinking more',
        providerMetadata: { origin: ORIGIN, data: { thoughtSignature: 'TS' } },
      },
      { type: 'text_delta', text: 'Hi' },
      { type: 'text_done', providerMetadata: { origin: ORIGIN, data: { thoughtSignature: 'XS' } } },
      // input excludes cached; output = candidates + thoughts (thinking is billed as output).
      {
        type: 'usage',
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 40,
        reasoningTokens: 30,
      },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('emits whole function calls with signatures and ends with tool_use', () => {
    const events = run([
      chunk(
        [
          {
            functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'a' } },
            thoughtSignature: 'S1',
          },
          { functionCall: { id: 'fc_2', name: 'read_file', args: { path: 'b' } } },
        ],
        'STOP',
      ),
    ]);
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'fc_1',
        name: 'read_file',
        input: { path: 'a' },
        providerMetadata: { origin: ORIGIN, data: { thoughtSignature: 'S1' } },
      },
      { type: 'tool_call', id: 'fc_2', name: 'read_file', input: { path: 'b' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('synthesizes ids for calls without one (Gemini 2.5) and marks them', () => {
    const events = run([
      chunk([{ functionCall: { name: 'f', args: {} } }, { functionCall: { name: 'f' } }], 'STOP'),
    ]);
    expect(events.slice(0, 2)).toEqual([
      {
        type: 'tool_call',
        id: 'gemini_call_1',
        name: 'f',
        input: {},
        providerMetadata: { origin: ORIGIN, data: { idSynthesized: true } },
      },
      {
        type: 'tool_call',
        id: 'gemini_call_2',
        name: 'f',
        input: {},
        providerMetadata: { origin: ORIGIN, data: { idSynthesized: true } },
      },
    ]);
  });

  it('reports non-object args as not_an_object', () => {
    const events = run([chunk([{ functionCall: { id: 'fc', name: 'f', args: [1] } }], 'STOP')]);
    expect(events[0]).toMatchObject({ type: 'tool_call_invalid', reason: 'not_an_object' });
  });

  it('turns MALFORMED_FUNCTION_CALL into an invalid call so the model can be told', () => {
    const events = run([
      sse({
        candidates: [
          {
            content: { parts: [] },
            finishReason: 'MALFORMED_FUNCTION_CALL',
            finishMessage: 'Malformed function call: f(x=',
          },
        ],
      }),
    ]);
    expect(events).toEqual([
      {
        type: 'tool_call_invalid',
        id: 'gemini_call_1',
        name: 'unnamed_tool',
        rawInput: 'Malformed function call: f(x=',
        reason: 'invalid_json',
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it.each([
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'refusal'],
    ['PROHIBITED_CONTENT', 'refusal'],
    ['RECITATION', 'refusal'],
  ])('maps finish reason %s to %s', (reason, stopReason) => {
    expect(run([chunk([{ text: 'x' }], reason)]).at(-1)).toEqual({ type: 'done', stopReason });
  });

  it.each([
    ['MISSING_THOUGHT_SIGNATURE', 'invalid_request'],
    ['UNEXPECTED_TOOL_CALL', 'invalid_response'],
    ['MALFORMED_RESPONSE', 'invalid_response'],
  ])('maps finish reason %s to an %s error', (reason, kind) => {
    expect(run([chunk([], reason)]).at(-1)).toMatchObject({ type: 'error', error: { kind } });
  });

  it('ends an unknown finish reason as end_turn with a warning', () => {
    const warnings: (LogFields | undefined)[] = [];
    const logger: Logger = { ...NOOP_LOGGER, warn: (_m, fields) => warnings.push(fields) };
    expect(run([chunk([{ text: 'x' }], 'BRAND_NEW')], { logger }).at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
    });
    expect(warnings).toEqual([{ providerId: 'google', finishReason: 'BRAND_NEW' }]);
  });

  it('treats a blocked prompt with no candidates as a refusal', () => {
    const events = run([
      sse({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 5 } }),
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 5, outputTokens: 0 },
      { type: 'done', stopReason: 'refusal' },
    ]);
  });

  it('maps a mid-stream status object with redacted detail', () => {
    const events = run([
      chunk([{ text: 'part' }]),
      sse({
        error: {
          code: 503,
          status: 'UNAVAILABLE',
          message: 'overloaded AIzaSECRETSECRETSECRETSECRET00',
        },
      }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: expect.objectContaining({
        kind: 'overloaded',
        detail: 'UNAVAILABLE: overloaded [REDACTED]',
      }) as unknown,
    });
  });

  it('warns about tool-use prompt tokens and ignores them', () => {
    const warnings: (LogFields | undefined)[] = [];
    const logger: Logger = { ...NOOP_LOGGER, warn: (_m, fields) => warnings.push(fields) };
    const events = run(
      [
        chunk([{ text: 'x' }], 'STOP', {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          toolUsePromptTokenCount: 7,
        }),
      ],
      { logger },
    );
    expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    expect(warnings).toEqual([{ providerId: 'google', toolUsePromptTokens: 7 }]);
  });

  it('turns a stream without a finish reason into invalid_response', () => {
    expect(run([chunk([{ text: 'x' }])], { end: true }).at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'invalid_response' },
    });
  });

  it('fails on a chunk of the wrong shape', () => {
    expect(run([sse({ candidates: 'nope' })]).at(-1)).toMatchObject({
      type: 'error',
      error: { kind: 'invalid_response' },
    });
  });
});
