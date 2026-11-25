import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppDownload } from "@dendrop/shared";
import { detectPlatform, formatSize, primaryDownload } from "../src/appPlatform.ts";

test("detectPlatform reads the browser's system", () => {
  const cases: Array<[string, string, number, string]> = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", "", 0, "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", "Win32", 0, "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15", "MacIntel", 0, "macos"],
    // iPadOS says it's a Mac, but has a touch screen.
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15", "MacIntel", 5, "ios"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "iPhone", 5, "ios"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36", "Linux armv8l", 5, "android"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", "Linux x86_64", 0, "linux"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", "", 0, "unknown"],
    ["curl/8.0", "", 0, "unknown"],
  ];
  for (const [ua, platform, touch, want] of cases) assert.equal(detectPlatform(ua, platform, touch), want, ua);
});

test("primaryDownload picks the first build for the system", () => {
  const f = (platform: AppDownload["platform"], kind: AppDownload["kind"]): AppDownload => ({ platform, kind, label: kind, file: kind, url: `https://x/${kind}`, size: 1 });
  const files = [f("windows", "installer"), f("windows", "portable"), f("android", "apk"), f("linux", "appimage")];
  assert.equal(primaryDownload(files, "windows")?.kind, "installer");
  assert.equal(primaryDownload(files, "android")?.kind, "apk");
  assert.equal(primaryDownload(files, "macos"), null);
  assert.equal(primaryDownload(files, "unknown"), null);
});

test("formatSize", () => {
  assert.equal(formatSize(120_606_400), "121 MB");
  assert.equal(formatSize(5_928_569), "5.9 MB");
  assert.equal(formatSize(0), "");
});
