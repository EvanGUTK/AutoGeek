import type { ThemeName } from './colors.ts';

/** The user's choice: a fixed theme, or follow the operating system. */
export type ThemeSetting = ThemeName | 'system';

/** The part of `HTMLElement` the controller needs, so tests (and other views) inject their own. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The part of `MediaQueryList` for `(prefers-color-scheme: dark)` the controller needs. */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeControllerOptions {
  readonly target: ThemeTarget;
  /** `matchMedia('(prefers-color-scheme: dark)')`. */
  readonly media: MediaQueryLike;
  /** Called with the theme that is actually in effect, whenever it changes (Monaco follows this). */
  readonly onResolvedChange: (theme: ThemeName) => void;
}

export interface ThemeController {
  setSetting(setting: ThemeSetting): void;
  dispose(): void;
}

export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ThemeName {
  if (setting === 'system') return prefersDark ? 'dark' : 'light';
  return setting;
}

/**
 * Applies the theme setting to `data-theme` and reports the resolved theme. An explicit choice sets
 * the attribute; `system` removes it so the stylesheet follows `prefers-color-scheme` on its own
 * (no flash, no script needed to track the system). Nothing here reads a global.
 */
export function createThemeController(options: ThemeControllerOptions): ThemeController {
  const { target, media, onResolvedChange } = options;
  let setting: ThemeSetting = 'system';
  let reported: ThemeName | null = null;

  const report = (): void => {
    const resolved = resolveTheme(setting, media.matches);
    if (resolved === reported) return;
    reported = resolved;
    onResolvedChange(resolved);
  };

  const onSystemChange = (): void => {
    if (setting === 'system') report();
  };
  media.addEventListener('change', onSystemChange);

  return {
    setSetting(next: ThemeSetting): void {
      setting = next;
      if (next === 'system') target.removeAttribute('data-theme');
      else target.setAttribute('data-theme', next);
      report();
    },
    dispose(): void {
      media.removeEventListener('change', onSystemChange);
    },
  };
}
