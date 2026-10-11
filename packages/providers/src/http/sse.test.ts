import { describe, expect, it } from 'vitest';
import { createSseDecoder } from './sse.ts';
import type { SseEvent } from './sse.ts';

const encoder = new TextEncoder();
const LIMITS = { maxLineLength: 1024, maxEventLength: 1024 };

function decodeAll(chunks: readonly Uint8Array[], limits = LIMITS): SseEvent[] {
  const decoder = createSseDecoder(limits);
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const result = decoder.push(chunk);
    if (!result.ok) throw new Error(`unexpected ${result.error.kind}`);
    events.push(...result.value);
  }
  return events;
}

function decodeText(text: string): SseEvent[] {
  return decodeAll([encoder.encode(text)]);
}

describe('createSseDecoder', () => {
  it('dispatches an event on a blank line with the default type "message"', () => {
    expect(decodeText('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('uses the event field as the type and resets it after dispatch', () => {
    expect(decodeText('event: ping\ndata: 1\n\ndata: 2\n\n')).toEqual([
      { event: 'ping', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });

  it('joins multi-line data with LF', () => {
    expect(decodeText('data: a\ndata: b\ndata:\n\n')).toEqual([
      { event: 'message', data: 'a\nb\n' },
    ]);
  });

  it('removes exactly one leading space from a value', () => {
    expect(decodeText('data:  two\n\ndata:none\n\n')).toEqual([
      { event: 'message', data: ' two' },
      { event: 'message', data: 'none' },
    ]);
  });

  it('ignores comments, unknown fields, id and retry', () => {
    expect(decodeText(': keep-alive\nid: 7\nretry: 10\nfoo: bar\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('treats a line without a colon as a field with an empty value', () => {
    expect(decodeText('data\n\n')).toEqual([{ event: 'message', data: '' }]);
  });

  it('does not dispatch an event that has no data field', () => {
    expect(decodeText('event: ping\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('accepts CR and CRLF line endings', () => {
    expect(decodeText('event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('keeps colons after the first one in the value', () => {
    expect(decodeText('data: {"a":"b:c"}\n\n')).toEqual([
      { event: 'message', data: '{"a":"b:c"}' },
    ]);
  });

  it('never dispatches an event cut off by the end of the stream', () => {
    const decoder = createSseDecoder(LIMITS);
    expect(decoder.push(encoder.encode('data: a\n\ndata: partial\n'))).toEqual({
      ok: true,
      value: [{ event: 'message', data: 'a' }],
    });
    expect(decoder.end()).toEqual({ incompleteEvent: true });
  });

  it('reports a clean end when nothing is pending', () => {
    const decoder = createSseDecoder(LIMITS);
    decoder.push(encoder.encode('data: a\n\n: trailing comment\n'));
    expect(decoder.end()).toEqual({ incompleteEvent: false });
  });

  it('fails when one event accumulates more data than the limit', () => {
    const decoder = createSseDecoder({ maxLineLength: 1024, maxEventLength: 8 });
    expect(decoder.push(encoder.encode('data: 1234\ndata: 567\n')).ok).toBe(true);
    expect(decoder.push(encoder.encode('data: 89\n'))).toEqual({
      ok: false,
      error: { kind: 'event_too_large' },
    });
  });

  it('fails on an over-long line', () => {
    const decoder = createSseDecoder({ maxLineLength: 8, maxEventLength: 1024 });
    expect(decoder.push(encoder.encode('data: 123456789'))).toEqual({
      ok: false,
      error: { kind: 'line_too_long' },
    });
  });

  it('stays failed after an error', () => {
    const decoder = createSseDecoder({ maxLineLength: 4, maxEventLength: 1024 });
    expect(decoder.push(encoder.encode('data: long\n')).ok).toBe(false);
    expect(decoder.push(encoder.encode('\n')).ok).toBe(false);
  });

  it('fails the whole chunk when any event in it exceeds the limit', () => {
    const decoder = createSseDecoder({ maxLineLength: 1024, maxEventLength: 4 });
    expect(decoder.push(encoder.encode('data: ok\n\ndata: toolong\n\n')).ok).toBe(false);
  });

  it('yields the same events for every two- and three-way split of a vendor-like stream', () => {
    const stream = encoder.encode(
      [
        ': OPENROUTER PROCESSING',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"text":"héllo 🙂"}}',
        '',
        'data: {"a":1}\r\ndata: {"b":2}\r\n\r\n',
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
    );
    const expected = decodeAll([stream]);
    expect(expected).toHaveLength(3);
    for (let i = 0; i <= stream.length; i += 1) {
      expect(decodeAll([stream.slice(0, i), stream.slice(i)])).toEqual(expected);
      for (let j = i; j <= stream.length; j += 7) {
        expect(decodeAll([stream.slice(0, i), stream.slice(i, j), stream.slice(j)])).toEqual(
          expected,
        );
      }
    }
  });

  it('decodes a byte-at-a-time stream', () => {
    const stream = encoder.encode('event: e\ndata: ünïcødé\n\n');
    const chunks = Array.from(stream, (byte) => new Uint8Array([byte]));
    expect(decodeAll(chunks)).toEqual([{ event: 'e', data: 'ünïcødé' }]);
  });
});
