import { describe, expect, it } from 'vitest';
import { CoreErrorSchema } from './errors.ts';
import { JSON_MAX_DEPTH, JSON_MAX_NODES, JsonObjectSchema, JsonValueSchema } from './json.ts';

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

/** An array nested `levels` deep around one primitive, built iteratively (no recursion). */
function nestedArrays(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i += 1) {
    value = [value];
  }
  return value;
}

function nestedObjects(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i += 1) {
    value = { k: value };
  }
  return value;
}

describe('untrusted JSON is bounded and validation never throws (review K1)', () => {
  it('has the documented named limits', () => {
    expect(JSON_MAX_DEPTH).toBe(64);
    expect(JSON_MAX_NODES).toBe(100_000);
  });

  it('accepts nesting up to exactly the depth limit and rejects one level more', () => {
    expect(JsonValueSchema.safeParse(nestedArrays(JSON_MAX_DEPTH)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nestedArrays(JSON_MAX_DEPTH + 1)).success).toBe(false);
    expect(JsonValueSchema.safeParse(nestedObjects(JSON_MAX_DEPTH)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nestedObjects(JSON_MAX_DEPTH + 1)).success).toBe(false);
  });

  it.each([2_000, 100_000, 1_000_000])(
    'rejects nesting %i deep with an issue, not a throw',
    (levels) => {
      const arrays = JsonValueSchema.safeParse(nestedArrays(levels));
      const objects = JsonValueSchema.safeParse(nestedObjects(levels));
      expect(arrays.success).toBe(false);
      expect(objects.success).toBe(false);
      expect(arrays.error?.issues[0]?.message).toMatch(/deeper than 64/);
    },
  );

  it('applies the same bound to JsonObjectSchema and CoreError details', () => {
    const deep = nestedObjects(100_000);
    expect(JsonObjectSchema.safeParse({ a: deep }).success).toBe(false);
    const error = { code: 'internal', message: 'An internal error occurred.', details: deep };
    expect(() => CoreErrorSchema.safeParse(error)).not.toThrow();
    expect(CoreErrorSchema.safeParse(error).success).toBe(false);
  });

  it('accepts a wide object up to the node limit and rejects it beyond', () => {
    const wide = (keys: number): Record<string, number> => {
      const object: Record<string, number> = {};
      for (let i = 0; i < keys; i += 1) {
        object[`k${String(i)}`] = i;
      }
      return object;
    };
    // The root counts as one node, so JSON_MAX_NODES - 1 keys is the largest accepted object.
    expect(JsonValueSchema.safeParse(wide(JSON_MAX_NODES - 1)).success).toBe(true);
    const tooWide = JsonValueSchema.safeParse(wide(JSON_MAX_NODES));
    expect(tooWide.success).toBe(false);
    expect(tooWide.error?.issues[0]?.message).toMatch(/more than 100000 nodes/);
  });

  it('rejects a long array and a huge sparse array without iterating it', () => {
    expect(JsonValueSchema.safeParse(new Array<number>(JSON_MAX_NODES).fill(0)).success).toBe(
      false,
    );
    const started = Date.now();
    expect(JsonValueSchema.safeParse(new Array<number>(4_000_000_000)).success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects a cyclic array or object instead of looping or overflowing', () => {
    const array: unknown[] = [];
    array.push(array);
    const object: Record<string, unknown> = {};
    object['self'] = object;
    expect(JsonValueSchema.safeParse(array).success).toBe(false);
    expect(JsonValueSchema.safeParse(object).success).toBe(false);
    expect(JsonObjectSchema.safeParse(object).success).toBe(false);
  });

  it('rejects an exponentially shared structure by its node count, quickly', () => {
    let shared: unknown = 1;
    for (let i = 0; i < 50; i += 1) {
      shared = [shared, shared];
    }
    const started = Date.now();
    expect(JsonValueSchema.safeParse(shared).success).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects arrays with holes and values JSON cannot hold', () => {
    const holey = [1, 2, 3];
    Reflect.deleteProperty(holey, 1);
    expect(JsonValueSchema.safeParse(holey).success).toBe(false);
  });

  it('only accepts plain objects: no class instances, Maps, or Dates at the root or inside', () => {
    class Point {
      readonly x = 1;
    }
    expect(JsonValueSchema.safeParse(new Point()).success).toBe(false);
    expect(JsonValueSchema.safeParse({ a: new Point() }).success).toBe(false);
    expect(JsonObjectSchema.safeParse(new Point()).success).toBe(false);
    expect(JsonObjectSchema.safeParse(Object.create(null)).success).toBe(true);
  });

  it('never echoes the rejected value in an issue message', () => {
    const secret = 'sk-live-SUPERSECRET';
    const result = JsonValueSchema.safeParse({ key: secret, bad: undefined });
    expect(JSON.stringify(result.error?.issues)).not.toContain(secret);
  });

  it('rejects accessor properties: a getter could return a different value after validation (review D3)', () => {
    const withGetter = {};
    Object.defineProperty(withGetter, 'a', { get: () => 1, enumerable: true });
    const withSetter = {};
    Object.defineProperty(withSetter, 'a', { set: () => undefined, enumerable: true });
    expect(JsonValueSchema.safeParse(withGetter).success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: withGetter }).success).toBe(false);
    expect(JsonObjectSchema.safeParse(withGetter).success).toBe(false);
    expect(JsonValueSchema.safeParse(withSetter).success).toBe(false);
  });

  it('rejects an accessor on an array index too', () => {
    const array = [1, 2, 3];
    Object.defineProperty(array, 1, { get: () => 2, enumerable: true });
    expect(JsonValueSchema.safeParse(array).success).toBe(false);
  });

  it('never invokes a getter while validating', () => {
    let calls = 0;
    const trap = {};
    Object.defineProperty(trap, 'a', {
      get: () => {
        calls += 1;
        return 1;
      },
      enumerable: true,
    });
    JsonValueSchema.safeParse(trap);
    expect(calls).toBe(0);
  });
});
