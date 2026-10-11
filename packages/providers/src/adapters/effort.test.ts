import { describe, expect, it } from 'vitest';
import { nearestEffort } from './effort.ts';

describe('nearestEffort', () => {
  it('keeps a supported level', () => {
    expect(nearestEffort('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('xhigh');
  });

  it('prefers the closest lower level', () => {
    expect(nearestEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
  });

  it('falls back to the closest higher level', () => {
    expect(nearestEffort('low', ['high', 'max'])).toBe('high');
  });

  it('is undefined when the model takes no effort', () => {
    expect(nearestEffort('high', [])).toBeUndefined();
  });
});
