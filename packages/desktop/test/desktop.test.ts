import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isExternalLink, onOrigin, permissionAllowed } from "../src/links.js";
import { normalizeServerUrl, originOf } from "../src/serverUrl.js";
import { defaultSettings, SettingsStore } from "../src/settings.js";
import { compareVersions, installKind, parseChecksums, pickUpdate } from "../src/updater.js";

test("server addresses are normalized", () => {
  assert.equal(normalizeServerUrl("tower:8080"), "http://tower:8080");
  assert.equal(normalizeServerUrl("192.168.1.20:8080/"), "http://192.168.1.20:8080");
  assert.equal(normalizeServerUrl("tower"), "http://tower");
  assert.equal(normalizeServerUrl("chat.example.com"), "https://chat.example.com");
  assert.equal(normalizeServerUrl("  https://chat.example.com/app?x=1  "), "https://chat.example.com");
  assert.throws(() => normalizeServerUrl(""), /Enter/);
  assert.throws(() => normalizeServerUrl("ftp://x"), /http/);
  assert.throws(() => normalizeServerUrl("https://me:pw@chat.example.com"), /password/);
  assert.equal(originOf("file:///etc/passwd"), "");
  assert.equal(originOf("https://chat.example.com"), "https://chat.example.com");
});

test("only web links leave the app", () => {
  assert.equal(isExternalLink("https://example.com"), true);
  assert.equal(isExternalLink("mailto:a@b.c"), true);
  for (const bad of ["file:///C:/Windows/System32/calc.exe", "smb://host/share", "ms-msdt:/id", "javascript:alert(1)", "nonsense"]) assert.equal(isExternalLink(bad), false, bad);
  assert.equal(onOrigin("https://chat.example.com.evil.net/", "https://chat.example.com"), false);
  assert.equal(onOrigin("https://chat.example.com/x", "https://chat.example.com"), true);
});

test("pages can't use the system notification API, and other sites get nothing", () => {
  const at = "https://chat.example.com";
  assert.equal(permissionAllowed("notifications", `${at}/`, at), false);
  assert.equal(permissionAllowed("media", `${at}/`, at), true);
  assert.equal(permissionAllowed("media", "https://evil.example/", at), false);
  assert.equal(permissionAllowed("geolocation", `${at}/`, at), false);
});

test("settings default to private notifications and no autostart, and survive a broken file", () => {
  const d = defaultSettings();
  assert.equal(d.openAtLogin, false);
  assert.equal(d.notifySender, false);
  const dir = mkdtempSync(path.join(os.tmpdir(), "dd-settings-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, "{ broken");
  const store = new SettingsStore(file);
  assert.deepEqual(store.get(), d);
  store.update({ serverUrl: "https://chat.example.com", openAtLogin: true });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).openAtLogin, true);
  assert.equal(new SettingsStore(file).get().serverUrl, "https://chat.example.com");
});

test("updates pick the newest build of the same kind", () => {
  const files = [
    { name: "Dendrop-Setup-0.2.0.exe", size: 1 },
    { name: "Dendrop-Setup-0.10.0.exe", size: 2 },
    { name: "Dendrop-0.10.0-portable.exe", size: 3 },
    { name: "Dendrop-0.10.0-linux-x86_64.AppImage", size: 4 },
    { name: "Dendrop-0.10.0-linux-amd64.deb", size: 5 },
  ];
  assert.equal(pickUpdate(files, "0.1.0", "installer")?.file, "Dendrop-Setup-0.10.0.exe");
  assert.equal(pickUpdate(files, "0.1.0", "portable")?.file, "Dendrop-0.10.0-portable.exe");
  assert.equal(pickUpdate(files, "0.1.0", "appimage")?.file, "Dendrop-0.10.0-linux-x86_64.AppImage");
  assert.equal(pickUpdate(files, "0.10.0", "installer"), null);
  assert.equal(pickUpdate(files, "0.1.0", "other"), null);
  assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
  assert.equal(installKind({}, "win32"), "installer");
  assert.equal(installKind({ PORTABLE_EXECUTABLE_FILE: "x" }, "win32"), "portable");
  assert.equal(installKind({ APPIMAGE: "/x" }, "linux"), "appimage");
  assert.equal(installKind({}, "linux"), "other");
  const sums = parseChecksums(`${"a".repeat(64)}  Dendrop-Setup-0.10.0.exe\n`);
  assert.equal(sums.get("Dendrop-Setup-0.10.0.exe"), "a".repeat(64));
});
