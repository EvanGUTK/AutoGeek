import { ModelRequestSchema } from '@autogeek/core';
import type { ContentPart, Message, ModelRequest } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { openaiProfile } from './models.ts';
import { buildOpenAIBody } from './request.ts';

const MODEL = 'gpt-5.5';

function build(overrides: Partial<ModelRequest> & Pick<ModelRequest, 'messages'>, model = MODEL) {
  const request = ModelRequestSchema.parse({ model, maxOutputTokens: 2048, ...overrides });
  return buildOpenAIBody(request, openaiProfile(model));
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const system = (text: string): Message => ({ role: 'system', content: [{ type: 'text', text }] });
const reasoningItem = (modelId: string, id: string): ContentPart => ({
  type: 'reasoning',
  text: 'summary',
  providerMetadata: {
    origin: { providerId: 'openai', modelId },
    data: { item: { type: 'reasoning', id, summary: [], encrypted_content: `enc-${id}` } },
  },
});

describe('buildOpenAIBody', () => {
  it('builds a stateless streaming body', () => {
    const body = build({ messages: [system('be terse'), user('hi')], stopSequences: ['END'] });
    expect(body).toEqual({
      model: MODEL,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 2048,
      instructions: 'be terse',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
  });

  it('maps a mid-conversation system message to a developer message', () => {
    const body = build({ messages: [user('q'), system('now be brief')] });
    expect(body.input.at(-1)).toEqual({
      role: 'developer',
      content: [{ type: 'input_text', text: 'now be brief' }],
    });
  });

  it('maps images to data URLs', () => {
    const body = build({
      messages: [
        { role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', dataBase64: 'AAAA' }] },
      ],
    });
    expect(body.input[0]).toEqual({
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA', detail: 'auto' }],
    });
  });

  it('maps tools non-strict, tool choice, calls and outputs', () => {
    const body = build({
      tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
      toolChoice: 'auto',
      messages: [
        user('read a'),
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'read',
              input: { path: 'a' },
              providerMetadata: {
                origin: { providerId: 'openai', modelId: MODEL },
                data: { itemId: 'fc_1' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'call_1',
              output: [{ type: 'text', text: 'contents' }],
              isError: false,
            },
          ],
        },
      ],
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read',
        parameters: { type: 'object' },
        strict: false,
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.input.slice(1)).toEqual([
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"a"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_text', text: 'contents' }],
      },
    ]);
  });

  it('omits item ids produced by another model or provider', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'a',
              providerMetadata: {
                origin: { providerId: 'openai', modelId: 'gpt-5' },
                data: { itemId: 'msg_x' },
              },
            },
            { type: 'tool_call', id: 'toolu_1', name: 'read', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', callId: 'toolu_1', output: 'x', isError: false }],
        },
      ],
    });
    expect(body.input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'a', annotations: [] }],
    });
    expect(body.input[2]).toEqual({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'read',
      arguments: '{}',
    });
  });

  it('replays reasoning items unmodified, only from the same model', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [reasoningItem('gpt-5', 'rs_old'), { type: 'text', text: 'a' }],
        },
        user('q2'),
        {
          role: 'assistant',
          content: [reasoningItem(MODEL, 'rs_new'), { type: 'text', text: 'b' }],
        },
        user('q3'),
      ],
    });
    const items = body.input.filter((item) => 'type' in item && item.type === 'reasoning');
    expect(items).toEqual([
      { type: 'reasoning', id: 'rs_new', summary: [], encrypted_content: 'enc-rs_new' },
    ]);
  });

  it('asks for a reasoning summary and maps effort for reasoning models', () => {
    expect(build({ messages: [user('q')], reasoning: { effort: 'max' } }).reasoning).toEqual({
      effort: 'xhigh',
      summary: 'auto',
    });
    expect(build({ messages: [user('q')], reasoning: { visibility: 'hidden' } }).reasoning).toEqual(
      {},
    );
  });

  it('sends no reasoning parameter to non-reasoning models', () => {
    expect(
      build({ messages: [user('q')], reasoning: { effort: 'low' } }, 'gpt-4.1').reasoning,
    ).toBeUndefined();
  });
});
