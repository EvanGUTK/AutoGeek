import { describe, expect, it } from 'vitest';
import { colorTokens, SURFACE_NAMES, type ColorTokens, type ThemeName } from './colors.ts';
import { contrastRatio, mixHex } from './contrast.ts';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/** The foreground tokens that must reach 4.5:1 on every surface at rest (docs/ui-spec.md §2.2). */
const TEXT_ON_SURFACES = [
  'text',
  'textMuted',
  'textSubtle',
  'accent',
  'danger',
  'warning',
  'success',
  'info',
] as const satisfies readonly (keyof ColorTokens)[];

/** The minimum contrast the UI spec states for each token over its five surfaces. */
const STATED_MINIMUM: Record<ThemeName, Record<(typeof TEXT_ON_SURFACES)[number], number>> = {
  dark: {
    text: 10.75,
    textMuted: 5.6,
    textSubtle: 4.61,
    accent: 5.46,
    danger: 5.77,
    warning: 7.95,
    success: 7.19,
    info: 7.02,
  },
  light: {
    text: 13.13,
    textMuted: 6.17,
    textSubtle: 4.61,
    accent: 4.7,
    danger: 5.09,
    warning: 4.61,
    success: 4.88,
    info: 5.26,
  },
};

function minimumOverSurfaces(theme: ThemeName, token: keyof ColorTokens): number {
  const tokens = colorTokens[theme];
  return Math.min(...SURFACE_NAMES.map((surface) => contrastRatio(tokens[token], tokens[surface])));
}

describe('colour tokens', () => {
  it.each(THEMES)('%s: every value is a #rrggbb colour', (theme) => {
    for (const [name, value] of Object.entries(colorTokens[theme])) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has five surfaces, including the selected-row surface', () => {
    expect(SURFACE_NAMES).toEqual(['bg', 'surface', 'raised', 'overlay', 'selected']);
  });

  it.each(THEMES)('%s: dark and light differ, so a theme switch changes the page', (theme) => {
    const other: ThemeName = theme === 'dark' ? 'light' : 'dark';
    expect(colorTokens[theme].bg).not.toBe(colorTokens[other].bg);
    expect(colorTokens[theme].text).not.toBe(colorTokens[other].text);
  });
});

describe.each(THEMES)('%s theme contrast at rest', (theme) => {
  it.each(TEXT_ON_SURFACES)('%s reaches 4.5:1 on every surface', (token) => {
    expect(minimumOverSurfaces(theme, token)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TEXT_ON_SURFACES)('%s matches the minimum stated in the UI spec', (token) => {
    expect(minimumOverSurfaces(theme, token)).toBeCloseTo(STATED_MINIMUM[theme][token], 1);
  });

  it('border-strong reaches 3:1 on every surface (non-text contrast)', () => {
    expect(minimumOverSurfaces(theme, 'borderStrong')).toBeGreaterThanOrEqual(3);
  });

  it('the focus ring reaches 3:1 on every surface', () => {
    expect(minimumOverSurfaces(theme, 'focus')).toBeGreaterThanOrEqual(3);
  });

  it('text on an accent fill reaches 4.5:1', () => {
    const tokens = colorTokens[theme];
    expect(contrastRatio(tokens.onAccent, tokens.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('text on the hovered accent fill reaches 4.5:1', () => {
    const tokens = colorTokens[theme];
    expect(contrastRatio(tokens.onAccent, tokens.accentHover)).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(THEMES)('%s theme contrast in hover and pressed states', (theme) => {
  const tokens = colorTokens[theme];
  const TINTS = [0, 0.08, 0.14] as const;
  const statefulSurfaces = SURFACE_NAMES.flatMap((surface) =>
    TINTS.map((alpha) => ({
      label: `${surface} at ${String(Math.round(alpha * 100))}%`,
      background: mixHex(tokens[surface], tokens.text, alpha),
    })),
  );

  it.each(statefulSurfaces)(
    'text and the status state variants reach 4.5:1 on $label',
    ({ background }) => {
      for (const token of [
        'text',
        'dangerState',
        'warningState',
        'successState',
        'infoState',
      ] as const) {
        expect(contrastRatio(tokens[token], background), token).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(statefulSurfaces)(
    'the strong-border state variant reaches 3:1 on $label',
    ({ background }) => {
      expect(contrastRatio(tokens.borderStrongState, background)).toBeGreaterThanOrEqual(3);
    },
  );
});
