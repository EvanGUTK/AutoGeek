import { describe, expect, it } from 'vitest';
import { JsonObjectSchema, JsonValueSchema } from './json.ts';

describe('JsonValueSchema', () => {
  it.each([
    ['string', 'a'],
    ['number', 1.5],
    ['boolean', false],
    ['null', null],
    ['array', [1, 'a', null, [true]]],
    ['nested object', { a: { b: [1, { c: null }] } }],
  ])('accepts %s', (_name, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['object containing undefined', { a: undefined }],
    ['Map', new Map()],
  ])('rejects %s', (_name, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
  });

  it('survives a JSON round trip unchanged', () => {
    const value = { a: [1, 'b', { c: null }], d: true };
    const parsed = JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
  });
});

describe('JsonObjectSchema', () => {
  it('accepts plain objects', () => {
    expect(JsonObjectSchema.safeParse({ a: 1, b: { c: [] } }).success).toBe(true);
    expect(JsonObjectSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['array', [1]],
    ['string', 'x'],
    ['null', null],
    ['number', 3],
  ])('rejects %s', (_name, value) => {
    expect(JsonObjectSchema.safeParse(value).success).toBe(false);
  });
});
