import assert from "node:assert/strict";
import { test } from "node:test";
import { clampUserVolume, DEFAULT_USER_VOLUME, effectiveUserGain, loadUserVolumes, saveUserVolume, userVolume } from "../../web/src/audio.ts";

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

test("per-person volume clamps between 0% and 200% and defaults to 100%", () => {
  assert.equal(clampUserVolume(undefined), 100);
  assert.equal(clampUserVolume("not a number"), 100);
  assert.equal(clampUserVolume(-20), 0);
  assert.equal(clampUserVolume(0), 0);
  assert.equal(clampUserVolume(135.4), 135);
  assert.equal(clampUserVolume(250), 200);
});

test("saveUserVolume persists custom volumes and local mutes, and drops entries reset to 100%", () => {
  const store = installMemoryStorage();
  assert.deepEqual(userVolume(42), DEFAULT_USER_VOLUME);

  assert.deepEqual(saveUserVolume(42, { volume: 165 }), { volume: 165, muted: false });
  assert.deepEqual(userVolume("42"), { volume: 165, muted: false });

  assert.deepEqual(saveUserVolume(42, { muted: true }), { volume: 165, muted: true });
  assert.deepEqual(loadUserVolumes(), { "42": { volume: 165, muted: true } });

  // Resetting to 100% and unmuted removes the entry and cleans up storage when empty.
  assert.deepEqual(saveUserVolume(42, { volume: 100, muted: false }), { volume: 100, muted: false });
  assert.deepEqual(loadUserVolumes(), {});
  assert.equal(store.has("dendrop.userVolumes"), false);
});

test("effectiveUserGain combines master volume, per-person boost up to 200%, local mute and deafen", () => {
  assert.equal(effectiveUserGain({ outputVolume: 100 }, { volume: 100, muted: false }), 1);
  assert.equal(effectiveUserGain({ outputVolume: 100 }, { volume: 200, muted: false }), 2);
  assert.equal(effectiveUserGain({ outputVolume: 80 }, { volume: 150, muted: false }), 1.2);
  assert.equal(effectiveUserGain({ outputVolume: 50 }, { volume: 50, muted: false }), 0.25);
  assert.equal(effectiveUserGain({ outputVolume: 100 }, { volume: 150, muted: true }), 0);
  assert.equal(effectiveUserGain({ outputVolume: 100 }, { volume: 150, muted: false }, true), 0);
});
