/**
 * The window's title bar, themed like the rest of the app instead of the grey one Windows and
 * Linux draw. The windows hide the system title bar and keep only its minimize, maximize and
 * close buttons (Electron's titleBarOverlay); the preload draws a bar of its own under them that
 * you drag the window by, and tells the main process the theme's colors so the buttons match.
 *
 * Everything here lives in the app, not the web client, so it works with any server version.
 */

/** Height of the bar in CSS pixels; Windows 11's own title bar is about this tall. */
export const TITLE_BAR_HEIGHT = 32;

/** The Den theme's rail and text colors, used until the page says otherwise. */
export const DEFAULT_TITLE_BAR = { color: "#121418", symbolColor: "#e9e6e1" } as const;

export interface TitleBarColors {
  color: string;
  symbolColor: string;
}

/** Windows and Linux get the themed bar; elsewhere (macOS) the system one stays. */
export function themedTitleBar(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

/** BrowserWindow options for a window with the themed title bar. */
export function titleBarOptions(platform: string = process.platform): { titleBarStyle?: "hidden"; titleBarOverlay?: TitleBarColors & { height: number } } {
  if (!themedTitleBar(platform)) return {};
  return { titleBarStyle: "hidden", titleBarOverlay: { ...DEFAULT_TITLE_BAR, height: TITLE_BAR_HEIGHT } };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Colors a page sent for the window buttons: plain hex only, or null to ignore them. */
export function cleanTitleBarColors(input: unknown): TitleBarColors | null {
  if (!input || typeof input !== "object") return null;
  const { color, symbolColor } = input as Record<string, unknown>;
  if (typeof color !== "string" || typeof symbolColor !== "string") return null;
  const c = color.trim();
  const s = symbolColor.trim();
  return HEX.test(c) && HEX.test(s) ? { color: c.toLowerCase(), symbolColor: s.toLowerCase() } : null;
}

/** The id of the bar element the preload adds, and the class on <html> while the window is full screen. */
export const TITLE_BAR_ID = "dendrop-titlebar";
export const FULL_SCREEN_CLASS = "dendrop-fullscreen";

/**
 * Inserted into every page of a themed window by the main process (insertCSS, so a page's
 * Content-Security-Policy can't block it). Makes room for the bar above the page and keeps
 * full-window dialogs (Settings) below it, under the window buttons.
 */
export function titleBarCss(): string {
  const h = "var(--dendrop-titlebar-height)";
  return `
:root { --dendrop-titlebar-height: ${TITLE_BAR_HEIGHT}px; }
:root.${FULL_SCREEN_CLASS} { --dendrop-titlebar-height: 0px; }
html { box-sizing: border-box !important; height: 100% !important; padding-top: ${h} !important; }
body { height: 100%; }
#root { height: 100% !important; }
dialog:modal { top: ${h} !important; max-height: calc(100% - ${h}) !important; }
#${TITLE_BAR_ID} {
  position: fixed; top: 0; left: 0; right: 0; height: ${h}; z-index: 2147483647;
  display: block; box-sizing: border-box;
  padding: 0 calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + 12px) 0 12px;
  background: var(--dd-bg-rail, ${DEFAULT_TITLE_BAR.color}); color: var(--dd-text-muted, #a3a8b1);
  font: 600 12px var(--dd-font, "Segoe UI", system-ui, sans-serif); line-height: ${h}; letter-spacing: 0.02em;
  user-select: none; -webkit-user-select: none; -webkit-app-region: drag; app-region: drag;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
:root.${FULL_SCREEN_CLASS} #${TITLE_BAR_ID} { display: none; }
`;
}
