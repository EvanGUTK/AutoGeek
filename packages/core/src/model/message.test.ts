import { describe, expect, it } from 'vitest';
import { ContentPartSchema, MessageSchema, ProviderMetadataSchema } from './message.ts';

const origin = { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' };
const metadata = { origin, data: { signature: 'abc', nested: [1, null] } };

describe('ProviderMetadataSchema', () => {
  it('accepts an origin-tagged JSON blob', () => {
    expect(ProviderMetadataSchema.safeParse(metadata).success).toBe(true);
  });

  it.each([
    ['an empty providerId', { origin: { ...origin, providerId: '' }, data: 1 }],
    ['an empty modelId', { origin: { ...origin, modelId: '' }, data: 1 }],
    ['a missing origin', { data: 1 }],
    ['non-JSON data (function)', { origin, data: () => 1 }],
    ['non-JSON data (undefined)', { origin, data: undefined }],
    ['extra fields', { origin, data: 1, extra: true }],
    ['extra origin fields', { origin: { ...origin, region: 'eu' }, data: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(ProviderMetadataSchema.safeParse(value).success).toBe(false);
  });

  it('survives a JSON round trip, since checkpoints persist it', () => {
    const parsed = ProviderMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)));
    expect(parsed).toEqual(metadata);
  });
});

describe('ContentPartSchema', () => {
  it.each([
    ['text', { type: 'text', text: 'hi' }],
    ['text with provider metadata', { type: 'text', text: 'hi', providerMetadata: metadata }],
    ['empty text', { type: 'text', text: '' }],
    ['image', { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }],
    ['tool_call', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } }],
    ['tool_call with empty input', { type: 'tool_call', id: 'c1', name: 'noop', input: {} }],
    [
      'tool_call with provider metadata',
      { type: 'tool_call', id: 'c1', name: 'x', input: {}, providerMetadata: metadata },
    ],
    [
      'tool_result with a string',
      { type: 'tool_result', callId: 'c1', output: 'ok', isError: false },
    ],
    [
      'tool_result with blocks',
      {
        type: 'tool_result',
        callId: 'c1',
        output: [
          { type: 'text', text: 'see' },
          { type: 'image', mediaType: 'image/jpeg', dataBase64: 'AAAA' },
        ],
        isError: true,
      },
    ],
    ['reasoning', { type: 'reasoning', text: 'thinking' }],
    [
      'redacted reasoning (empty text plus metadata)',
      { type: 'reasoning', text: '', providerMetadata: metadata },
    ],
  ])('accepts %s', (_name, part) => {
    expect(ContentPartSchema.safeParse(part).success).toBe(true);
  });

  it.each([
    ['an unknown type', { type: 'audio', data: 'x' }],
    ['tool_call input that is an array', { type: 'tool_call', id: 'c', name: 'x', input: [] }],
    ['tool_call input that is a string', { type: 'tool_call', id: 'c', name: 'x', input: '{}' }],
    ['tool_call input that is null', { type: 'tool_call', id: 'c', name: 'x', input: null }],
    ['tool_call with an empty id', { type: 'tool_call', id: '', name: 'x', input: {} }],
    ['tool_call with an empty name', { type: 'tool_call', id: 'c', name: '', input: {} }],
    [
      'tool_result with non-block output',
      { type: 'tool_result', callId: 'c', output: { a: 1 }, isError: false },
    ],
    ['tool_result missing isError', { type: 'tool_result', callId: 'c', output: 'ok' }],
    [
      'tool_result with an empty callId',
      { type: 'tool_result', callId: '', output: 'ok', isError: false },
    ],
    [
      'an image with an unsupported media type',
      { type: 'image', mediaType: 'image/svg+xml', dataBase64: 'AAAA' },
    ],
    ['reasoning with the old signature field', { type: 'reasoning', text: 't', signature: 's' }],
    [
      'reasoning with the old redactedData field',
      { type: 'reasoning', text: '', redactedData: 'x' },
    ],
    ['text with extra fields', { type: 'text', text: 'hi', extra: 1 }],
    ['tool_call with extra fields', { type: 'tool_call', id: 'c', name: 'x', input: {}, extra: 1 }],
    [
      'providerMetadata on an image',
      { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA', providerMetadata: metadata },
    ],
    [
      'providerMetadata on a tool_result',
      {
        type: 'tool_result',
        callId: 'c',
        output: 'ok',
        isError: false,
        providerMetadata: metadata,
      },
    ],
  ])('rejects %s', (_name, part) => {
    expect(ContentPartSchema.safeParse(part).success).toBe(false);
  });
});

describe('MessageSchema', () => {
  it.each(['system', 'user', 'assistant'] as const)('accepts a %s message with text', (role) => {
    expect(MessageSchema.safeParse({ role, content: [{ type: 'text', text: 'x' }] }).success).toBe(
      true,
    );
  });

  it('accepts a cache hint of ephemeral and nothing else', () => {
    const content = [{ type: 'text', text: 'x' }];
    expect(MessageSchema.safeParse({ role: 'user', content, cacheHint: 'ephemeral' }).success).toBe(
      true,
    );
    expect(
      MessageSchema.safeParse({ role: 'user', content, cacheHint: 'persistent' }).success,
    ).toBe(false);
  });

  it('accepts a tool message made only of tool_result parts', () => {
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'a', output: 'x', isError: false },
        { type: 'tool_result', callId: 'b', output: 'y', isError: true },
      ],
    };
    expect(MessageSchema.safeParse(message).success).toBe(true);
  });

  it('rejects a tool message that contains anything but tool_result parts', () => {
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', callId: 'a', output: 'x', isError: false },
        { type: 'text', text: 'stray' },
      ],
    };
    expect(MessageSchema.safeParse(message).success).toBe(false);
  });

  it('rejects an unknown role, a missing content array and extra fields', () => {
    expect(MessageSchema.safeParse({ role: 'developer', content: [] }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: 'user' }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: 'user', content: [], extra: 1 }).success).toBe(false);
  });
});
