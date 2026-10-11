import { describe, expect, it } from 'vitest';
import { anthropicProfile } from './models.ts';

describe('anthropicProfile', () => {
  it('knows current models', () => {
    expect(anthropicProfile('claude-opus-5-5')).toMatchObject({
      adaptiveThinking: true,
      midConversationSystem: true,
      pricing: { input: 4_000_000, output: 20_000_000, cacheRead: 200_000, cacheWrite: 5_000_000 },
    });
  });

  it('does not confuse a model with a longer id that shares its prefix', () => {
    expect(anthropicProfile('claude-opus-5')?.displayName).toBe('Claude Opus 5');
    expect(anthropicProfile('claude-opus-5-5')?.displayName).toBe('Claude Opus 5.5');
  });

  it('maps a dated snapshot to its alias', () => {
    expect(anthropicProfile('claude-haiku-4-5-20251001')?.displayName).toBe('Claude Haiku 4.5');
  });

  it('returns undefined for unknown models, including unknown versions of a known line', () => {
    expect(anthropicProfile('claude-opus-5-7')).toBeUndefined();
    expect(anthropicProfile('claude-opus-5-5-preview')).toBeUndefined();
    expect(anthropicProfile('gpt-5')).toBeUndefined();
  });

  it('keeps pricing in integer micros', () => {
    const pricing = anthropicProfile('claude-fable-5-1')?.pricing;
    expect(pricing).toEqual({
      input: 10_000_000,
      output: 50_000_000,
      cacheRead: 250_000,
      cacheWrite: 12_500_000,
    });
  });
});
