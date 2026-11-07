/**
 * Push to talk while Dendrop is in the background, for games. Electron's global shortcuts can't
 * see a key being let go, so this uses a keyboard hook (uiohook-napi).
 *
 * Privacy: the hook only runs while the page asks for it (you're in a call or voice channel with
 * push to talk on, and background push to talk is allowed), and it is stopped the moment that
 * ends. Every key other than the push-to-talk combo is dropped right here; only "held" or "let go"
 * is passed on, never which keys were pressed.
 */

export interface PttCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** KeyboardEvent.code, as the web client stores it. */
  code: string;
}

interface HookKeyEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

interface Hook {
  on(event: "keydown" | "keyup", fn: (e: HookKeyEvent) => void): unknown;
  removeAllListeners(event?: string): unknown;
  start(): void;
  stop(): void;
}

/** uiohook's key names mostly match KeyboardEvent.code; these are the ones that differ or need a prefix stripped. */
export function hookKeyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^(Numpad\d|F\d{1,2})$/.test(code)) return code;
  const same = [
    "Semicolon",
    "Equal",
    "Comma",
    "Minus",
    "Period",
    "Slash",
    "Backquote",
    "BracketLeft",
    "Backslash",
    "BracketRight",
    "Quote",
    "Space",
    "Tab",
    "CapsLock",
    "Insert",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ScrollLock",
  ];
  return same.includes(code) ? code : null;
}

/** Checks a combo sent by the page. */
export function cleanCombo(v: unknown): PttCombo | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.code !== "string" || c.code.length > 32 || !hookKeyName(c.code)) return null;
  return { ctrl: c.ctrl === true, alt: c.alt === true, shift: c.shift === true, meta: c.meta === true, code: c.code };
}

/**
 * Tracks one combo through key events and says when it's held and let go.
 * Separate from the hook so it can be tested without one.
 */
export class ComboTracker {
  private held = false;
  constructor(
    private readonly combo: PttCombo,
    private readonly keycode: number,
    private readonly onChange: (held: boolean) => void,
  ) {}

  down(e: HookKeyEvent): void {
    if (this.held || e.keycode !== this.keycode) return;
    const c = this.combo;
    // The modifiers asked for must be down; extra ones (Shift while running in a game) don't matter.
    if ((c.ctrl && !e.ctrlKey) || (c.alt && !e.altKey) || (c.shift && !e.shiftKey) || (c.meta && !e.metaKey)) return;
    this.held = true;
    this.onChange(true);
  }

  up(e: HookKeyEvent): void {
    if (!this.held) return;
    const c = this.combo;
    if (e.keycode === this.keycode || (c.ctrl && !e.ctrlKey) || (c.alt && !e.altKey) || (c.shift && !e.shiftKey) || (c.meta && !e.metaKey)) {
      this.held = false;
      this.onChange(false);
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    this.onChange(false);
  }
}

let hook: Hook | null | undefined;
let keys: Record<string, number> = {};

/** The native hook, loaded the first time it's needed. Null if it can't load on this system. */
function loadHook(): Hook | null {
  if (hook !== undefined) return hook;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("uiohook-napi") as { uIOhook: Hook; UiohookKey: Record<string, number> };
    hook = mod.uIOhook;
    keys = mod.UiohookKey;
  } catch {
    hook = null;
  }
  return hook;
}

let running: ComboTracker | null = null;

/**
 * Starts watching for this combo (or stops, for null). Returns whether background push to talk
 * is running, which it can't on Wayland or if the hook didn't load.
 */
export function setBackgroundPtt(combo: PttCombo | null, onChange: (held: boolean) => void): boolean {
  stopBackgroundPtt();
  if (!combo) return false;
  const h = loadHook();
  const name = hookKeyName(combo.code);
  const keycode = name ? keys[name] : undefined;
  if (!h || keycode === undefined) return false;
  const tracker = new ComboTracker(combo, keycode, onChange);
  h.on("keydown", (e) => tracker.down(e));
  h.on("keyup", (e) => tracker.up(e));
  try {
    h.start();
  } catch {
    h.removeAllListeners("keydown");
    h.removeAllListeners("keyup");
    return false;
  }
  running = tracker;
  return true;
}

export function stopBackgroundPtt(): void {
  if (!running || !hook) return;
  running.release();
  running = null;
  hook.removeAllListeners("keydown");
  hook.removeAllListeners("keyup");
  try {
    hook.stop();
  } catch {
    // Already stopped.
  }
}
