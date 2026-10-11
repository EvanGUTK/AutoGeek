import { describe, expect, it } from 'vitest';
import { contrastRatio, mixHex, parseHex, relativeLuminance } from './contrast.ts';

describe('parseHex', () => {
  it('reads a six-digit hex colour into 0-255 channels', () => {
    expect(parseHex('#14161a')).toEqual({ r: 0x14, g: 0x16, b: 0x1a });
  });

  it('is case-insensitive', () => {
    expect(parseHex('#FFAA00')).toEqual(parseHex('#ffaa00'));
  });

  it.each(['', 'fff', '#fff', '#12345', '#1234567', '#gggggg', 'red', '#14161a '])(
    'rejects the malformed colour %j as a programmer error',
    (input) => {
      expect(() => parseHex(input)).toThrow(RangeError);
    },
  );
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white (WCAG 2.x)', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('is 1 for a colour on itself', () => {
    expect(contrastRatio('#6ea8ff', '#6ea8ff')).toBeCloseTo(1, 10);
  });

  it('does not depend on which colour is the foreground', () => {
    expect(contrastRatio('#e6e8ee', '#14161a')).toBe(contrastRatio('#14161a', '#e6e8ee'));
  });

  it('reproduces the figure in the UI spec for dark text on the dark background', () => {
    expect(contrastRatio('#e6e8ee', '#14161a')).toBeCloseTo(14.78, 2);
  });
});

describe('mixHex', () => {
  it('returns the base colour at alpha 0 and the overlay at alpha 1', () => {
    expect(mixHex('#14161a', '#e6e8ee', 0)).toBe('#14161a');
    expect(mixHex('#14161a', '#e6e8ee', 1)).toBe('#e6e8ee');
  });

  it('blends channel by channel and rounds to the nearest integer', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it.each([-0.01, 1.01, Number.NaN])('rejects the alpha %s as a programmer error', (alpha) => {
    expect(() => mixHex('#000000', '#ffffff', alpha)).toThrow(RangeError);
  });
});
