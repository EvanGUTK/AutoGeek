import { ModelEventSchema, checkModelEventOrder, providerError } from '@autogeek/core';
import type { ModelEvent, ProviderMetadata } from '@autogeek/core';
import { describe, expect, it } from 'vitest';
import { UNNAMED_TOOL, createEventWriter } from './writer.ts';
import type { EventWriter } from './writer.ts';

const META: ProviderMetadata = {
  origin: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
  data: { signature: 'sig' },
};

function run(script: (writer: EventWriter) => ModelEvent[][]): ModelEvent[] {
  const writer = createEventWriter();
  const events = script(writer).flat();
  for (const event of events) ModelEventSchema.parse(event);
  expect(checkModelEventOrder(events)).toEqual([]);
  return events;
}

describe('createEventWriter: parts', () => {
  it('closes an open text part before a reasoning part starts', () => {
    const events = run((w) => [w.textDelta('a'), w.reasoningDelta('r'), w.finish('end_turn')]);
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'text_done',
      'reasoning_delta',
      'reasoning_done',
      'done',
    ]);
  });

  it('accumulates reasoning text for reasoning_done and keeps its metadata', () => {
    const events = run((w) => [
      w.reasoningDelta('think'),
      w.reasoningDelta('ing'),
      w.reasoningDone({ providerMetadata: META }),
      w.finish('end_turn'),
    ]);
    expect(events).toContainEqual({
      type: 'reasoning_done',
      text: 'thinking',
      providerMetadata: META,
    });
  });

  it('lets a vendor supply the final reasoning text', () => {
    const events = run((w) => [w.reasoningDone({ text: 'summary' }), w.finish('end_turn')]);
    expect(events[0]).toEqual({ type: 'reasoning_done', text: 'summary' });
  });

  it('emits redacted reasoning as an empty part with metadata', () => {
    const events = run((w) => [w.reasoningDone({ providerMetadata: META }), w.finish('end_turn')]);
    expect(events[0]).toEqual({ type: 'reasoning_done', text: '', providerMetadata: META });
  });

  it('closes text with metadata, and never emits a text_done for nothing', () => {
    const events = run((w) => [
      w.textDone(),
      w.textDelta('hi'),
      w.textDone(META),
      w.textDone(),
      w.finish('end_turn'),
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'text_done', providerMetadata: META },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('emits a metadata-only text part when a vendor sends a signature without text', () => {
    const events = run((w) => [w.textDone(META), w.finish('end_turn')]);
    expect(events[0]).toEqual({ type: 'text_done', providerMetadata: META });
  });

  it('drops empty deltas', () => {
    const events = run((w) => [w.textDelta(''), w.reasoningDelta(''), w.finish('end_turn')]);
    expect(events).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('closes an open part on finish', () => {
    const events = run((w) => [w.textDelta('a'), w.finish('max_tokens')]);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_done', 'done']);
  });
});

describe('createEventWriter: tool calls', () => {
  it('emits a parsed call and closes the open part first', () => {
    const events = run((w) => [
      w.textDelta('let me look'),
      w.toolCall({ id: 'c1', name: 'read', rawInput: '{"path":"a.ts"}', providerMetadata: META }),
      w.finish('tool_use'),
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'let me look' },
      { type: 'text_done' },
      {
        type: 'tool_call',
        id: 'c1',
        name: 'read',
        input: { path: 'a.ts' },
        providerMetadata: META,
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it.each(['', '  '])('treats empty input %j as {}', (rawInput) => {
    const events = run((w) => [
      w.toolCall({ id: 'c', name: 'now', rawInput }),
      w.finish('tool_use'),
    ]);
    expect(events[0]).toEqual({ type: 'tool_call', id: 'c', name: 'now', input: {} });
  });

  it('reports invalid JSON with the raw input', () => {
    const events = run((w) => [
      w.toolCall({ id: 'c', name: 'f', rawInput: '{"a":' }),
      w.finish('tool_use'),
    ]);
    expect(events[0]).toEqual({
      type: 'tool_call_invalid',
      id: 'c',
      name: 'f',
      rawInput: '{"a":',
      reason: 'invalid_json',
    });
  });

  it.each(['[1]', '"s"', '3', 'null'])('reports non-object input %s', (rawInput) => {
    const events = run((w) => [w.toolCall({ id: 'c', name: 'f', rawInput }), w.finish('tool_use')]);
    expect(events[0]).toMatchObject({ type: 'tool_call_invalid', reason: 'not_an_object' });
  });

  it('reports a call cut off by max_tokens as truncated and forces max_tokens', () => {
    const events = run((w) => [
      w.toolCall({ id: 'c', name: 'f', rawInput: '{"a":"b"}', truncated: true }),
      w.finish('tool_use'),
    ]);
    expect(events).toEqual([
      { type: 'tool_call_invalid', id: 'c', name: 'f', rawInput: '{"a":"b"}', reason: 'truncated' },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
  });

  it('truncates rawInput to 4 KiB', () => {
    const rawInput = `{"content":"${'🙂'.repeat(3000)}`;
    const [event] = run((w) => [
      w.toolCall({ id: 'c', name: 'f', rawInput }),
      w.finish('tool_use'),
    ]);
    expect(event?.type).toBe('tool_call_invalid');
    if (event?.type === 'tool_call_invalid') {
      expect(new TextEncoder().encode(event.rawInput).length).toBeLessThanOrEqual(4096);
    }
  });

  it('makes missing and duplicate ids unique, and names a nameless call', () => {
    const events = run((w) => [
      w.toolCall({ id: 'dup', name: 'a', rawInput: '{}' }),
      w.toolCall({ id: 'dup', name: 'b', rawInput: '{}' }),
      w.toolCall({ id: '', name: 'c', rawInput: '{}' }),
      w.toolCall({ id: 'x', name: '', rawInput: '{}' }),
      w.finish('tool_use'),
    ]);
    const tools = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_call_invalid');
    const ids = tools.map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe('dup');
    expect(tools[3]).toMatchObject({ type: 'tool_call', name: UNNAMED_TOOL });
  });

  it('keeps parallel calls consecutive', () => {
    const events = run((w) => [
      w.toolCall({ id: 'a', name: 'f', rawInput: '{}' }),
      w.toolCall({ id: 'b', name: 'g', rawInput: '{"x":1}' }),
      w.finish('tool_use'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'done']);
  });
});

describe('createEventWriter: stop reasons', () => {
  it('reports tool_use when calls were emitted even if the vendor said end_turn', () => {
    const events = run((w) => [
      w.toolCall({ id: 'a', name: 'f', rawInput: '{}' }),
      w.finish('end_turn'),
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('reports end_turn when the vendor said tool_use but no call was emitted', () => {
    const events = run((w) => [w.textDelta('x'), w.finish('tool_use')]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('keeps max_tokens and refusal as reported', () => {
    expect(run((w) => [w.finish('refusal')])).toEqual([{ type: 'done', stopReason: 'refusal' }]);
    expect(
      run((w) => [w.toolCall({ id: 'a', name: 'f', rawInput: '{}' }), w.finish('max_tokens')]).at(
        -1,
      ),
    ).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });
});

describe('createEventWriter: usage and terminals', () => {
  it('merges usage updates, last value wins, and emits it once before done', () => {
    const events = run((w) => {
      w.usage({ inputTokens: 10, cacheReadTokens: 4 });
      w.usage({ outputTokens: 1 });
      w.usage({ outputTokens: 7 });
      return [w.textDelta('a'), w.finish('end_turn')];
    });
    expect(events.slice(-2)).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 7, cacheReadTokens: 4 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('clamps negative, fractional and non-finite counts', () => {
    const events = run((w) => {
      w.usage({ inputTokens: -5, outputTokens: 2.4, reasoningTokens: Number.NaN });
      return [w.finish('end_turn')];
    });
    expect(events[0]).toEqual({ type: 'usage', inputTokens: 0, outputTokens: 2 });
  });

  it('emits usage before an error terminal and leaves an open part unclosed', () => {
    const error = providerError('network', 'anthropic');
    const events = run((w) => {
      w.usage({ inputTokens: 3 });
      return [w.textDelta('partial'), w.fail(error)];
    });
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'usage', inputTokens: 3, outputTokens: 0 },
      { type: 'error', error },
    ]);
  });

  it('omits usage when the vendor reported none', () => {
    expect(run((w) => [w.finish('end_turn')])).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
  });

  it('ignores everything after the terminal event', () => {
    const writer = createEventWriter();
    const events = [
      writer.finish('end_turn'),
      writer.textDelta('late'),
      writer.toolCall({ id: 'a', name: 'f', rawInput: '{}' }),
      writer.fail(providerError('network', 'anthropic')),
      writer.finish('end_turn'),
    ].flat();
    expect(events).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
    expect(writer.finished).toBe(true);
  });

  it('tracks whether any event reached the consumer, for the retry rule', () => {
    const writer = createEventWriter();
    expect(writer.started).toBe(false);
    writer.usage({ inputTokens: 1 });
    writer.textDelta('');
    expect(writer.started).toBe(false);
    writer.textDelta('a');
    expect(writer.started).toBe(true);
  });
});
