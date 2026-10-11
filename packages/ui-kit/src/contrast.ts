/** A colour as 0-255 sRGB channels. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Reads a `#rrggbb` colour. Token colours are constants in this package, so a malformed value is
 * a programmer error and throws; it is never a runtime condition to handle.
 */
export function parseHex(hex: string): Rgb {
  if (!HEX_COLOUR.test(hex)) {
    throw new RangeError(`Expected a #rrggbb colour, received ${JSON.stringify(hex)}`);
  }
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function linearChannel(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG 2.x contrast ratio between two colours, 1 to 21. Symmetric in its arguments. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHexChannel(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0');
}

/**
 * Blends `overlay` over `base` at `alpha` (0 = all base, 1 = all overlay), channel by channel in
 * sRGB, rounding to the nearest integer. This is how the hover and pressed tints are defined.
 */
export function mixHex(base: string, overlay: string, alpha: number): string {
  if (!(alpha >= 0 && alpha <= 1)) {
    throw new RangeError(`Expected an alpha between 0 and 1, received ${String(alpha)}`);
  }
  const from = parseHex(base);
  const to = parseHex(overlay);
  const mix = (a: number, b: number): string => toHexChannel(a * (1 - alpha) + b * alpha);
  return `#${mix(from.r, to.r)}${mix(from.g, to.g)}${mix(from.b, to.b)}`;
}
