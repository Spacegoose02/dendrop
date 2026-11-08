import { randomBytes } from "node:crypto";
import { LIMITS, watchPosition, type WatchItem, type WatchSession, type WatchSettings } from "@dendrop/shared";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";

const SETTINGS_KEY = "watch";
const DEFAULTS: WatchSettings = { youtube: false };
/** Longer than any video anyone will watch together: 48 hours. */
const MAX_POSITION = 48 * 3600;

/**
 * Watch together settings for the whole Dendrop server. YouTube is off by default, because
 * each device then loads YouTube's player (an outside service) for as long as the video plays.
 */
export class WatchSettingsStore {
  constructor(private readonly db: Db) {}

  get(): WatchSettings {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    if (!r) return { ...DEFAULTS };
    try {
      return { ...DEFAULTS, ...(JSON.parse(r.value) as Partial<WatchSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  set(patch: { youtube?: unknown }): WatchSettings {
    const next = this.get();
    if (patch.youtube !== undefined) {
      if (typeof patch.youtube !== "boolean") throw new HttpError(400, "youtube is true or false");
      next.youtube = patch.youtube;
    }
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
}

/** A title someone typed, or the one Dendrop made up, tidied and cut to length. */
export function cleanWatchTitle(title: unknown, fallback: string): string {
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return (t || fallback).slice(0, LIMITS.watchTitle);
}

/** A name for a linked video: the file name at the end of its address, or the site's name. */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last || u.hostname;
  } catch {
    return "Video";
  }
}

export const newWatchItem = (item: Omit<WatchItem, "id">): WatchItem => ({ ...item, id: randomBytes(8).toString("hex") });

/** A seek position from a client: seconds, 0 to 48 hours. */
export function cleanPosition(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_POSITION) throw new HttpError(400, "position is a number of seconds");
  return Math.round(v * 1000) / 1000;
}

/**
 * The changes to a watch-together session. Each returns the new session (null when it's over)
 * and never changes the one passed in. `at` is the server's time in milliseconds.
 */
export const Watch = {
  /** Plays it now if nothing is playing, otherwise adds it to the queue. */
  add(w: WatchSession | null, item: WatchItem, at: number): WatchSession {
    if (!w) return { current: item, queue: [], playing: true, position: 0, updatedAt: at };
    if (w.queue.length >= LIMITS.watchQueue) throw new HttpError(400, `Up to ${LIMITS.watchQueue} videos can wait in the queue`);
    return { ...w, queue: [...w.queue, item] };
  },

  /** Play, pause or jump to a time. */
  control(w: WatchSession, patch: { playing?: boolean; position?: number }, at: number): WatchSession {
    const position = patch.position ?? watchPosition(w, at);
    return { ...w, playing: patch.playing ?? w.playing, position, updatedAt: at };
  },

  /**
   * On to the next video, or the end when the queue is empty. With `itemId` it only moves on if
   * that's still the one playing, so several devices saying "it ended" move on once.
   */
  next(w: WatchSession, at: number, itemId?: string): WatchSession | null {
    if (itemId !== undefined && itemId !== w.current.id) return w;
    const [current, ...queue] = w.queue;
    if (!current) return null;
    return { current, queue, playing: true, position: 0, updatedAt: at };
  },

  /** Takes a video out of the queue. */
  remove(w: WatchSession, itemId: string): WatchSession {
    if (!w.queue.some((i) => i.id === itemId)) throw new HttpError(404, "That video isn't in the queue");
    return { ...w, queue: w.queue.filter((i) => i.id !== itemId) };
  },
};
