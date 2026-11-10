import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Links the app hands to the system: web pages and mail. Anything else (file:, smb:,
 * search-ms:, ms-msdt: ...) can open or run programs on Windows, so a link someone pastes in a
 * chat must never reach shell.openExternal with one of those.
 */
export function isExternalLink(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Whether url is on the server: the same scheme, host and port, not a name that merely starts the same. */
export function onOrigin(url: string, origin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Whether url is a pop-out chat window: the server's own page at / with ?popout=c<id> or
 * ?popout=s<server>.<channel>, and nothing else, so no other page can open an app window.
 */
export function isPopout(url: string, origin: string): boolean {
  if (!onOrigin(url, origin)) return false;
  const u = new URL(url);
  return u.pathname === "/" && [...u.searchParams.keys()].join() === "popout" && /^(c\d+|s\d+\.\d+)$/.test(u.searchParams.get("popout") ?? "");
}

/** Whether url is the given local file (ignoring ?query and #hash), such as the bundled setup page. */
export function isFile(url: string, file: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return false;
    u.search = "";
    u.hash = "";
    const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(path.resolve(fileURLToPath(u)), path.resolve(file));
  } catch {
    return false;
  }
}

/**
 * Permissions the server's pages may have. Microphone and camera are for calls (Phase 1 and 4);
 * "notifications" is not here on purpose: the app shows its own, without message text, so a
 * page can't put a message on the screen or the lock screen.
 */
const SERVER_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "media", "display-capture", "speaker-selection"]);

export function permissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return SERVER_PERMISSIONS.has(permission) && onOrigin(requestingUrl, origin);
}
