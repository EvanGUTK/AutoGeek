import { describe, expect, it } from 'vitest';
import { COLOR_TOKEN_NAMES, colorTokens } from './colors.ts';
import { cssVarName, themeToCss } from './css.ts';
import { spacing } from './scales.ts';

/** The text between the braces of the first block that starts with `header`. */
function blockBody(css: string, header: string): string {
  const start = css.indexOf(`${header} {`);
  expect(start, `block "${header}" is present`).toBeGreaterThanOrEqual(0);
  const open = start + header.length + 2;
  let depth = 1;
  let index = open;
  while (depth > 0 && index < css.length) {
    const char = css[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    index += 1;
  }
  return css.slice(open, index - 1);
}

function declarations(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+|color-scheme):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) result.set(name, value.trim());
  }
  return result;
}

describe('cssVarName', () => {
  it.each([
    ['bg', '--ag-bg'],
    ['textMuted', '--ag-text-muted'],
    ['onAccent', '--ag-on-accent'],
    ['borderStrongState', '--ag-border-strong-state'],
  ])('maps %s to %s', (token, expected) => {
    expect(cssVarName(token)).toBe(expected);
  });
});

describe('themeToCss', () => {
  const css = themeToCss();

  it('is deterministic', () => {
    expect(themeToCss()).toBe(css);
  });

  it.each(['dark', 'light'] as const)(
    'defines every colour token under :root[data-theme="%s"] with its colour-scheme',
    (theme) => {
      const values = declarations(blockBody(css, `:root[data-theme="${theme}"]`));
      expect(values.get('color-scheme')).toBe(theme);
      for (const token of COLOR_TOKEN_NAMES) {
        expect(values.get(cssVarName(token)), token).toBe(colorTokens[theme][token]);
      }
    },
  );

  it('follows the system theme when no data-theme attribute is set', () => {
    const light = declarations(blockBody(css, ':root:not([data-theme])'));
    expect(light.get('--ag-bg')).toBe(colorTokens.light.bg);
    const dark = declarations(
      blockBody(blockBody(css, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme])'),
    );
    expect(dark.get('--ag-bg')).toBe(colorTokens.dark.bg);
    expect(dark.get('color-scheme')).toBe('dark');
  });

  it('emits the non-colour scales once, on :root', () => {
    const root = declarations(blockBody(css, ':root'));
    expect(root.get('--ag-space-3')).toBe(`${String(spacing.space3)}px`);
    expect(root.get('--ag-type-sm-size')).toBe('0.8125rem');
    expect(root.get('--ag-type-sm-line')).toBe('1.25rem');
    expect(root.get('--ag-radius-md')).toBe('4px');
    expect(root.get('--ag-dur-base')).toBe('160ms');
    expect(root.get('--ag-z-modal')).toBe('40');
    expect(root.get('--ag-control-h')).toBe('28px');
    expect(root.get('--ag-font-mono')).toContain('ui-monospace');
  });

  it('removes motion durations under prefers-reduced-motion', () => {
    const reduced = declarations(
      blockBody(blockBody(css, '@media (prefers-reduced-motion: reduce)'), ':root'),
    );
    expect(reduced.get('--ag-dur-fast')).toBe('0ms');
    expect(reduced.get('--ag-dur-base')).toBe('0ms');
    expect(reduced.get('--ag-dur-slow')).toBe('0ms');
  });

  it('raises the quiet colours under prefers-contrast: more', () => {
    const more = declarations(
      blockBody(
        blockBody(css, '@media (prefers-contrast: more)'),
        ':root[data-theme], :root:not([data-theme])',
      ),
    );
    expect(more.get('--ag-border')).toBe('var(--ag-border-strong)');
    expect(more.get('--ag-text-muted')).toBe('var(--ag-text)');
    expect(more.get('--ag-text-subtle')).toBe('var(--ag-text)');
  });

  it('maps every colour token to a system colour under forced-colors', () => {
    const forced = declarations(
      blockBody(
        blockBody(css, '@media (forced-colors: active)'),
        ':root[data-theme], :root:not([data-theme])',
      ),
    );
    const systemColours = new Set([
      'Canvas',
      'CanvasText',
      'Highlight',
      'HighlightText',
      'ButtonText',
      'LinkText',
      'GrayText',
    ]);
    for (const token of COLOR_TOKEN_NAMES) {
      const value = forced.get(cssVarName(token));
      expect(value, token).toBeDefined();
      expect(systemColours.has(value ?? ''), `${token} -> ${value ?? 'undefined'}`).toBe(true);
    }
  });

  it('references no remote resource, import or url (strict CSP, offline-first)', () => {
    expect(css).not.toMatch(/@import|url\(|https?:|\/\//);
  });
});
