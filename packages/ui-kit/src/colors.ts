/** The two shipped themes. `system` is resolved to one of these by the theme resolver. */
export type ThemeName = 'dark' | 'light';

/**
 * Every colour token name, in the order they are emitted. Surfaces come first (text sits on them),
 * then foreground, the accent fill, lines, and finally the state variants: in hover, pressed and
 * selected+hover states the status colours and the strong border resolve to the `*State` ones,
 * because tinting a surface with `text` lowers contrast.
 */
export const COLOR_TOKEN_NAMES = [
  'bg',
  'surface',
  'raised',
  'overlay',
  'selected',
  'text',
  'textMuted',
  'textSubtle',
  'accent',
  'danger',
  'warning',
  'success',
  'info',
  'onAccent',
  'accentHover',
  'border',
  'borderStrong',
  'focus',
  'dangerState',
  'warningState',
  'successState',
  'infoState',
  'borderStrongState',
] as const;

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

/** Every colour token, as `#rrggbb`. `border` is decorative; `borderStrong` needs 3:1. */
export type ColorTokens = Readonly<Record<ColorTokenName, string>>;

/** The surfaces a foreground can sit on, in the order the UI spec lists them. */
export const SURFACE_NAMES = ['bg', 'surface', 'raised', 'overlay', 'selected'] as const;

/** Values are the ones measured in docs/ui-spec.md §2.2; colors.test.ts recomputes every figure. */
export const colorTokens: Readonly<Record<ThemeName, ColorTokens>> = {
  dark: {
    bg: '#14161a',
    surface: '#1b1e24',
    raised: '#232730',
    overlay: '#2a2f3a',
    selected: '#243049',
    text: '#e6e8ee',
    textMuted: '#a3a9b8',
    textSubtle: '#9199aa',
    accent: '#6ea8ff',
    danger: '#ff8a80',
    warning: '#f2c264',
    success: '#6fd39a',
    info: '#7cc4ff',
    onAccent: '#0b1220',
    accentHover: '#8ab8ff',
    border: '#3a4050',
    borderStrong: '#7a8296',
    focus: '#8ab8ff',
    dangerState: '#ffa49c',
    warningState: '#f2c264',
    successState: '#6fd39a',
    infoState: '#7cc4ff',
    borderStrongState: '#9299a9',
  },
  light: {
    bg: '#ffffff',
    surface: '#f5f6f8',
    raised: '#ffffff',
    overlay: '#ffffff',
    selected: '#d6e4fb',
    text: '#1a1d24',
    textMuted: '#4a5163',
    textSubtle: '#5c6477',
    accent: '#0a5bd6',
    danger: '#b3261e',
    warning: '#8a5a00',
    success: '#1b6e3f',
    info: '#0b5f99',
    onAccent: '#ffffff',
    accentHover: '#084bb0',
    border: '#d5d9e2',
    borderStrong: '#767d90',
    focus: '#0a5bd6',
    dangerState: '#9e211a',
    warningState: '#714a00',
    successState: '#175c35',
    infoState: '#0a5487',
    borderStrongState: '#656c7c',
  },
};
