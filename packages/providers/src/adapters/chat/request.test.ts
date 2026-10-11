import { ModelRequestSchema } from '@autogeek/core';
import type { Message, ModelRequest } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { buildChatBody } from './request.ts';
import type { ReasoningDialect } from './request.ts';

const MODEL = 'anthropic/claude-opus-5.5';

function build(
  overrides: Partial<ModelRequest> & Pick<ModelRequest, 'messages'>,
  reasoning: ReasoningDialect = 'openrouter',
) {
  const request = ModelRequestSchema.parse({ model: MODEL, maxOutputTokens: 512, ...overrides });
  return buildChatBody(request, {
    providerId: 'openrouter',
    reasoning,
    replayReasoningDetails: reasoning === 'openrouter',
  });
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

describe('buildChatBody', () => {
  it('builds the common subset with string content', () => {
    expect(
      build({
        messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, user('hi')],
        stopSequences: ['X'],
      }),
    ).toEqual({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      stop: ['X'],
    });
  });

  it('envelopes mid-conversation system messages as user turns', () => {
    const body = build({
      messages: [user('q'), { role: 'system', content: [{ type: 'text', text: 'brief' }] }],
    });
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: '<system-instruction>\nbrief\n</system-instruction>',
    });
  });

  it('maps images, tool calls and tool results; tool images follow in a user message', () => {
    const body = build({
      tools: [{ name: 'shot', description: 'Screenshot', inputSchema: { type: 'object' } }],
      toolChoice: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mediaType: 'image/png', dataBase64: 'AA==' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_call', id: 'c1', name: 'shot', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'c1',
              output: [
                { type: 'text', text: 'done' },
                { type: 'image', mediaType: 'image/png', dataBase64: 'AQ==' },
              ],
              isError: false,
            },
          ],
        },
      ],
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'shot', description: 'Screenshot', parameters: { type: 'object' } },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shot', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: 'done\n[1 image(s) follow in the next message]',
      },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }],
      },
    ]);
  });

  it.each([
    ['openrouter', { reasoning: { effort: 'high', exclude: true } }],
    ['reasoning_effort', { reasoning_effort: 'high' }],
    ['none', {}],
  ] as const)('sends reasoning in the %s dialect', (dialect, expected) => {
    const body = build(
      { messages: [user('q')], reasoning: { effort: 'high', visibility: 'hidden' } },
      dialect,
    );
    expect({ reasoning: body.reasoning, reasoning_effort: body.reasoning_effort }).toEqual({
      reasoning: undefined,
      reasoning_effort: undefined,
      ...expected,
    });
  });

  it('replays reasoning_details unmodified for the same OpenRouter model only', () => {
    const details = [{ type: 'reasoning.encrypted', data: 'enc', index: 0 }];
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 't',
              providerMetadata: {
                origin: { providerId: 'openrouter', modelId: MODEL },
                data: { reasoningDetails: details },
              },
            },
            {
              type: 'reasoning',
              text: 'x',
              providerMetadata: {
                origin: { providerId: 'openrouter', modelId: 'other/model' },
                data: { reasoningDetails: [{ index: 1 }] },
              },
            },
            { type: 'text', text: 'a' },
          ],
        },
        user('q2'),
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: 'a',
      reasoning_details: details,
    });
  });

  it('drops an assistant turn with nothing replayable', () => {
    const body = build({
      messages: [
        user('q'),
        { role: 'assistant', content: [{ type: 'reasoning', text: 'only thoughts' }] },
        user('q2'),
      ],
    });
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'user']);
  });
});
