import { describe, expect, it } from 'vitest';
import { openaiProfile } from './models.ts';

describe('openaiProfile', () => {
  it('knows current models with integer-micros pricing (long-context tier)', () => {
    expect(openaiProfile('gpt-6.1-sol')).toMatchObject({
      contextWindow: 922_000,
      maxOutputTokens: 128_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      pricing: { input: 4_000_000, cacheRead: 200_000, cacheWrite: 5_000_000, output: 15_000_000 },
    });
  });

  it('maps dated snapshots to their alias', () => {
    expect(openaiProfile('gpt-5.4-mini-2026-03-17')?.displayName).toBe('GPT-5.4 mini');
  });

  it('does not confuse gpt-5 with longer ids', () => {
    expect(openaiProfile('gpt-5')?.displayName).toBe('GPT-5');
    expect(openaiProfile('gpt-5.5')?.displayName).toBe('GPT-5.5');
  });

  it('treats unknown reasoning-family ids conservatively', () => {
    expect(openaiProfile('gpt-6.2-nova')).toEqual({
      displayName: 'gpt-6.2-nova',
      contextWindow: null,
      maxOutputTokens: null,
      reasoning: true,
      efforts: ['low', 'medium', 'high'],
      vision: 'unknown',
    });
  });

  it('knows nothing about non-reasoning models', () => {
    expect(openaiProfile('gpt-4.1')).toBeUndefined();
    expect(openaiProfile('gpt-50')).toBeUndefined();
  });
});
