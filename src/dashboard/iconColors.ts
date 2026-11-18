/**
 * Dark surfaces that host/harness icons are drawn on (screen background, cards,
 * and the tinted metadata chips in Chat). Contrast is checked against all of them.
 */
export const ICON_DARK_SURFACES = [
  '#0d1117',
  '#111620',
  '#161b22',
  '#181b22',
  '#232c38',
] as const;

/** Minimum contrast for a non-text graphic (WCAG 2.1 SC 1.4.11). */
export const MIN_ICON_CONTRAST = 3;

function channelToLinear(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Lowest contrast of `color` across every dark surface icons are shown on. */
export function minContrastOnDark(color: string): number {
  return Math.min(...ICON_DARK_SURFACES.map(surface => contrastRatio(color, surface)));
}

/**
 * Returns the fixed brand color when it reaches 3:1 on every dark surface;
 * otherwise the light monochrome variant (the color the caller passes via prop).
 */
export function resolveIconColor(brandColor: string, monochromeColor: string): string {
  return minContrastOnDark(brandColor) >= MIN_ICON_CONTRAST
    ? brandColor
    : monochromeColor;
}
