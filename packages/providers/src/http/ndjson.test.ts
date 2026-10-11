import { describe, expect, it } from 'vitest';
import { createNdjsonDecoder } from './ndjson.ts';

const encoder = new TextEncoder();
const LIMITS = { maxLineLength: 1024 };

describe('createNdjsonDecoder', () => {
  it('parses one JSON value per line and skips blank lines', () => {
    const decoder = createNdjsonDecoder(LIMITS);
    expect(decoder.push(encoder.encode('{"a":1}\n\n{"b":"é"}\r\n'))).toEqual({
      ok: true,
      value: [{ a: 1 }, { b: 'é' }],
    });
    expect(decoder.end()).toEqual({ ok: true, value: [] });
  });

  it('parses a final line without a trailing newline on end()', () => {
    const decoder = createNdjsonDecoder(LIMITS);
    expect(decoder.push(encoder.encode('{"a":1}\n{"done":tr'))).toEqual({
      ok: true,
      value: [{ a: 1 }],
    });
    expect(decoder.push(encoder.encode('ue}'))).toEqual({ ok: true, value: [] });
    expect(decoder.end()).toEqual({ ok: true, value: [{ done: true }] });
  });

  it('reports invalid JSON instead of throwing', () => {
    const decoder = createNdjsonDecoder(LIMITS);
    expect(decoder.push(encoder.encode('{"a":\n'))).toEqual({
      ok: false,
      error: { kind: 'invalid_json' },
    });
  });

  it('reports a truncated final line as invalid JSON', () => {
    const decoder = createNdjsonDecoder(LIMITS);
    decoder.push(encoder.encode('{"a":'));
    expect(decoder.end()).toEqual({ ok: false, error: { kind: 'invalid_json' } });
  });

  it('enforces the line limit', () => {
    const decoder = createNdjsonDecoder({ maxLineLength: 4 });
    expect(decoder.push(encoder.encode('{"ab":1}\n'))).toEqual({
      ok: false,
      error: { kind: 'line_too_long' },
    });
  });

  it('stays failed after an error', () => {
    const decoder = createNdjsonDecoder(LIMITS);
    expect(decoder.push(encoder.encode('nope\n')).ok).toBe(false);
    expect(decoder.push(encoder.encode('{}\n')).ok).toBe(false);
    expect(decoder.end().ok).toBe(false);
  });

  it('yields the same values for every split point', () => {
    const bytes = encoder.encode('{"message":{"content":"🙂"}}\n{"done":true}\n');
    for (let i = 0; i <= bytes.length; i += 1) {
      const decoder = createNdjsonDecoder(LIMITS);
      const values: unknown[] = [];
      for (const chunk of [bytes.slice(0, i), bytes.slice(i)]) {
        const result = decoder.push(chunk);
        expect(result.ok).toBe(true);
        if (result.ok) values.push(...result.value);
      }
      expect(values).toEqual([{ message: { content: '🙂' } }, { done: true }]);
    }
  });
});
