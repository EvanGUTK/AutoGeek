import { COLOR_TOKEN_NAMES, colorTokens, type ColorTokenName, type ThemeName } from './colors.ts';
import {
  controlHeight,
  fontFamily,
  motion,
  radius,
  spacing,
  toRem,
  typography,
  zIndex,
} from './scales.ts';

/** `textMuted` -> `--ag-text-muted`. */
export function cssVarName(token: string): string {
  return `--ag-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

type Declaration = readonly [name: string, value: string];

function colorDeclarations(theme: ThemeName): Declaration[] {
  const tokens = colorTokens[theme];
  return COLOR_TOKEN_NAMES.map((token) => [cssVarName(token), tokens[token]]);
}

function themeBlockBody(theme: ThemeName): Declaration[] {
  return [['color-scheme', theme], ...colorDeclarations(theme)];
}

function scaleDeclarations(): Declaration[] {
  const declarations: Declaration[] = [];
  for (const [name, px] of Object.entries(spacing)) {
    declarations.push([`--ag-space-${name.replace('space', '')}`, `${String(px)}px`]);
  }
  declarations.push(['--ag-font-ui', fontFamily.ui], ['--ag-font-mono', fontFamily.mono]);
  for (const [step, value] of Object.entries(typography)) {
    const stem = `--ag-type-${step.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    declarations.push(
      [`${stem}-size`, toRem(value.size)],
      [`${stem}-line`, toRem(value.lineHeight)],
      [`${stem}-weight`, String(value.weight)],
    );
  }
  for (const [name, px] of Object.entries(radius)) {
    declarations.push([`--ag-radius-${name}`, `${String(px)}px`]);
  }
  for (const [name, ms] of Object.entries(motion.durationMs)) {
    declarations.push([`--ag-dur-${name}`, `${String(ms)}ms`]);
  }
  declarations.push(['--ag-ease', motion.easing]);
  for (const [name, layer] of Object.entries(zIndex)) {
    declarations.push([`--ag-z-${name}`, String(layer)]);
  }
  declarations.push(
    ['--ag-control-h', `${String(controlHeight.default)}px`],
    ['--ag-control-h-compact', `${String(controlHeight.compact)}px`],
  );
  return declarations;
}

/** Quiet colours resolve to stronger ones when the user asks for more contrast. */
const MORE_CONTRAST: readonly Declaration[] = [
  ['--ag-border', 'var(--ag-border-strong)'],
  ['--ag-text-muted', 'var(--ag-text)'],
  ['--ag-text-subtle', 'var(--ag-text)'],
];

/**
 * Under forced colours (Windows High Contrast and similar) every colour token resolves to a
 * system colour. Meaning is never carried by colour alone, so the status colours collapse safely.
 */
const FORCED_COLOURS: Readonly<Record<ColorTokenName, string>> = {
  bg: 'Canvas',
  surface: 'Canvas',
  raised: 'Canvas',
  overlay: 'Canvas',
  selected: 'Highlight',
  text: 'CanvasText',
  textMuted: 'CanvasText',
  textSubtle: 'CanvasText',
  accent: 'LinkText',
  danger: 'CanvasText',
  warning: 'CanvasText',
  success: 'CanvasText',
  info: 'CanvasText',
  onAccent: 'Canvas',
  accentHover: 'LinkText',
  border: 'CanvasText',
  borderStrong: 'CanvasText',
  focus: 'Highlight',
  dangerState: 'CanvasText',
  warningState: 'CanvasText',
  successState: 'CanvasText',
  infoState: 'CanvasText',
  borderStrongState: 'CanvasText',
};

const ANY_THEME_ROOT = ':root[data-theme], :root:not([data-theme])';

function block(header: string, declarations: readonly Declaration[], indent = ''): string {
  const lines = declarations.map(([name, value]) => `${indent}  ${name}: ${value};`);
  return [`${indent}${header} {`, ...lines, `${indent}}`].join('\n');
}

function indented(css: string): string {
  return css
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * The whole stylesheet: scales on `:root`, an explicit `data-theme` per theme, system-following
 * defaults when no attribute is set, and the reduced-motion, more-contrast and forced-colours
 * adjustments. Pure and deterministic, with no remote resource (strict CSP, offline-first).
 */
export function themeToCss(): string {
  const forced: Declaration[] = COLOR_TOKEN_NAMES.map((token) => [
    cssVarName(token),
    FORCED_COLOURS[token],
  ]);
  const motionOff: Declaration[] = Object.keys(motion.durationMs).map((name) => [
    `--ag-dur-${name}`,
    '0ms',
  ]);
  return [
    block(':root', scaleDeclarations()),
    block(':root:not([data-theme])', themeBlockBody('light')),
    `@media (prefers-color-scheme: dark) {\n${indented(block(':root:not([data-theme])', themeBlockBody('dark')))}\n}`,
    block(':root[data-theme="dark"]', themeBlockBody('dark')),
    block(':root[data-theme="light"]', themeBlockBody('light')),
    `@media (prefers-reduced-motion: reduce) {\n${indented(block(':root', motionOff))}\n}`,
    `@media (prefers-contrast: more) {\n${indented(block(ANY_THEME_ROOT, MORE_CONTRAST))}\n}`,
    `@media (forced-colors: active) {\n${indented(block(ANY_THEME_ROOT, forced))}\n}`,
    '',
  ].join('\n');
}
