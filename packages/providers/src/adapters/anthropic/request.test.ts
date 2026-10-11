import { ModelRequestSchema } from '@autogeek/core';
import type { Message, ModelRequest, ProviderMetadata } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { anthropicProfile } from './models.ts';
import { buildAnthropicBody, toolUseId } from './request.ts';

const OPUS = 'claude-opus-5-5';

function build(overrides: Partial<ModelRequest> & Pick<ModelRequest, 'messages'>, model = OPUS) {
  const request = ModelRequestSchema.parse({ model, maxOutputTokens: 1024, ...overrides });
  return buildAnthropicBody(request, anthropicProfile(model));
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const system = (text: string, cacheHint?: 'ephemeral'): Message => ({
  role: 'system',
  content: [{ type: 'text', text }],
  ...(cacheHint === undefined ? {} : { cacheHint }),
});

function thinking(
  modelId: string,
  signature: string,
  text = 'pondering',
): Message['content'][number] {
  const metadata: ProviderMetadata = {
    origin: { providerId: 'anthropic', modelId },
    data: { signature },
  };
  return { type: 'reasoning', text, providerMetadata: metadata };
}

const toolTurn = (id: string, reasoning?: Message['content'][number]): Message => ({
  role: 'assistant',
  content: [
    ...(reasoning === undefined ? [] : [reasoning]),
    { type: 'tool_call', id, name: 'read', input: { path: 'a.ts' } },
  ],
});
const toolResult = (callId: string, output = 'contents'): Message => ({
  role: 'tool',
  content: [{ type: 'tool_result', callId, output, isError: false }],
});

describe('buildAnthropicBody: basics', () => {
  it('builds a streaming body without sampling parameters or forced tool choice', () => {
    const body = build({ messages: [user('hi')], stopSequences: ['END'] });
    expect(body).toEqual({
      model: OPUS,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stop_sequences: ['END'],
    });
    const keys = Object.keys(body);
    for (const banned of ['temperature', 'top_p', 'top_k']) expect(keys).not.toContain(banned);
  });

  it('turns the leading system messages into the system prompt with cache hints', () => {
    const body = build({ messages: [system('a'), system('b', 'ephemeral'), user('hi')] });
    expect(body.system).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('maps images and skips empty text', () => {
    const body = build({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
            { type: 'text', text: 'what is this' },
          ],
        },
      ],
    });
    expect(body.messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'what is this' },
    ]);
  });
});

describe('buildAnthropicBody: tools', () => {
  const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }];

  it('maps tools with eager input streaming and passes auto/none tool choice', () => {
    const body = build({ messages: [user('hi')], tools, toolChoice: 'none' });
    expect(body.tools).toEqual([
      {
        name: 'read',
        description: 'Read a file',
        input_schema: { type: 'object' },
        eager_input_streaming: true,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'none' });
  });

  it('omits tool_choice without tools', () => {
    expect(build({ messages: [user('hi')], toolChoice: 'auto' }).tool_choice).toBeUndefined();
  });

  it('puts tool results in a user turn, first, merged with a following user message', () => {
    const body = build({
      messages: [
        user('read a.ts'),
        toolTurn('toolu_1'),
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'toolu_1',
              output: [{ type: 'text', text: 'x' }],
              isError: true,
            },
          ],
        },
        user('also note this'),
      ],
    });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'x' }],
            is_error: true,
          },
          { type: 'text', text: 'also note this' },
        ],
      },
    ]);
  });

  it('maps foreign tool ids the same way in the call and its result', () => {
    const body = build({
      messages: [user('go'), toolTurn('call.abc/1'), toolResult('call.abc/1')],
    });
    expect(toolUseId('call.abc/1')).toBe('call_abc_1');
    expect(body.messages[1]?.content[0]).toMatchObject({ id: 'call_abc_1' });
    expect(body.messages[2]?.content[0]).toMatchObject({ tool_use_id: 'call_abc_1' });
  });
});

describe('buildAnthropicBody: thinking and effort', () => {
  it('asks for a visible summary and maps effort on current models', () => {
    const body = build({ messages: [user('hi')], reasoning: { effort: 'xhigh' } });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
  });

  it('omits the thinking display for hidden reasoning', () => {
    const body = build({ messages: [user('hi')], reasoning: { visibility: 'hidden' } });
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body.output_config).toBeUndefined();
  });

  it('maps an unsupported effort to the nearest level', () => {
    const body = build(
      { messages: [user('hi')], reasoning: { effort: 'xhigh' } },
      'claude-opus-4-6',
    );
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('sends neither thinking nor effort to a model without them', () => {
    const body = build(
      { messages: [user('hi')], reasoning: { effort: 'high' } },
      'claude-haiku-4-5',
    );
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('sends neither to an unknown model', () => {
    const body = build({ messages: [user('hi')], reasoning: { effort: 'high' } }, 'claude-next-9');
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('sends nothing when the request does not ask for reasoning', () => {
    expect(build({ messages: [user('hi')] }).thinking).toBeUndefined();
  });
});

describe('buildAnthropicBody: reasoning replay', () => {
  const history = (): Message[] => [
    user('q1'),
    {
      role: 'assistant',
      content: [thinking('claude-opus-5', 'sig-old'), { type: 'text', text: 'a1' }],
    },
    user('q2'),
    toolTurn('toolu_2', thinking(OPUS, 'sig-new')),
    toolResult('toolu_2'),
  ];

  it('replays every Anthropic thinking block byte-exact, across Claude models', () => {
    const body = build({ messages: history() });
    expect(body.messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'pondering',
      signature: 'sig-old',
    });
    expect(body.messages[3]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'pondering',
      signature: 'sig-new',
    });
  });

  it('replays redacted thinking as redacted_thinking', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: '',
              providerMetadata: {
                origin: { providerId: 'anthropic', modelId: OPUS },
                data: { redactedData: 'Em' },
              },
            },
            { type: 'text', text: 'a' },
          ],
        },
        user('q2'),
      ],
    });
    expect(body.messages[1]?.content[0]).toEqual({ type: 'redacted_thinking', data: 'Em' });
  });

  it('drops reasoning from other providers and reasoning without valid metadata', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'openai thoughts',
              providerMetadata: {
                origin: { providerId: 'openai', modelId: 'gpt-5' },
                data: { id: 'rs_1' },
              },
            },
            { type: 'reasoning', text: 'no metadata' },
            {
              type: 'reasoning',
              text: 'bad data',
              providerMetadata: {
                origin: { providerId: 'anthropic', modelId: OPUS },
                data: { sig: 1 },
              },
            },
            { type: 'text', text: 'a' },
          ],
        },
        user('q2'),
      ],
    });
    expect(body.messages[1]?.content).toEqual([{ type: 'text', text: 'a' }]);
  });

  it("with 'drop', keeps only the in-progress tool-use turn's thinking", () => {
    const body = build({ messages: history(), reasoningReplay: 'drop' });
    expect(body.messages[1]?.content).toEqual([{ type: 'text', text: 'a1' }]);
    expect(body.messages[3]?.content[0]).toMatchObject({ type: 'thinking', signature: 'sig-new' });
  });

  it("with 'drop' and no tool turn in progress, removes all thinking", () => {
    const messages = [
      ...history(),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
      user('q3'),
    ];
    const body = build({ messages, reasoningReplay: 'drop' });
    const types = body.messages.flatMap((m) => m.content.map((b) => b.type));
    expect(types).not.toContain('thinking');
  });

  it('never removes a block from the middle while keeping later ones (model switch)', () => {
    // Switching from Opus 5 to Opus 5.5 keeps both blocks: dropping the Opus 5 one would be a
    // mid-history edit that invalidates the later Opus 5.5 block.
    const body = build({ messages: history() });
    const signatures = body.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'thinking' ? [b.signature] : [])),
    );
    expect(signatures).toEqual(['sig-old', 'sig-new']);
  });
});

describe('buildAnthropicBody: mid-conversation system messages', () => {
  it('uses the native form after a user turn and before an assistant turn on supporting models', () => {
    const body = build({ messages: [user('q'), system('be brief')] });
    expect(body.messages.at(-1)).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'be brief' }],
    });
  });

  it('envelopes it on models without native support, merged into the user turn', () => {
    const body = build({ messages: [user('q'), system('be brief')] }, 'claude-sonnet-5');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'text', text: '<system-instruction>\nbe brief\n</system-instruction>' },
        ],
      },
    ]);
  });

  it('envelopes a whole run when a user turn follows it', () => {
    const body = build({ messages: [user('q'), system('one'), system('two'), user('more')] });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
  });

  it('keeps a run native when an assistant turn follows it', () => {
    const body = build({
      messages: [
        user('q'),
        system('one'),
        system('two'),
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        user('next'),
      ],
    });
    expect(body.messages.map((m) => m.role)).toEqual([
      'user',
      'system',
      'system',
      'assistant',
      'user',
    ]);
  });
});

describe('buildAnthropicBody: cache breakpoints', () => {
  it('marks the last cacheable block of a hinted message, skipping thinking', () => {
    const body = build({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }, thinking(OPUS, 's')],
          cacheHint: 'ephemeral',
        },
        user('q2'),
      ],
    });
    expect(body.messages[1]?.content[0]).toEqual({
      type: 'text',
      text: 'a',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('keeps only the last four breakpoints', () => {
    const hinted = (text: string): Message => ({ ...user(text), cacheHint: 'ephemeral' });
    const body = build({
      messages: [system('s', 'ephemeral'), hinted('1'), hinted('2'), hinted('3'), hinted('4')],
    });
    expect(body.system?.[0]?.cache_control).toBeUndefined();
    const marked = body.messages.flatMap((m) => m.content).filter((b) => 'cache_control' in b);
    expect(marked).toHaveLength(4);
  });
});
