import { appIconSvg, DEFAULT_ICON, svgDataUri } from "./icons.ts";
import { DEFAULT_THEME, getTheme, themeVars, type Theme } from "./themes.ts";

export * from "./themes.ts";
export * from "./icons.ts";
export { contrast, mix, personColors, readableColor } from "./color.ts";

export type ThemeId = string;

/** Fired on window whenever applyTheme() runs. */
export const THEME_EVENT = "dendrop:theme";

/** The theme on the page now. */
export function currentTheme(root: HTMLElement = document.documentElement): Theme {
  return getTheme(root.dataset.theme);
}

/**
 * Applies a theme to the page. tokens.css holds the Den defaults; this sets every token on
 * the root element, so any theme in THEMES works without a stylesheet of its own.
 */
export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): Theme {
  const theme = getTheme(id);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(themeVars(theme))) root.style.setProperty(name, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.tokens["bg-rail"]);
  // Name and text colors are made readable per theme in code, so tell the app it changed.
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme.id }));
  return theme;
}

/** Points the page's favicon at an app icon. Desktop and Android set their own window/launcher icon from appIconSvg(). */
export function applyAppIcon(id: string, theme: Theme): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/svg+xml";
  link.href = svgDataUri(appIconSvg(id, theme));
}

export interface Appearance {
  theme: ThemeId;
  icon: string;
}

const KEY = "dendrop.appearance";

/** This device's saved theme and app icon. Storage can be missing or blocked, so this never throws. */
export function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Appearance>;
    return { theme: getTheme(saved.theme).id, icon: typeof saved.icon === "string" ? saved.icon : DEFAULT_ICON };
  } catch {
    return { theme: DEFAULT_THEME, icon: DEFAULT_ICON };
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // Private mode or blocked storage: the choice still applies for this session.
  }
}

/** Applies and saves a theme and icon together; returns the resolved theme. */
export function setAppearance(a: Appearance): Theme {
  const theme = applyTheme(a.theme);
  applyAppIcon(a.icon, theme);
  saveAppearance({ theme: theme.id, icon: a.icon });
  return theme;
}
