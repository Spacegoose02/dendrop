import { mix } from "./color.ts";
import type { Theme } from "./themes.ts";

/**
 * The Dendrop raccoon mark, drawn from code so every theme and app icon is the same animal:
 * pointed ears, cheek tufts, a dark mask with a forehead stripe, a pale muzzle, and two
 * lantern eyes. Three drawing styles: flat (default), neon outline, and 16x16 pixel art.
 */

export type IconStyle = "flat" | "neon" | "pixel";

export interface IconColors {
  tile: string;
  fur: string;
  mask: string;
  light: string;
  eye: string;
  /** Second neon color for the neon style (ears and muzzle). */
  eye2?: string;
  /** Draws a soft halo behind the eyes. */
  glow?: boolean;
}

const HEAD = "M32 15C45 15 53 22 55.5 32L61 39.5 53.5 41.5C49.5 49.5 41.5 54 32 54S14.5 49.5 10.5 41.5L3 39.5 8.5 32C11 22 19 15 32 15Z";
const EARS = ["M11 28 13.5 9.5 27 18Z", "M53 28 50.5 9.5 37 18Z"];
const INNER_EARS = ["M15 22.5 16 14.5 22.5 19Z", "M49 22.5 48 14.5 41.5 19Z"];
const MASK = "M8 36C12 27.5 21.5 26.5 27.5 31.5L32 34 36.5 31.5C42.5 26.5 52 27.5 56 36 51 42.5 42 43.5 36.5 39.5L32 37.5 27.5 39.5C22 43.5 13 42.5 8 36Z";
const STRIPE = "M29.5 18.5H34.5L33.5 33H30.5Z";
const BROWS = ["M14 29.5C17 25.5 23 24.5 27 27", "M50 29.5C47 25.5 41 24.5 37 27"];
const MUZZLE = "M21 43C24 38.5 28.5 38 32 40 35.5 38 40 38.5 43 43 40.5 50 35.5 52 32 52S23.5 50 21 43Z";
const NOSE = "M28.5 42.5H35.5L32 46.5Z";
const EYES: [number, number][] = [
  [20.5, 34.5],
  [43.5, 34.5],
];

function flat(c: IconColors): string {
  const halo = c.glow ? EYES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="${c.eye}" opacity="0.35"/>`).join("") : "";
  return [
    `<rect width="64" height="64" rx="15" fill="${c.tile}"/>`,
    ...EARS.map((d) => `<path d="${d}" fill="${c.fur}" stroke="${c.fur}" stroke-width="6" stroke-linejoin="round"/>`),
    ...INNER_EARS.map((d) => `<path d="${d}" fill="${c.mask}"/>`),
    `<path d="${HEAD}" fill="${c.fur}" stroke="${c.fur}" stroke-width="2" stroke-linejoin="round"/>`,
    ...BROWS.map((d) => `<path d="${d}" fill="none" stroke="${c.light}" stroke-width="3.5" stroke-linecap="round"/>`),
    `<path d="${STRIPE}" fill="${c.mask}"/>`,
    `<path d="${MASK}" fill="${c.mask}"/>`,
    `<path d="${MUZZLE}" fill="${c.light}"/>`,
    halo,
    ...EYES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.8" fill="${c.eye}"/>`),
    `<path d="${NOSE}" fill="${c.mask}" stroke="${c.mask}" stroke-width="2" stroke-linejoin="round"/>`,
  ].join("");
}

function neon(c: IconColors): string {
  const line = (d: string, color: string, w = 2.2) =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const two = c.eye2 ?? c.eye;
  const strokes = [
    ...EARS.map((d) => line(d, two)),
    line(HEAD, c.eye),
    line(MASK, c.eye),
    line(MUZZLE, two),
    ...EYES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${c.light}"/>`),
    `<path d="${NOSE}" fill="${two}"/>`,
  ].join("");
  return [
    `<defs><filter id="g" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>`,
    `<rect width="64" height="64" rx="15" fill="${c.tile}"/>`,
    `<g filter="url(#g)" opacity="0.9">${strokes}</g>`,
    strokes,
  ].join("");
}

/** 16x16 pixel raccoon: . tile, f fur, k mask, w light, e eye. */
export const PIXEL_ART = [
  "................",
  ".ff..........ff.",
  ".fkf........fkf.",
  ".fkff.ffff.ffkf.",
  ".ffffffkkffffff.",
  ".fwwwwfkkfwwwwf.",
  "fkkkkkkkkkkkkkkf",
  "kkkeekkkkkkeekkk",
  "fkkeekkwwkkeekkf",
  "ffkkkkwwwwkkkkff",
  ".ffwwwwwwwwwwff.",
  "..fwwwwkkwwwwf..",
  "...ffwwwwwwff...",
  ".....ffffff.....",
  "................",
  "................",
];

function pixel(c: IconColors): string {
  const fill: Record<string, string> = { f: c.fur, k: c.mask, w: c.light, e: c.eye };
  const rects: string[] = [];
  PIXEL_ART.forEach((row, y) => {
    // Merge runs of one color so the SVG stays small.
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (fill[ch]) rects.push(`<rect x="${x * 4}" y="${y * 4}" width="${(end - x) * 4}" height="4" fill="${fill[ch]}"/>`);
      x = end;
    }
  });
  return `<rect width="64" height="64" rx="6" fill="${c.tile}"/><g shape-rendering="crispEdges">${rects.join("")}</g>`;
}

/** The raccoon mark as a standalone SVG document. */
export function raccoonSvg(colors: IconColors, style: IconStyle = "flat"): string {
  const body = style === "neon" ? neon(colors) : style === "pixel" ? pixel(colors) : flat(colors);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The mark in a theme's own colors, used by the "Match my theme" app icon. */
export function themeIconSvg(theme: Theme): string {
  const t = theme.tokens;
  const light = theme.scheme === "light";
  const style: IconStyle = theme.family === "laser" ? "neon" : t["radius-sm"] === "0px" ? "pixel" : "flat";
  return raccoonSvg(
    {
      tile: light ? t.accent : t["bg-rail"],
      fur: light ? mix(t.text, t["bg-main"], 0.45) : t.ring,
      mask: light ? t.text : t["bg-rail"],
      light: light ? t["bg-main"] : t.text,
      eye: light ? mix(t.accent, "#ffffff", 0.55) : t.accent,
      eye2: t["accent-2"],
      glow: t.glow !== "none",
    },
    style,
  );
}

export interface AppIcon {
  id: string;
  name: string;
  style: IconStyle;
  colors: IconColors;
}

/** Alternate app icons. "theme" (see THEME_ICON) follows whatever theme is active. */
export const APP_ICONS: readonly AppIcon[] = [
  { id: "classic", name: "Classic", style: "flat", colors: { tile: "#121418", fur: "#8c929c", mask: "#121418", light: "#e9e6e1", eye: "#f2a541", glow: true } },
  { id: "daylight", name: "Daylight", style: "flat", colors: { tile: "#f2a541", fur: "#5f6670", mask: "#1a1d22", light: "#f6f1ea", eye: "#ffd27a" } },
  { id: "midnight", name: "Midnight", style: "flat", colors: { tile: "#1b2030", fur: "#4a5470", mask: "#0d0f17", light: "#c3c9dc", eye: "#8fb3ff", glow: true } },
  { id: "glowing", name: "Glowing", style: "flat", colors: { tile: "#0d1a15", fur: "#3c5a4a", mask: "#07100c", light: "#bfffd9", eye: "#2bff9a", glow: true } },
  { id: "hazard", name: "Hazard", style: "flat", colors: { tile: "#ffd400", fur: "#3a3527", mask: "#17150c", light: "#fff4b3", eye: "#ff6a1f" } },
  { id: "loot", name: "Loot", style: "flat", colors: { tile: "#2a1f45", fur: "#e8b931", mask: "#3d2a0a", light: "#fff1c2", eye: "#b07dff", glow: true } },
  { id: "pixel", name: "Pixel", style: "pixel", colors: { tile: "#1e1e2a", fur: "#9aa0ad", mask: "#2b2b3a", light: "#f4f4f4", eye: "#ff6b6b" } },
  { id: "neon", name: "Neon", style: "neon", colors: { tile: "#0a0614", fur: "#ff2fb3", mask: "#0a0614", light: "#ffffff", eye: "#ff2fb3", eye2: "#00f0ff" } },
  { id: "laser", name: "Laser", style: "neon", colors: { tile: "#070a07", fur: "#39ff14", mask: "#070a07", light: "#ffffff", eye: "#39ff14", eye2: "#ffe600" } },
];

export const THEME_ICON = "theme";
export const DEFAULT_ICON = "classic";

/** SVG for an app icon id; "theme" draws the mark in the given theme's colors. */
export function appIconSvg(id: string, theme: Theme): string {
  if (id === THEME_ICON) return themeIconSvg(theme);
  const icon = APP_ICONS.find((i) => i.id === id) ?? APP_ICONS[0]!;
  return raccoonSvg(icon.colors, icon.style);
}
