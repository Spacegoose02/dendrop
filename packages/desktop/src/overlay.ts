/**
 * The in-game overlay: a small see-through panel over your game that shows who's in your voice
 * channel and who's talking, with the channel's last few messages. A hotkey makes it clickable
 * for a quick reply (or mute and deafen), and Escape hands the game back.
 *
 * It follows LootDen: by default it only shows while you're in voice and LootDen says you're
 * playing something. It can also show whenever you're in voice, or never.
 *
 * The web page in the main window knows all of this (it's in voice), so it sends the overlay's
 * state here (dd:overlayState); this file checks and trims what it's given, so a page can't
 * make the overlay huge or show something else.
 */

export type OverlayMode = "game" | "voice" | "off";
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const OVERLAY_MODES: readonly OverlayMode[] = ["game", "voice", "off"];
export const OVERLAY_CORNERS: readonly OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const DEFAULT_OVERLAY_HOTKEY = "Alt+`";

export interface OverlayMember {
  id: number;
  name: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  /** Sharing their screen. */
  screen: boolean;
  me: boolean;
}

export interface OverlayMessage {
  id: number;
  author: string;
  text: string;
}

export interface OverlayState {
  /** The voice channel you're in, or null when you're not in one. */
  channel: string | null;
  server: string | null;
  members: OverlayMember[];
  messages: OverlayMessage[];
  /** What LootDen says you're playing, or null. */
  playing: string | null;
  /** What's on in watch together, if anything. */
  watching: string | null;
  /** Whether you can send in the channel's chat (not timed out, not out of chat time). */
  canChat: boolean;
}

export const EMPTY_OVERLAY: OverlayState = { channel: null, server: null, members: [], messages: [], playing: null, watching: null, canChat: false };

const MAX_MEMBERS = 25;
const MAX_MESSAGES = 6;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};
const bool = (v: unknown) => v === true;
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);

/** The state from the page, checked and trimmed. Anything malformed becomes "not in voice". */
export function cleanOverlayState(input: unknown): OverlayState {
  if (!input || typeof input !== "object") return EMPTY_OVERLAY;
  const s = input as Record<string, unknown>;
  const channel = text(s.channel, 64);
  if (!channel) return EMPTY_OVERLAY;
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(-max) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  return {
    channel,
    server: text(s.server, 64),
    members: (Array.isArray(s.members) ? s.members.slice(0, MAX_MEMBERS) : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((m) => ({
        id: int(m.id),
        name: text(m.name, 40) ?? "Someone",
        speaking: bool(m.speaking),
        muted: bool(m.muted),
        deafened: bool(m.deafened),
        screen: bool(m.screen),
        me: bool(m.me),
      })),
    messages: list(s.messages, MAX_MESSAGES).map((m) => ({ id: int(m.id), author: text(m.author, 40) ?? "Someone", text: text(m.text, 300) ?? "" })).filter((m) => m.text),
    playing: text(s.playing, 80),
    watching: text(s.watching, 120),
    canChat: bool(s.canChat),
  };
}

/** Whether the overlay should be up: you're in voice, and (in "game" mode) LootDen says you're playing. */
export function overlayVisible(state: OverlayState, mode: OverlayMode): boolean {
  if (mode === "off" || !state.channel) return false;
  return mode === "voice" || !!state.playing;
}

export const OVERLAY_SIZE = { width: 300, height: 380 };

/** Where the overlay goes on a screen's work area, a little in from the corner. */
export function overlayBounds(area: { x: number; y: number; width: number; height: number }, corner: OverlayCorner, margin = 16) {
  const { width, height } = OVERLAY_SIZE;
  const left = corner.endsWith("left");
  const top = corner.startsWith("top");
  return {
    x: Math.round(left ? area.x + margin : area.x + area.width - width - margin),
    y: Math.round(top ? area.y + margin : area.y + area.height - height - margin),
    width,
    height,
  };
}

/** A quick chat message from the overlay: plain text, one line, not too long. Null to send nothing. */
export function cleanQuickChat(v: unknown): string | null {
  return text(v, 2000);
}

export const isOverlayMode = (v: unknown): v is OverlayMode => OVERLAY_MODES.includes(v as OverlayMode);
export const isOverlayCorner = (v: unknown): v is OverlayCorner => OVERLAY_CORNERS.includes(v as OverlayCorner);
