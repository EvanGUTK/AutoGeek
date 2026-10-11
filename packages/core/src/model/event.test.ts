import { describe, expect, it } from 'vitest';
import { ModelEventSchema, ModelUsageSchema, STOP_REASONS } from './event.ts';
import { providerError } from './provider-error.ts';

const metadata = { origin: { providerId: 'p', modelId: 'm' }, data: { sig: 'x' } };

describe('ModelEventSchema', () => {
  it.each([
    ['text_delta', { type: 'text_delta', text: 'hi' }],
    ['text_done', { type: 'text_done' }],
    ['text_done with metadata', { type: 'text_done', providerMetadata: metadata }],
    ['reasoning_delta', { type: 'reasoning_delta', text: 'hmm' }],
    ['reasoning_done', { type: 'reasoning_done', text: 'hmm' }],
    ['redacted reasoning_done', { type: 'reasoning_done', text: '', providerMetadata: metadata }],
    ['tool_call', { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } }],
    [
      'tool_call with metadata',
      { type: 'tool_call', id: 'c1', name: 'x', input: {}, providerMetadata: metadata },
    ],
    [
      'tool_call_invalid',
      { type: 'tool_call_invalid', id: 'c2', name: 'x', rawInput: '{"a":', reason: 'truncated' },
    ],
    ['usage', { type: 'usage', inputTokens: 10, outputTokens: 5 }],
    [
      'usage with every optional field',
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        reasoningTokens: 3,
      },
    ],
    ['done', { type: 'done', stopReason: 'end_turn' }],
    ['error', { type: 'error', error: providerError('rate_limit', 'p', { status: 429 }) }],
  ])('accepts %s', (_name, event) => {
    expect(ModelEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    ['an unknown type', { type: 'partial_json', text: '{' }],
    [
      'a tool_call whose input is not an object',
      { type: 'tool_call', id: 'c', name: 'x', input: [] },
    ],
    ['a tool_call with an empty id', { type: 'tool_call', id: '', name: 'x', input: {} }],
    [
      'a tool_call_invalid with an unknown reason',
      { type: 'tool_call_invalid', id: 'c', name: 'x', rawInput: '', reason: 'weird' },
    ],
    ['usage with a negative count', { type: 'usage', inputTokens: -1, outputTokens: 0 }],
    ['usage with a fractional count', { type: 'usage', inputTokens: 1.5, outputTokens: 0 }],
    ['usage missing outputTokens', { type: 'usage', inputTokens: 1 }],
    [
      'usage with the removed cachedTokens field',
      { type: 'usage', inputTokens: 1, outputTokens: 1, cachedTokens: 1 },
    ],
    ['done with the removed error stop reason', { type: 'done', stopReason: 'error' }],
    ['done with an unknown stop reason', { type: 'done', stopReason: 'stop' }],
    ['an error event with a free-form error', { type: 'error', error: { message: 'boom' } }],
    [
      'an error event with a tampered message',
      { type: 'error', error: { ...providerError('auth', 'p'), message: 'key sk-1 bad' } },
    ],
    [
      'reasoning_done with the old signature field',
      { type: 'reasoning_done', text: '', signature: 's' },
    ],
    ['extra fields', { type: 'text_delta', text: 'x', extra: 1 }],
  ])('rejects %s', (_name, event) => {
    expect(ModelEventSchema.safeParse(event).success).toBe(false);
  });

  it('lists exactly the four stop reasons', () => {
    expect([...STOP_REASONS]).toEqual(['end_turn', 'tool_use', 'max_tokens', 'refusal']);
  });

  it('bounds tool_call_invalid.rawInput to 4 KiB of UTF-8', () => {
    const invalid = (rawInput: string): unknown => ({
      type: 'tool_call_invalid',
      id: 'c',
      name: 'x',
      rawInput,
      reason: 'invalid_json',
    });
    expect(ModelEventSchema.safeParse(invalid('a'.repeat(4096))).success).toBe(true);
    expect(ModelEventSchema.safeParse(invalid('a'.repeat(4097))).success).toBe(false);
    expect(ModelEventSchema.safeParse(invalid('é'.repeat(2049))).success).toBe(false);
  });
});

describe('ModelUsageSchema', () => {
  it('is the usage event without its type tag', () => {
    expect(ModelUsageSchema.safeParse({ inputTokens: 1, outputTokens: 2 }).success).toBe(true);
    expect(
      ModelUsageSchema.safeParse({ type: 'usage', inputTokens: 1, outputTokens: 2 }).success,
    ).toBe(false);
  });
});
