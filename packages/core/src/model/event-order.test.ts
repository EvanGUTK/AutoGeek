import { describe, expect, it } from 'vitest';
import type { ModelEvent } from './event.ts';
import { checkModelEventOrder } from './event-order.ts';
import { providerError } from './provider-error.ts';

const textDelta = (text: string): ModelEvent => ({ type: 'text_delta', text });
const textDone: ModelEvent = { type: 'text_done' };
const reasoningDelta = (text: string): ModelEvent => ({ type: 'reasoning_delta', text });
const reasoningDone: ModelEvent = { type: 'reasoning_done', text: 'hmm' };
const call = (id: string): ModelEvent => ({ type: 'tool_call', id, name: 'read_file', input: {} });
const invalid = (
  id: string,
  reason: 'invalid_json' | 'not_an_object' | 'truncated',
): ModelEvent => ({
  type: 'tool_call_invalid',
  id,
  name: 'read_file',
  rawInput: '{',
  reason,
});
const usage: ModelEvent = { type: 'usage', inputTokens: 1, outputTokens: 1 };
const done = (stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'): ModelEvent => ({
  type: 'done',
  stopReason,
});
const failed: ModelEvent = { type: 'error', error: providerError('network', 'p') };

const rules = (events: readonly ModelEvent[]): string[] =>
  checkModelEventOrder(events).map((violation) => violation.rule);

describe('checkModelEventOrder: valid streams', () => {
  it.each([
    ['a plain text answer', [textDelta('a'), textDelta('b'), textDone, usage, done('end_turn')]],
    ['an empty text part (done with no deltas)', [textDone, done('end_turn')]],
    [
      'reasoning, then text, then parallel tool calls',
      [
        reasoningDelta('x'),
        reasoningDone,
        textDelta('t'),
        textDone,
        call('a'),
        call('b'),
        usage,
        done('tool_use'),
      ],
    ],
    ['a stream with no usage (local servers)', [textDelta('a'), textDone, done('end_turn')]],
    ['a refusal', [textDelta('no'), textDone, done('refusal')]],
    [
      'a truncated tool call stopped by max_tokens',
      [invalid('a', 'truncated'), usage, done('max_tokens')],
    ],
    [
      'an invalid call among valid ones',
      [call('a'), invalid('b', 'not_an_object'), done('tool_use')],
    ],
    ['a stream that fails immediately', [failed]],
    ['usage reported before a failure', [textDelta('a'), textDone, usage, failed]],
    ['an error that cuts a text part short', [textDelta('a'), failed]],
  ])('accepts %s', (_name, events) => {
    expect(checkModelEventOrder(events)).toEqual([]);
  });
});

describe('checkModelEventOrder: terminal event', () => {
  it('requires a terminal event', () => {
    expect(rules([textDelta('a'), textDone])).toContain('terminal');
    expect(rules([])).toContain('terminal');
  });

  it('allows exactly one terminal event, never two', () => {
    expect(rules([done('end_turn'), failed])).toContain('after-terminal');
    expect(rules([done('end_turn'), done('end_turn')])).toContain('after-terminal');
  });

  it('allows nothing after the terminal event', () => {
    expect(rules([done('end_turn'), textDelta('late')])).toContain('after-terminal');
    expect(rules([failed, usage])).toContain('after-terminal');
  });
});

describe('checkModelEventOrder: parts are sequential, never interleaved', () => {
  it('rejects reasoning deltas inside an open text part', () => {
    expect(
      rules([textDelta('a'), reasoningDelta('x'), reasoningDone, textDone, done('end_turn')]),
    ).toContain('interleaved');
  });

  it('rejects text deltas inside an open reasoning part', () => {
    expect(
      rules([reasoningDelta('x'), textDelta('a'), textDone, reasoningDone, done('end_turn')]),
    ).toContain('interleaved');
  });

  it('rejects a tool call inside an open text part', () => {
    expect(rules([textDelta('a'), call('a'), textDone, done('tool_use')])).toContain('interleaved');
  });

  it('rejects closing a part of the other kind', () => {
    expect(rules([textDelta('a'), reasoningDone, done('end_turn')])).toContain('interleaved');
    expect(rules([reasoningDelta('a'), textDone, done('end_turn')])).toContain('interleaved');
  });

  it('rejects a part left open when the stream ends normally', () => {
    expect(rules([textDelta('a'), done('end_turn')])).toContain('unclosed-part');
    expect(rules([reasoningDelta('a'), done('end_turn')])).toContain('unclosed-part');
  });
});

describe('checkModelEventOrder: tool calls', () => {
  it('requires unique ids across tool_call and tool_call_invalid', () => {
    expect(rules([call('a'), call('a'), done('tool_use')])).toContain('duplicate-tool-id');
    expect(rules([call('a'), invalid('a', 'invalid_json'), done('tool_use')])).toContain(
      'duplicate-tool-id',
    );
  });

  it('requires tool_use to follow at least one tool event', () => {
    expect(rules([textDelta('a'), textDone, done('tool_use')])).toContain('stop-reason');
  });

  it('requires a truncated tool call to end with max_tokens', () => {
    expect(rules([invalid('a', 'truncated'), done('tool_use')])).toContain('stop-reason');
    expect(rules([invalid('a', 'truncated'), done('end_turn')])).toContain('stop-reason');
  });
});

describe('checkModelEventOrder: usage', () => {
  it('allows usage at most once, and reports the second one', () => {
    const violations = checkModelEventOrder([usage, usage, done('end_turn')]);
    expect(
      violations
        .filter((v) => v.rule === 'usage' && v.detail.includes('at most once'))
        .map((v) => v.index),
    ).toEqual([1]);
  });

  it('requires usage immediately before the terminal event', () => {
    expect(rules([usage, textDelta('a'), textDone, done('end_turn')])).toContain('usage');
  });

  it('reports the index of each violation', () => {
    const violations = checkModelEventOrder([done('end_turn'), textDelta('late')]);
    expect(violations.map((v) => v.index)).toEqual([1]);
  });
});
