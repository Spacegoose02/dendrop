/** Small sRGB helpers for deriving theme surfaces and checking contrast. Hex colors only (#rrggbb). */

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb color: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function format([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Mixes `a` toward `b` by `t` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return format([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = parse(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of `dark` or `light` reads better on `bg`. */
export function readableOn(bg: string, dark = "#14110c", light = "#fffaf2"): string {
  return contrast(bg, dark) >= contrast(bg, light) ? dark : light;
}

/** `rgba()` form of a hex color, for glows and translucent fills. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * A person's chosen color, made readable on a theme. If it already reaches `min` contrast on
 * every background it's returned as is; otherwise it's mixed toward black or white (whichever
 * reads on the first background) just far enough, so a dark purple turns a lighter purple on a
 * dark theme instead of disappearing. Anything that isn't #rrggbb gives `fallback`.
 */
export function readableColor(color: string | null | undefined, backgrounds: string[], fallback: string, min = 4.5): string {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color) || backgrounds.length === 0) return fallback;
  const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= min);
  if (ok(color)) return color.toLowerCase();
  const target = readableOn(backgrounds[0]!, "#000000", "#ffffff");
  for (let step = 1; step <= 20; step++) {
    const c = mix(color, target, step / 20);
    if (ok(c)) return c;
  }
  return fallback;
}

/**
 * How a theme shows a person's name and message colors: on the main pane, a hovered message,
 * and the sidebar member lists. Null colors (and unreadable leftovers) use the theme's text.
 */
export function personColors(
  tokens: { "bg-main": string; "bg-hover": string; "bg-sidebar": string; text: string },
  user: { nameColor?: string | null; textColor?: string | null },
): { name: string | undefined; text: string | undefined } {
  const bgs = [tokens["bg-main"], tokens["bg-hover"], tokens["bg-sidebar"]];
  return {
    name: user.nameColor ? readableColor(user.nameColor, bgs, tokens.text) : undefined,
    text: user.textColor ? readableColor(user.textColor, bgs, tokens.text) : undefined,
  };
}
