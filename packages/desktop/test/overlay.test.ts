import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanOverlayState, cleanQuickChat, EMPTY_OVERLAY, overlayBounds, overlayVisible, OVERLAY_SIZE } from "../src/overlay.js";

const state = (patch: object = {}) =>
  cleanOverlayState({
    channel: "playing-stardew",
    server: "Den",
    members: [{ id: 1, name: "Mom", speaking: true, muted: false, deafened: false, me: true }],
    messages: [{ id: 5, author: "Dad", text: "gg" }],
    playing: null,
    canChat: true,
    ...patch,
  });

test("follows LootDen: in game mode it shows only while you're playing", () => {
  assert.equal(overlayVisible(state(), "game"), false);
  assert.equal(overlayVisible(state({ playing: "Stardew Valley" }), "game"), true);
  assert.equal(overlayVisible(state(), "voice"), true);
  assert.equal(overlayVisible(state({ playing: "Stardew Valley" }), "off"), false);
  // Not in voice: never.
  assert.equal(overlayVisible(EMPTY_OVERLAY, "voice"), false);
});

test("checks and trims what the page sends", () => {
  assert.deepEqual(cleanOverlayState(null), EMPTY_OVERLAY);
  assert.deepEqual(cleanOverlayState({ channel: 5 }), EMPTY_OVERLAY);
  const s = cleanOverlayState({
    channel: "lounge\u0000",
    members: [{ id: "x", name: "a".repeat(100), speaking: "yes" }, null, 7],
    messages: Array.from({ length: 20 }, (_, i) => ({ id: i, author: "A", text: `m${i}` })).concat([{ id: 99, author: "B", text: "   " }]),
    playing: "",
  });
  assert.equal(s.channel, "lounge");
  assert.equal(s.members.length, 1);
  assert.equal(s.members[0]!.id, 0);
  assert.equal(s.members[0]!.speaking, false);
  assert.equal(s.members[0]!.name.length, 40);
  // The last few messages, minus empty ones.
  assert.deepEqual(s.messages.map((m) => m.text), ["m15", "m16", "m17", "m18", "m19"]);
  assert.equal(s.playing, null);
  assert.equal(s.canChat, false);
});

test("sits in the chosen corner of the screen", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(overlayBounds(area, "top-left"), { x: 16, y: 16, ...OVERLAY_SIZE });
  assert.deepEqual(overlayBounds(area, "bottom-right"), { x: 1920 - OVERLAY_SIZE.width - 16, y: 1040 - OVERLAY_SIZE.height - 16, ...OVERLAY_SIZE });
  // A second screen to the left.
  assert.equal(overlayBounds({ x: -1280, y: 0, width: 1280, height: 1000 }, "top-right").x, -OVERLAY_SIZE.width - 16);
});

test("quick chat is plain text", () => {
  assert.equal(cleanQuickChat("  gg  "), "gg");
  assert.equal(cleanQuickChat("   "), null);
  assert.equal(cleanQuickChat(5), null);
});
