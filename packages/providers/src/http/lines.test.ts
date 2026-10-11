import { describe, expect, it } from 'vitest';
import { createLineDecoder } from './lines.ts';

const encoder = new TextEncoder();

function decodeAll(chunks: readonly Uint8Array[], maxLineLength = 1024): string[] {
  const decoder = createLineDecoder({ maxLineLength });
  const lines: string[] = [];
  for (const chunk of chunks) {
    const result = decoder.push(chunk);
    if (!result.ok) throw new Error(`unexpected ${result.error.kind}`);
    lines.push(...result.value);
  }
  lines.push(...decoder.end());
  return lines;
}

function splitAt(bytes: Uint8Array, ...points: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const point of points) {
    chunks.push(bytes.slice(start, point));
    start = point;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

describe('createLineDecoder', () => {
  it('splits on LF, CR and CRLF', () => {
    expect(decodeAll([encoder.encode('a\nb\rc\r\nd\n')])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps empty lines, which SSE uses as event boundaries', () => {
    expect(decodeAll([encoder.encode('a\n\nb\r\n\r\n')])).toEqual(['a', '', 'b', '']);
  });

  it('treats CRLF split across chunks as one line break', () => {
    expect(decodeAll(splitAt(encoder.encode('a\r\nb\n'), 2))).toEqual(['a', 'b']);
  });

  it('treats CR then CR as two line breaks even across chunks', () => {
    expect(decodeAll(splitAt(encoder.encode('a\r\rb\n'), 2))).toEqual(['a', '', 'b']);
  });

  it('emits a lone CR at a chunk end as soon as the next chunk shows it is not CRLF', () => {
    const decoder = createLineDecoder({ maxLineLength: 1024 });
    const first = decoder.push(encoder.encode('a\r'));
    expect(first).toEqual({ ok: true, value: ['a'] });
    expect(decoder.push(encoder.encode('\nb\n'))).toEqual({ ok: true, value: ['b'] });
  });

  it('reassembles a multi-byte UTF-8 character split across chunks', () => {
    const bytes = encoder.encode('héllo 🙂\n');
    for (let point = 1; point < bytes.length; point += 1) {
      expect(decodeAll(splitAt(bytes, point))).toEqual(['héllo 🙂']);
    }
  });

  it('strips a leading byte order mark only at the start of the stream', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = encoder.encode('a\n﻿b\n');
    expect(decodeAll([bom, body])).toEqual(['a', '﻿b']);
  });

  it('flushes a final line without a terminator on end()', () => {
    expect(decodeAll([encoder.encode('a\nb')])).toEqual(['a', 'b']);
  });

  it('flushes nothing on end() after a trailing terminator', () => {
    expect(decodeAll([encoder.encode('a\r')])).toEqual(['a']);
  });

  it('replaces invalid UTF-8 instead of throwing', () => {
    expect(decodeAll([new Uint8Array([0x61, 0xff, 0x0a])])).toEqual(['a�']);
  });

  it('rejects a partial line longer than the limit, before the line completes', () => {
    const decoder = createLineDecoder({ maxLineLength: 4 });
    expect(decoder.push(encoder.encode('abc')).ok).toBe(true);
    expect(decoder.push(encoder.encode('de'))).toEqual({
      ok: false,
      error: { kind: 'line_too_long' },
    });
  });

  it('rejects a complete line longer than the limit', () => {
    const decoder = createLineDecoder({ maxLineLength: 4 });
    expect(decoder.push(encoder.encode('abcde\n'))).toEqual({
      ok: false,
      error: { kind: 'line_too_long' },
    });
  });

  it('accepts a line exactly at the limit', () => {
    expect(decodeAll([encoder.encode('abcd\n')], 4)).toEqual(['abcd']);
  });

  it('stays failed after an error', () => {
    const decoder = createLineDecoder({ maxLineLength: 2 });
    expect(decoder.push(encoder.encode('abc')).ok).toBe(false);
    expect(decoder.push(encoder.encode('\n')).ok).toBe(false);
  });

  it('yields the same lines for every two- and three-way split of the input', () => {
    const bytes = encoder.encode('data: é\r\n\r\n: c\rx\n\ny🙂\r\rz');
    const expected = decodeAll([bytes]);
    for (let i = 0; i <= bytes.length; i += 1) {
      expect(decodeAll(splitAt(bytes, i))).toEqual(expected);
      for (let j = i; j <= bytes.length; j += 1) {
        expect(decodeAll(splitAt(bytes, i, j))).toEqual(expected);
      }
    }
  });
});
