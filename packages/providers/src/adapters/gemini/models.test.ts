import { describe, expect, it } from 'vitest';
import { geminiProfile, thinkingBudget } from './models.ts';

describe('geminiProfile', () => {
  it('lists the higher (2027) Flash price and the long-context Pro tier, in micros', () => {
    expect(geminiProfile('gemini-3.8-flash')?.pricing).toEqual({
      input: 1_500_000,
      output: 7_500_000,
      cacheRead: 150_000,
    });
    expect(geminiProfile('gemini-3.1-pro-preview')?.pricing).toEqual({
      input: 4_000_000,
      output: 18_000_000,
      cacheRead: 400_000,
    });
  });

  it('distinguishes level and budget thinking', () => {
    expect(geminiProfile('gemini-3.8-flash')?.thinking.kind).toBe('level');
    expect(geminiProfile('gemini-2.5-pro')?.thinking).toEqual({
      kind: 'budget',
      min: 128,
      max: 32_768,
    });
  });

  it('knows nothing about unknown ids', () => {
    expect(geminiProfile('gemini-9-ultra')).toBeUndefined();
  });
});

describe('thinkingBudget', () => {
  it('maps efforts and clamps to the model range', () => {
    expect(thinkingBudget('low', { min: 512, max: 24_576 })).toBe(1024);
    expect(thinkingBudget('medium', { min: 0, max: 24_576 })).toBe(8192);
    expect(thinkingBudget('max', { min: 128, max: 32_768 })).toBe(32_768);
    expect(thinkingBudget('low', { min: 2048, max: 4096 })).toBe(2048);
  });
});
