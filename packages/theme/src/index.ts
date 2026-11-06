/** Theme ids. "den" is the default raccoon theme; theme packs add more. */
export const THEMES = ["den"] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = "den";

/** Applies a theme to the page: tokens.css keys its values off this attribute. */
export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = id;
}
