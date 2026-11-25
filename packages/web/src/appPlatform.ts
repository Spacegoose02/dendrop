import type { AppDownload, AppPlatform } from "@dendrop/shared";

/** The visitor's system, as far as the browser tells; "unknown" when it doesn't say. */
export type VisitorPlatform = AppPlatform | "unknown";

export const PLATFORM_NAMES: Record<AppPlatform, string> = {
  windows: "Windows",
  macos: "Mac",
  linux: "Linux",
  android: "Android",
  ios: "iPhone and iPad",
};

/**
 * Which system a browser runs on, from its user agent (and navigator.platform where there is
 * one). iPads say they're Macs, so a "Mac" with a touch screen counts as iOS.
 */
export function detectPlatform(userAgent: string, platform = "", maxTouchPoints = 0): VisitorPlatform {
  const ua = `${userAgent} ${platform}`;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh|mac os x|\bmac(intel)?\b/i.test(ua)) return maxTouchPoints > 1 ? "ios" : "macos";
  if (/windows|\bwin(32|64)\b/i.test(ua)) return "windows";
  if (/cros/i.test(ua)) return "unknown";
  if (/linux|x11/i.test(ua)) return "linux";
  return "unknown";
}

/** This browser's system. */
export function visitorPlatform(): VisitorPlatform {
  const n = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectPlatform(n.userAgent, n.userAgentData?.platform || n.platform || "", n.maxTouchPoints || 0);
}

/** The download to put first for a system: the best build for it, or null when there's none. */
export function primaryDownload(files: AppDownload[], platform: VisitorPlatform): AppDownload | null {
  return files.find((f) => f.platform === platform) ?? null;
}

/** "115 MB" */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / 1_000_000;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** True inside the PC app or a phone app, which update themselves instead of offering downloads. */
export function inInstalledApp(): boolean {
  const w = window as { dendrop?: unknown; Capacitor?: { getPlatform?: () => string } };
  if (w.dendrop) return true;
  const p = w.Capacitor?.getPlatform?.();
  return p === "android" || p === "ios";
}
