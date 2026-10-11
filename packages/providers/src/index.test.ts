import { describe, expect, it } from 'vitest';
import * as publicApi from './index.ts';

describe('@autogeek/providers', () => {
  it('loads and has an empty public surface until its owner adds one', () => {
    expect(Object.keys(publicApi)).toEqual([]);
  });
});
