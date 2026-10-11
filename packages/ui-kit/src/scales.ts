/** Spacing in CSS pixels, a 4px-based scale (docs/ui-spec.md §2.4). */
export const spacing = {
  space0: 0,
  space1: 2,
  space2: 4,
  space3: 8,
  space4: 12,
  space5: 16,
  space6: 24,
  space7: 32,
  space8: 48,
} as const;

const ROOT_FONT_SIZE_PX = 16;

/** Converts pixels to `rem` against a 16px root, so browser and OS text scaling apply. */
export function toRem(px: number): string {
  return `${String(px / ROOT_FONT_SIZE_PX)}rem`;
}

export interface TypeStep {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 600;
}

/** Type steps in pixels. The default UI text is `sm`. */
export const typography = {
  xs: { size: 12, lineHeight: 16, weight: 400 },
  sm: { size: 13, lineHeight: 20, weight: 400 },
  md: { size: 14, lineHeight: 20, weight: 400 },
  lg: { size: 16, lineHeight: 24, weight: 600 },
  xl: { size: 20, lineHeight: 28, weight: 600 },
  monoSm: { size: 12, lineHeight: 18, weight: 400 },
  monoMd: { size: 13, lineHeight: 20, weight: 400 },
} as const satisfies Readonly<Record<string, TypeStep>>;

/** System font stacks only: no web fonts and no font CDN (CSP, offline-first). */
export const fontFamily = {
  ui: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const radius = { sm: 2, md: 4, lg: 8, full: 9999 } as const;

export type MotionSpeed = 'fast' | 'base' | 'slow';

export const motion = {
  durationMs: { fast: 100, base: 160, slow: 240 },
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** A duration in ms, or 0 for every speed when the user prefers reduced motion. */
export function motionDurationMs(speed: MotionSpeed, reducedMotion: boolean): number {
  return reducedMotion ? 0 : motion.durationMs[speed];
}

/** Stacking layers. Components use these names; there is no ad-hoc z-index. */
export const zIndex = {
  base: 0,
  panel: 10,
  sticky: 20,
  overlay: 30,
  modal: 40,
  toast: 50,
} as const;

/** Control heights in pixels. Compact is the 24px target-size floor (WCAG 2.5.8). */
export const controlHeight = { default: 28, compact: 24 } as const;
