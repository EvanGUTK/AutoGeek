import { ModelRequestSchema } from '@autogeek/core';
import type { ContentPart, Message, ModelRequest, ProviderMetadata } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { geminiProfile } from './models.ts';
import { DUMMY_THOUGHT_SIGNATURE, GEMINI_MODEL_ID, buildGeminiBody } from './request.ts';

const MODEL = 'gemini-3.8-flash';

function build(overrides: Partial<ModelRequest> & Pick<ModelRequest, 'messages'>, model = MODEL) {
  const request = ModelRequestSchema.parse({ model, maxOutputTokens: 4096, ...overrides });
  return buildGeminiBody(request, geminiProfile(model));
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const meta = (modelId: string, data: Record<string, string | true>): ProviderMetadata => ({
  origin: { providerId: 'google', modelId },
  data,
});
const call = (id: string, providerMetadata?: ProviderMetadata): ContentPart => ({
  type: 'tool_call',
  id,
  name: 'read_file',
  input: { path: `${id}.ts` },
  ...(providerMetadata === undefined ? {} : { providerMetadata }),
});
const result = (callId: string, output = 'x'): ContentPart => ({
  type: 'tool_result',
  callId,
  output,
  isError: false,
});

describe('buildGeminiBody: basics', () => {
  it('builds contents, system instruction and generation config', () => {
    const body = build({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }, user('hi')],
      stopSequences: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'be terse' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 4096, stopSequences: ['a', 'b', 'c', 'd', 'e'] },
    });
  });

  it('envelopes a mid-conversation system message into the user turn', () => {
    const body = build({
      messages: [user('q'), { role: 'system', content: [{ type: 'text', text: 'now be brief' }] }],
    });
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'q' },
          { text: '<system-instruction>\nnow be brief\n</system-instruction>' },
        ],
      },
    ]);
  });

  it('maps tools to JSON-schema declarations without $schema, and tool choice', () => {
    const body = build({
      messages: [user('q')],
      tools: [
        {
          name: 'read_file',
          description: 'Read',
          inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
        },
      ],
      toolChoice: 'none',
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'read_file', description: 'Read', parametersJsonSchema: { type: 'object' } },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });

  it('accepts only plain model ids for the URL path', () => {
    expect(GEMINI_MODEL_ID.test('gemini-3.8-flash')).toBe(true);
    for (const bad of ['../files', 'models/x', 'a?b', 'a:b', '', 'a b'])
      expect(GEMINI_MODEL_ID.test(bad)).toBe(false);
  });
});

describe('buildGeminiBody: thinking', () => {
  it('uses thinkingLevel on Gemini 3 and maps efforts above high to high', () => {
    expect(
      build({ messages: [user('q')], reasoning: { effort: 'max' } }).generationConfig
        .thinkingConfig,
    ).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
  });

  it('uses a clamped thinkingBudget on Gemini 2.5, never a level', () => {
    expect(
      build(
        { messages: [user('q')], reasoning: { effort: 'max', visibility: 'hidden' } },
        'gemini-2.5-flash',
      ).generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: false, thinkingBudget: 24_576 });
    expect(
      build({ messages: [user('q')], reasoning: { effort: 'low' } }, 'gemini-2.5-flash-lite')
        .generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
  });

  it('sends no thinking config to unknown models or without a reasoning request', () => {
    expect(
      build({ messages: [user('q')], reasoning: { effort: 'high' } }, 'gemini-9-ultra')
        .generationConfig.thinkingConfig,
    ).toBeUndefined();
    expect(build({ messages: [user('q')] }).generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe('buildGeminiBody: function calls and signatures', () => {
  it('replays signatures in the exact part, ids, and responses with names in order', () => {
    const body = build({
      messages: [
        user('read both'),
        {
          role: 'assistant',
          content: [
            call('fc_1', meta(MODEL, { thoughtSignature: 'SIG' })),
            call('fc_2', meta(MODEL, {})),
          ],
        },
        { role: 'tool', content: [result('fc_1', 'one'), result('fc_2', 'two')] },
      ],
    });
    expect(body.contents.slice(1)).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'fc_1.ts' } },
            thoughtSignature: 'SIG',
          },
          { functionCall: { id: 'fc_2', name: 'read_file', args: { path: 'fc_2.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc_1', name: 'read_file', response: { output: 'one' } } },
          { functionResponse: { id: 'fc_2', name: 'read_file', response: { output: 'two' } } },
        ],
      },
    ]);
  });

  it('gives a foreign call in the current turn the documented dummy signature', () => {
    // History from another provider: Gemini 3 would reject the call without a signature.
    const body = build({
      messages: [
        user('read'),
        { role: 'assistant', content: [call('toolu_1'), call('toolu_2')] },
        { role: 'tool', content: [result('toolu_1'), result('toolu_2')] },
      ],
    });
    expect(DUMMY_THOUGHT_SIGNATURE).toBe('skip_thought_signature_validator');
    expect(body.contents[1]?.parts).toEqual([
      {
        functionCall: { id: 'toolu_1', name: 'read_file', args: { path: 'toolu_1.ts' } },
        thoughtSignature: DUMMY_THOUGHT_SIGNATURE,
      },
      { functionCall: { id: 'toolu_2', name: 'read_file', args: { path: 'toolu_2.ts' } } },
    ]);
  });

  it('gives a call from another Gemini model the dummy instead of its foreign signature', () => {
    const body = build({
      messages: [
        user('read'),
        {
          role: 'assistant',
          content: [call('fc_1', meta('gemini-3.6-flash', { thoughtSignature: 'OTHER' }))],
        },
        { role: 'tool', content: [result('fc_1')] },
      ],
    });
    expect(body.contents[1]?.parts[0]).toMatchObject({ thoughtSignature: DUMMY_THOUGHT_SIGNATURE });
  });

  it('adds no dummy outside the current turn', () => {
    const body = build({
      messages: [
        user('read'),
        { role: 'assistant', content: [call('toolu_1')] },
        { role: 'tool', content: [result('toolu_1')] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        user('next question'),
      ],
    });
    expect(body.contents[1]?.parts[0]).not.toHaveProperty('thoughtSignature');
  });

  it('omits synthesized ids so Gemini 2.5 matches calls by name and order', () => {
    const body = build({
      messages: [
        user('read'),
        {
          role: 'assistant',
          content: [call('gemini_call_1', meta(MODEL, { idSynthesized: true }))],
        },
        { role: 'tool', content: [result('gemini_call_1')] },
      ],
    });
    expect(body.contents[1]?.parts[0]).toMatchObject({ functionCall: { name: 'read_file' } });
    expect(body.contents[1]?.parts[0]).not.toHaveProperty('functionCall.id');
    expect(body.contents[2]?.parts[0]).toEqual({
      functionResponse: { name: 'read_file', response: { output: 'x' } },
    });
  });

  it('reports errors and images in function responses', () => {
    const body = build({
      messages: [
        user('shot'),
        { role: 'assistant', content: [call('fc_1', meta(MODEL, { thoughtSignature: 'S' }))] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'fc_1',
              output: [
                { type: 'text', text: 'failed' },
                { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
              ],
              isError: true,
            },
          ],
        },
      ],
    });
    expect(body.contents[2]?.parts[0]).toEqual({
      functionResponse: {
        id: 'fc_1',
        name: 'read_file',
        response: { error: 'failed', images: [{ $ref: 'image-1.png' }] },
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'AAAA', displayName: 'image-1.png' } },
        ],
      },
    });
  });

  it('replays text signatures and signed thoughts for the same model only', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'thinking',
              providerMetadata: meta(MODEL, { thoughtSignature: 'T' }),
            },
            { type: 'reasoning', text: 'unsigned' },
            {
              type: 'text',
              text: 'answer',
              providerMetadata: meta(MODEL, { thoughtSignature: 'A' }),
            },
            {
              type: 'text',
              text: 'other',
              providerMetadata: meta('gemini-2.5-pro', { thoughtSignature: 'B' }),
            },
          ],
        },
        user('q2'),
      ],
    });
    expect(body.contents[1]?.parts).toEqual([
      { text: 'thinking', thought: true, thoughtSignature: 'T' },
      { text: 'answer', thoughtSignature: 'A' },
      { text: 'other' },
    ]);
  });
});
