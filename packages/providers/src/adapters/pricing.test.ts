import { describe, expect, it } from 'vitest';
import { usdPerMTok } from './pricing.ts';

describe('usdPerMTok', () => {
  it('converts USD per MTok to integer micros without float drift', () => {
    expect(usdPerMTok({ input: 0.15, output: 0.6, cacheRead: 0.075 })).toEqual({
      input: 150_000,
      output: 600_000,
      cacheRead: 75_000,
    });
    expect(usdPerMTok({ input: 1.1, output: 4.4, cacheWrite: 1.375 })).toEqual({
      input: 1_100_000,
      output: 4_400_000,
      cacheWrite: 1_375_000,
    });
  });
});
