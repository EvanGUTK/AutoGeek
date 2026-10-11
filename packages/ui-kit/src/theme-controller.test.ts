import { describe, expect, it } from 'vitest';
import {
  createThemeController,
  resolveTheme,
  type MediaQueryLike,
  type ThemeTarget,
} from './theme-controller.ts';
import type { ThemeName } from './colors.ts';

class FakeTarget implements ThemeTarget {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeMedia implements MediaQueryLike {
  matches: boolean;
  private readonly listeners = new Set<() => void>();
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }
  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

function setup(prefersDark: boolean): {
  target: FakeTarget;
  media: FakeMedia;
  resolved: ThemeName[];
  controller: ReturnType<typeof createThemeController>;
} {
  const target = new FakeTarget();
  const media = new FakeMedia(prefersDark);
  const resolved: ThemeName[] = [];
  const controller = createThemeController({
    target,
    media,
    onResolvedChange: (theme) => resolved.push(theme),
  });
  return { target, media, resolved, controller };
}

describe('resolveTheme', () => {
  it('uses the explicit choice and ignores the system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('follows the system preference for the system setting', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('createThemeController', () => {
  it('sets data-theme for an explicit choice and reports the resolved theme', () => {
    const { target, resolved, controller } = setup(false);
    controller.setSetting('dark');
    expect(target.attributes.get('data-theme')).toBe('dark');
    expect(resolved).toEqual(['dark']);
  });

  it('removes data-theme for the system setting so the stylesheet follows the system', () => {
    const { target, resolved, controller } = setup(true);
    controller.setSetting('light');
    controller.setSetting('system');
    expect(target.attributes.has('data-theme')).toBe(false);
    expect(resolved).toEqual(['light', 'dark']);
  });

  it('reports a change when the system preference flips under the system setting', () => {
    const { media, resolved, controller } = setup(false);
    controller.setSetting('system');
    media.setMatches(true);
    media.setMatches(false);
    expect(resolved).toEqual(['light', 'dark', 'light']);
  });

  it('ignores system changes under an explicit choice', () => {
    const { media, resolved, controller } = setup(false);
    controller.setSetting('light');
    media.setMatches(true);
    expect(resolved).toEqual(['light']);
  });

  it('reports only when the resolved theme actually changes', () => {
    const { resolved, controller } = setup(false);
    controller.setSetting('dark');
    controller.setSetting('dark');
    controller.setSetting('system');
    controller.setSetting('light');
    expect(resolved).toEqual(['dark', 'light']);
  });

  it('stops listening to the system after dispose', () => {
    const { media, resolved, controller } = setup(false);
    controller.setSetting('system');
    expect(media.listenerCount).toBe(1);
    controller.dispose();
    expect(media.listenerCount).toBe(0);
    media.setMatches(true);
    expect(resolved).toEqual(['light']);
  });
});
