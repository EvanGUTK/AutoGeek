import { describe, expect, it } from 'vitest';
import { parseJsonOrUndefined } from './http-json.ts';

describe('parseJsonOrUndefined', () => {
  it('parses JSON and returns undefined for malformed text', () => {
    expect(parseJsonOrUndefined('{"a":[1]}')).toEqual({ a: [1] });
    expect(parseJsonOrUndefined('<html>')).toBeUndefined();
    expect(parseJsonOrUndefined('')).toBeUndefined();
  });
});
