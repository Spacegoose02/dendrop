/**
 * Keybinds for voice: push-to-talk, toggle mute and toggle deafen. Saved on this device.
 * Pressing a bind sends an event on `voiceControls`, which the call and voice panels listen to.
 * In the desktop app, mute and deafen are also registered as global shortcuts, so they work while
 * Dendrop is in the background.
 */
import { useEffect, useState } from "react";

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** KeyboardEvent.code: the physical key, so layouts and Shift don't change it. */
  code: string;
}

export type VoiceAction = "pushToTalk" | "mute" | "deafen";

export interface Keybinds {
  /** Voice activity sends when you talk (see input sensitivity); push to talk only while the key is held. */
  inputMode: "voice" | "ptt";
  binds: Record<VoiceAction, Combo | null>;
  /** PC app: push to talk works while Dendrop is in the background (a keyboard hook, only while you're in voice). */
  backgroundPtt: boolean;
}

export const DEFAULT_KEYBINDS: Keybinds = {
  inputMode: "voice",
  backgroundPtt: true,
  binds: {
    pushToTalk: null,
    mute: { ctrl: true, alt: false, shift: true, meta: false, code: "KeyM" },
    deafen: { ctrl: true, alt: false, shift: true, meta: false, code: "KeyD" },
  },
};

const KEY = "dendrop.keybinds";
const EVENT = "dendrop-keybinds";

export function loadKeybinds(): Keybinds {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Keybinds>;
    return {
      inputMode: saved.inputMode === "ptt" ? "ptt" : "voice",
      binds: { ...DEFAULT_KEYBINDS.binds, ...(saved.binds ?? {}) },
      backgroundPtt: saved.backgroundPtt !== false,
    };
  } catch {
    return structuredClone(DEFAULT_KEYBINDS);
  }
}

export function saveKeybinds(next: Keybinds): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: applies until reload.
  }
  dispatchEvent(new CustomEvent(EVENT));
}

export function useKeybinds(): Keybinds {
  const [k, setK] = useState(loadKeybinds);
  useEffect(() => {
    const update = () => setK(loadKeybinds());
    const onStorage = (e: StorageEvent) => e.key === KEY && update();
    addEventListener(EVENT, update);
    addEventListener("storage", onStorage);
    return () => {
      removeEventListener(EVENT, update);
      removeEventListener("storage", onStorage);
    };
  }, []);
  return k;
}

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

/** The combo a key press makes, or null for a lone modifier (still being held down to build a combo). */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
}

const sameCombo = (a: Combo, e: KeyboardEvent) =>
  a.code === e.code && a.ctrl === e.ctrlKey && a.alt === e.altKey && a.shift === e.shiftKey && a.meta === e.metaKey;

/** Punctuation and named keys: what's printed on them, and Electron's accelerator name. */
const KEYS: Record<string, [label: string, accelerator: string | null]> = {
  Backquote: ["`", "`"],
  Minus: ["-", "-"],
  Equal: ["=", "="],
  BracketLeft: ["[", "["],
  BracketRight: ["]", "]"],
  Backslash: ["\\", "\\"],
  Semicolon: [";", ";"],
  Quote: ["'", "'"],
  Comma: [",", ","],
  Period: [".", "."],
  Slash: ["/", "/"],
  Space: ["Space", "Space"],
  Tab: ["Tab", "Tab"],
  CapsLock: ["Caps Lock", null],
  Insert: ["Insert", "Insert"],
  Delete: ["Delete", "Delete"],
  Home: ["Home", "Home"],
  End: ["End", "End"],
  PageUp: ["Page Up", "PageUp"],
  PageDown: ["Page Down", "PageDown"],
  ArrowUp: ["↑", "Up"],
  ArrowDown: ["↓", "Down"],
  ArrowLeft: ["←", "Left"],
  ArrowRight: ["→", "Right"],
  Pause: ["Pause", null],
  ScrollLock: ["Scroll Lock", "Scrolllock"],
};

/** The key's name as printed on it, more or less. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return KEYS[code]?.[0] ?? code;
}

export function comboLabel(c: Combo): string {
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta", keyName(c.code)].filter(Boolean).join(" + ");
}

/** Electron accelerator for a combo, or null when Electron can't register that key. */
export function accelerator(c: Combo): string | null {
  let key: string | null | undefined;
  if (/^Key[A-Z]$/.test(c.code)) key = c.code.slice(3);
  else if (/^Digit\d$/.test(c.code)) key = c.code.slice(5);
  else if (/^Numpad\d$/.test(c.code)) key = `num${c.code.slice(6)}`;
  else if (/^F\d{1,2}$/.test(c.code)) key = c.code;
  else key = KEYS[c.code]?.[1];
  if (!key) return null;
  return [c.ctrl && "Control", c.alt && "Alt", c.shift && "Shift", c.meta && "Super", key].filter(Boolean).join("+");
}

// ---- Dispatch ---------------------------------------------------------------------------

export type VoiceControl = "mute" | "deafen" | "ptt-down" | "ptt-up";

/** Panels listen here for mute, deafen and push-to-talk. */
export const voiceControls = new EventTarget();
export const sendControl = (c: VoiceControl) => voiceControls.dispatchEvent(new Event(c));

let held = false;
/** Whether the push-to-talk key is held right now. */
export const pttHeld = () => held;

interface DesktopShortcuts {
  setShortcuts?: (accelerators: Record<string, string | null>) => Promise<Record<string, boolean>>;
  onShortcut?: (cb: (action: string) => void) => () => void;
  backgroundPtt?: (combo: Combo | null) => Promise<boolean>;
  onPtt?: (cb: (held: boolean) => void) => () => void;
}
const desktop = (): DesktopShortcuts | undefined => (window as unknown as { dendrop?: DesktopShortcuts }).dendrop;
/** The desktop app can register shortcuts that work while it's in the background. */
export const hasGlobalShortcuts = (): boolean => !!desktop()?.setShortcuts;
/** The desktop app can do push to talk in the background. */
export const hasBackgroundPtt = (): boolean => !!desktop()?.backgroundPtt;

// Calls and voice panels say when they're connected, so the background keyboard hook only runs then.
let voiceUsers = 0;
const voiceActivity = new EventTarget();
export function setVoiceActive(on: boolean): void {
  voiceUsers = Math.max(0, voiceUsers + (on ? 1 : -1));
  voiceActivity.dispatchEvent(new Event("change"));
}

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** Set while the settings dialog records a new bind, so pressing it doesn't also act. */
let recording = false;
export const setRecording = (on: boolean) => {
  recording = on;
};

/**
 * Listens for the keybinds in the window, and in the desktop app registers mute and deafen as
 * global shortcuts. Mounted once by the shell.
 */
export function useVoiceKeybinds(): void {
  const k = useKeybinds();
  const [globalOk, setGlobalOk] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (recording) return;
      // Keys without Ctrl, Alt or Meta are for typing when a text box has focus.
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      if (plain && editable(e.target)) return;
      const { pushToTalk, mute, deafen } = k.binds;
      if (k.inputMode === "ptt" && pushToTalk && sameCombo(pushToTalk, e)) {
        e.preventDefault();
        if (!held) {
          held = true;
          sendControl("ptt-down");
        }
        return;
      }
      if (e.repeat) return;
      // In the desktop app global shortcuts handle these, and the keys never reach the page.
      if (mute && sameCombo(mute, e) && !globalOk.mute) {
        e.preventDefault();
        sendControl("mute");
      } else if (deafen && sameCombo(deafen, e) && !globalOk.deafen) {
        e.preventDefault();
        sendControl("deafen");
      }
    };
    const release = () => {
      if (!held) return;
      held = false;
      sendControl("ptt-up");
    };
    const onUp = (e: KeyboardEvent) => {
      const p = k.binds.pushToTalk;
      // Letting go of any key of the combo ends it.
      if (p && (e.code === p.code || (p.ctrl && !e.ctrlKey) || (p.alt && !e.altKey) || (p.shift && !e.shiftKey) || (p.meta && !e.metaKey))) release();
    };
    // Switching windows mid-press never sends the key up.
    addEventListener("keydown", onDown);
    addEventListener("keyup", onUp);
    // With background push to talk the hook keeps track instead.
    const onBlur = () => {
      if (!(hasBackgroundPtt() && k.backgroundPtt)) release();
    };
    addEventListener("blur", onBlur);
    return () => {
      removeEventListener("keydown", onDown);
      removeEventListener("keyup", onUp);
      removeEventListener("blur", onBlur);
      release();
    };
  }, [k, globalOk]);

  // Desktop app: register mute and deafen system-wide.
  useEffect(() => {
    const d = desktop();
    if (!d?.setShortcuts) return;
    const acc = (c: Combo | null) => (c ? accelerator(c) : null);
    void d
      .setShortcuts({ mute: acc(k.binds.mute), deafen: acc(k.binds.deafen) })
      .then(setGlobalOk)
      .catch(() => setGlobalOk({}));
  }, [k]);

  // Desktop app: push to talk in the background, only while in voice with push to talk on.
  const [inVoice, setInVoice] = useState(voiceUsers > 0);
  useEffect(() => {
    const update = () => setInVoice(voiceUsers > 0);
    voiceActivity.addEventListener("change", update);
    return () => voiceActivity.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const d = desktop();
    if (!d?.backgroundPtt) return;
    const combo = k.inputMode === "ptt" && k.backgroundPtt && inVoice ? k.binds.pushToTalk : null;
    void d.backgroundPtt(combo).catch(() => {});
    return () => void d.backgroundPtt?.(null).catch(() => {});
  }, [k, inVoice]);
  useEffect(() => {
    const d = desktop();
    if (!d?.onPtt) return;
    return d.onPtt((down) => {
      if (down === held) return;
      held = down;
      sendControl(down ? "ptt-down" : "ptt-up");
    });
  }, []);

  useEffect(() => {
    const d = desktop();
    if (!d?.onShortcut) return;
    return d.onShortcut((action) => {
      if (action === "mute" || action === "deafen") sendControl(action);
    });
  }, []);
}
