import { describe, expect, it } from 'vitest';
import {
  controlHeight,
  fontFamily,
  motion,
  motionDurationMs,
  radius,
  spacing,
  toRem,
  typography,
  zIndex,
} from './scales.ts';

describe('spacing', () => {
  it('follows the documented 4px-based scale', () => {
    expect(Object.values(spacing)).toEqual([0, 2, 4, 8, 12, 16, 24, 32, 48]);
  });

  it('is named space0 to space8 and strictly increasing', () => {
    expect(Object.keys(spacing)).toEqual([
      'space0',
      'space1',
      'space2',
      'space3',
      'space4',
      'space5',
      'space6',
      'space7',
      'space8',
    ]);
    const values = Object.values(spacing);
    expect(values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0))).toBe(
      true,
    );
  });
});

describe('toRem', () => {
  it('converts pixels against a 16px root so browser text scaling applies', () => {
    expect(toRem(16)).toBe('1rem');
    expect(toRem(13)).toBe('0.8125rem');
    expect(toRem(0)).toBe('0rem');
  });
});

describe('typography', () => {
  it('has the documented steps and sizes', () => {
    expect(typography).toEqual({
      xs: { size: 12, lineHeight: 16, weight: 400 },
      sm: { size: 13, lineHeight: 20, weight: 400 },
      md: { size: 14, lineHeight: 20, weight: 400 },
      lg: { size: 16, lineHeight: 24, weight: 600 },
      xl: { size: 20, lineHeight: 28, weight: 600 },
      monoSm: { size: 12, lineHeight: 18, weight: 400 },
      monoMd: { size: 13, lineHeight: 20, weight: 400 },
    });
  });

  it('never goes below 12px and always leaves room above the text size', () => {
    for (const [name, step] of Object.entries(typography)) {
      expect(step.size, name).toBeGreaterThanOrEqual(12);
      expect(step.lineHeight, name).toBeGreaterThan(step.size);
    }
  });
});

describe('font families', () => {
  it('uses system fonts only, ending in a generic family, with no web font reference', () => {
    expect(fontFamily.ui.endsWith('sans-serif')).toBe(true);
    expect(fontFamily.mono.endsWith('monospace')).toBe(true);
    for (const stack of Object.values(fontFamily)) {
      expect(stack).not.toMatch(/url\(|https?:/i);
    }
  });
});

describe('radius', () => {
  it('has the documented steps and a pill radius', () => {
    expect(radius).toEqual({ sm: 2, md: 4, lg: 8, full: 9999 });
  });
});

describe('motion', () => {
  it('has the documented durations and easing', () => {
    expect(motion.durationMs).toEqual({ fast: 100, base: 160, slow: 240 });
    expect(motion.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('resolves every duration to 0 when reduced motion is preferred', () => {
    expect(motionDurationMs('base', false)).toBe(160);
    expect(motionDurationMs('fast', true)).toBe(0);
    expect(motionDurationMs('base', true)).toBe(0);
    expect(motionDurationMs('slow', true)).toBe(0);
  });
});

describe('zIndex', () => {
  it('names the layers and orders them from base to toast', () => {
    expect(zIndex).toEqual({ base: 0, panel: 10, sticky: 20, overlay: 30, modal: 40, toast: 50 });
  });
});

describe('controlHeight', () => {
  it('keeps the compact control at the 24px target-size floor (WCAG 2.5.8)', () => {
    expect(controlHeight).toEqual({ default: 28, compact: 24 });
    expect(controlHeight.compact).toBeGreaterThanOrEqual(24);
  });
});
