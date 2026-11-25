import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AppDownloads } from "@dendrop/shared";
import { DownloadsService, pickDownloads } from "../src/downloads.js";
import { startServer, type TestServer } from "./helpers.js";

const release = (tag: string, names: string[]) => ({
  tag_name: tag,
  html_url: `https://github.com/Spacegoose02/dendrop/releases/tag/${tag}`,
  assets: names.map((name, i) => ({ name, size: 1000 + i })),
});

const V090 = release("v0.9.0", [
  "Dendrop-0.9.0-android-debug.apk",
  "Dendrop-0.9.0-linux-amd64.deb",
  "Dendrop-0.9.0-linux-x86_64.AppImage",
  "Dendrop-0.9.0-portable.exe",
  "Dendrop-Setup-0.9.0.exe",
  "SHA256SUMS",
]);

describe("app downloads", () => {
  it("lists each app build, best first per system, with its release link", () => {
    const d = pickDownloads(V090);
    assert.equal(d.version, "0.9.0");
    assert.equal(d.releaseUrl, "https://github.com/Spacegoose02/dendrop/releases/tag/v0.9.0");
    assert.deepEqual(
      d.files.map((f) => [f.platform, f.kind, f.file]),
      [
        ["windows", "installer", "Dendrop-Setup-0.9.0.exe"],
        ["windows", "portable", "Dendrop-0.9.0-portable.exe"],
        ["android", "apk", "Dendrop-0.9.0-android-debug.apk"],
        ["linux", "appimage", "Dendrop-0.9.0-linux-x86_64.AppImage"],
        ["linux", "deb", "Dendrop-0.9.0-linux-amd64.deb"],
      ],
    );
    assert.equal(d.files[0]!.url, "https://github.com/Spacegoose02/dendrop/releases/download/v0.9.0/Dendrop-Setup-0.9.0.exe");
    assert.equal(d.files[0]!.size, 1004);
  });

  it("offers the signed Android APK over the debug one", () => {
    const d = pickDownloads(release("v1.0.0", ["Dendrop-1.0.0-android-debug.apk", "Dendrop-1.0.0-android.apk"]));
    assert.deepEqual(d.files.map((f) => f.file), ["Dendrop-1.0.0-android.apk"]);
  });

  it("doesn't trust links to other places", () => {
    const d = pickDownloads({ ...V090, html_url: "https://evil.example/x" });
    assert.equal(d.releaseUrl, "https://github.com/Spacegoose02/dendrop/releases/latest");
  });

  it("asks GitHub once in a while, and keeps the last list when GitHub fails", async () => {
    let calls = 0;
    let fail = false;
    const svc = new DownloadsService(async () => {
      calls++;
      if (fail) return new Response("busy", { status: 503 });
      return Response.json(V090);
    });
    const t = 1_000_000;
    assert.equal((await svc.latest(t)).files.length, 5);
    await svc.latest(t + 60_000);
    assert.equal(calls, 1);
    fail = true;
    const stale = await svc.latest(t + 20 * 60_000);
    assert.equal(calls, 2);
    assert.equal(stale.version, "0.9.0");
    // Not again straight after a failure.
    await svc.latest(t + 20 * 60_000 + 1000);
    assert.equal(calls, 2);
  });

  it("is empty before the first release", async () => {
    const svc = new DownloadsService(async () => new Response("", { status: 404 }));
    const d = await svc.latest();
    assert.equal(d.version, null);
    assert.deepEqual(d.files, []);
  });

  describe("GET /api/downloads", () => {
    let s: TestServer;
    before(async () => {
      s = await startServer({}, { downloadsFetch: async () => Response.json(V090) });
    });
    after(() => s.close());

    it("works without signing in", async () => {
      const res = await s.app.inject({ method: "GET", url: "/api/downloads" });
      assert.equal(res.statusCode, 200);
      const d = res.json<AppDownloads>();
      assert.equal(d.version, "0.9.0");
      assert.equal(d.files[0]!.kind, "installer");
    });
  });
});
