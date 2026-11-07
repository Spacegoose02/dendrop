import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCombo, ComboTracker, hookKeyName, setBackgroundPtt, stopBackgroundPtt } from "../src/ptt.js";

const key = (keycode: number, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  keycode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("web key codes map to the hook's key names", () => {
  assert.equal(hookKeyName("KeyV"), "V");
  assert.equal(hookKeyName("Digit4"), "4");
  assert.equal(hookKeyName("F13"), "F13");
  assert.equal(hookKeyName("Numpad0"), "Numpad0");
  assert.equal(hookKeyName("Backquote"), "Backquote");
  assert.equal(hookKeyName("CapsLock"), "CapsLock");
  assert.equal(hookKeyName("MediaPlayPause"), null);
});

test("only well-formed combos from the page are used", () => {
  assert.deepEqual(cleanCombo({ code: "KeyV", ctrl: true, alt: "yes" }), { ctrl: true, alt: false, shift: false, meta: false, code: "KeyV" });
  assert.equal(cleanCombo({ code: "NotAKey" }), null);
  assert.equal(cleanCombo("KeyV"), null);
  assert.equal(cleanCombo(null), null);
});

test("push to talk is held while the combo is down, and only reports held or let go", () => {
  const seen: boolean[] = [];
  const t = new ComboTracker({ ctrl: true, alt: false, shift: false, meta: false, code: "KeyV" }, 47, (h) => seen.push(h));
  t.down(key(47)); // no Ctrl: not the combo
  t.down(key(30, { ctrlKey: true })); // another key: ignored
  t.down(key(47, { ctrlKey: true }));
  t.down(key(47, { ctrlKey: true })); // key repeat
  t.down(key(47, { ctrlKey: true, shiftKey: true })); // still held, extra modifiers are fine
  t.up(key(30, { ctrlKey: true })); // a different key let go
  assert.deepEqual(seen, [true]);
  t.up(key(29)); // Ctrl let go
  assert.deepEqual(seen, [true, false]);
  t.down(key(47, { ctrlKey: true, shiftKey: true }));
  t.up(key(47, { ctrlKey: true }));
  t.release();
  assert.deepEqual(seen, [true, false, true, false]);
});

test("turning it off when it was never on is harmless", () => {
  stopBackgroundPtt();
  assert.equal(setBackgroundPtt(null, () => {}), false);
});
