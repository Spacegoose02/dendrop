import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitleBarColors, DEFAULT_TITLE_BAR, themedTitleBar, TITLE_BAR_HEIGHT, titleBarCss, titleBarOptions } from "../src/titlebar.js";

test("Windows and Linux hide the grey title bar and keep themed window buttons; macOS keeps its own", () => {
  assert.equal(themedTitleBar("win32"), true);
  assert.equal(themedTitleBar("linux"), true);
  assert.equal(themedTitleBar("darwin"), false);
  assert.deepEqual(titleBarOptions("win32"), { titleBarStyle: "hidden", titleBarOverlay: { ...DEFAULT_TITLE_BAR, height: TITLE_BAR_HEIGHT } });
  assert.deepEqual(titleBarOptions("darwin"), {});
});

test("only plain hex colors reach the window buttons", () => {
  assert.deepEqual(cleanTitleBarColors({ color: " #121418 ", symbolColor: "#FFF" }), { color: "#121418", symbolColor: "#fff" });
  for (const bad of [null, "x", {}, { color: "#121418" }, { color: "red", symbolColor: "#fff" }, { color: "#12141", symbolColor: "#fff" }, { color: "#121418;x", symbolColor: "#fff" }])
    assert.equal(cleanTitleBarColors(bad), null, JSON.stringify(bad));
});

test("pages make room for the bar, and lose it in full screen", () => {
  const css = titleBarCss();
  assert.match(css, /--dendrop-titlebar-height: 32px/);
  assert.match(css, /dendrop-fullscreen \{ --dendrop-titlebar-height: 0px/);
  assert.match(css, /-webkit-app-region: drag/);
  assert.match(css, /dialog:modal/);
});
