import { describe, expect, it } from 'vitest';
import * as publicApi from './index.ts';

describe('@autogeek/ui-kit public surface', () => {
  it('exports the design tokens, the stylesheet emitter and the theme controller, and nothing else', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'COLOR_TOKEN_NAMES',
        'SURFACE_NAMES',
        'colorTokens',
        'controlHeight',
        'createThemeController',
        'cssVarName',
        'fontFamily',
        'motion',
        'motionDurationMs',
        'radius',
        'resolveTheme',
        'spacing',
        'themeToCss',
        'toRem',
        'typography',
        'zIndex',
      ].sort(),
    );
  });

  it('keeps the contrast helpers internal: they exist for the token test, not for components', () => {
    expect(publicApi).not.toHaveProperty('contrastRatio');
  });
});
