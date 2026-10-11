// Public surface of @autogeek/ui-kit: design tokens, the stylesheet that publishes them as CSS
// custom properties, and the theme controller. Components are added behind this as they land.
export { COLOR_TOKEN_NAMES, SURFACE_NAMES, colorTokens } from './colors.ts';
export type { ColorTokenName, ColorTokens, ThemeName } from './colors.ts';
export { cssVarName, themeToCss } from './css.ts';
export {
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
export type { MotionSpeed, TypeStep } from './scales.ts';
export { createThemeController, resolveTheme } from './theme-controller.ts';
export type {
  MediaQueryLike,
  ThemeController,
  ThemeControllerOptions,
  ThemeSetting,
  ThemeTarget,
} from './theme-controller.ts';
