import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DesktopSettings {
  /** The Dendrop server's address, e.g. https://chat.example.com. Empty until set up. */
  serverUrl: string;
  /** Closing the window keeps Dendrop in the system tray, so messages still notify. */
  closeToTray: boolean;
  /** Start with the computer, hidden in the tray. Off by default. */
  openAtLogin: boolean;
  /** Desktop notifications for new messages. They never include the message text. */
  notifications: boolean;
  /** Name who a message is from in its notification ("New message from Alex"). Off by default, so nothing personal shows on a lock screen. */
  notifySender: boolean;
  /** Download new app versions from the server and install them when the app is idle. */
  autoUpdate: boolean;
  /** Install updates that don't match a GitHub release's SHA256SUMS (your own builds). Settings file only. */
  allowUnverifiedUpdates?: boolean;
  /** The "still running in the tray" hint was shown once. */
  trayHintShown: boolean;
  /** Where the window was, so it opens in the same place. */
  bounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
}

export function defaultSettings(): DesktopSettings {
  return { serverUrl: "", closeToTray: true, openAtLogin: false, notifications: true, notifySender: false, autoUpdate: true, trayHintShown: false };
}

/** Settings as JSON in the app's data folder. Unknown or broken files fall back to the defaults. */
export class SettingsStore {
  private value: DesktopSettings;

  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<DesktopSettings>;
      this.value = { ...defaultSettings(), ...(saved && typeof saved === "object" ? saved : {}) };
    } catch {
      this.value = defaultSettings();
    }
  }

  get(): DesktopSettings {
    const { bounds, ...rest } = this.value;
    return bounds ? { ...rest, bounds: { ...bounds } } : rest;
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    this.value = { ...this.value, ...patch };
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash mid-write can't leave half a file.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.value, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    return this.get();
  }
}
