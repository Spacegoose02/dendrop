import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { ApnsRequest } from "../src/apns.js";
import { account, startServer, type TestServer } from "./helpers.js";

describe("iPhone notifications (APNs)", () => {
  let s: TestServer;
  const sent: ApnsRequest[] = [];
  let answer: { status: number; reason?: string } = { status: 200 };
  let dad: string, mom: string;
  let dm: number;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const alertToken = "ab".repeat(32);
  const voipToken = "cd".repeat(32);
  const wait = async (n: number) => {
    for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };

  before(async () => {
    s = await startServer(
      {
        DENDROP_SIGNUP: "true",
        DENDROP_LIVEKIT_URL: "wss://x",
        DENDROP_LIVEKIT_API_KEY: "k",
        DENDROP_LIVEKIT_API_SECRET: "s".repeat(32),
        // As it would come from an env var: the .p8 text with \n for line breaks.
        DENDROP_APNS_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n"),
        DENDROP_APNS_KEY_ID: "KEY1234567",
        DENDROP_APNS_TEAM_ID: "TEAM123456",
      },
      {
        apnsSend: async (req) => {
          sent.push(req);
          return answer;
        },
      },
    );
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    const dadId = s.ctx.users.byUsername("dad")!.id;
    const momId = s.ctx.users.byUsername("mom")!.id;
    await s.app.inject({ method: "POST", url: "/api/friends", headers: { cookie: dad }, payload: { username: "mom" } });
    await s.app.inject({ method: "POST", url: `/api/friends/${dadId}/accept`, headers: { cookie: mom } });
    dm = (await s.app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: dad }, payload: { userId: momId } })).json().id;
  });
  after(() => s.close());

  it("says it can reach iPhones, and takes only well-formed APNs endpoints", async () => {
    const cfg = (await s.app.inject("/api/push/config")).json();
    assert.deepEqual(cfg.apns, { enabled: true, bundleId: "io.github.spacegoose02.dendrop" });
    for (const endpoint of ["apns://production/xyz", "apns://staging/" + alertToken, "apns-voip://production/" + "ab".repeat(10)]) {
      const bad = await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint } });
      assert.equal(bad.statusCode, 400, endpoint);
    }
    for (const endpoint of [`apns://production/${alertToken}`, `apns-voip://sandbox/${voipToken}`]) {
      const ok = await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint, provider: "apns", deviceName: "iPhone" } });
      assert.equal(ok.statusCode, 204, endpoint);
    }
    const rows = s.ctx.db.prepare("SELECT endpoint, provider FROM push_subscriptions ORDER BY endpoint").all();
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { endpoint: `apns-voip://sandbox/${voipToken}`, provider: "apns-voip" },
        { endpoint: `apns://production/${alertToken}`, provider: "apns" },
      ],
    );
  });

  it("sends a message as a fixed, content-free alert to the alert token only", async () => {
    sent.length = 0;
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/messages`, headers: { cookie: dad }, payload: { body: "secret dinner plans" } });
    await wait(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 1);
    const p = sent[0]!;
    assert.equal(p.host, "api.push.apple.com");
    assert.equal(p.path, `/3/device/${alertToken}`);
    assert.equal(p.headers["apns-push-type"], "alert");
    assert.equal(p.headers["apns-topic"], "io.github.spacegoose02.dendrop");
    assert.equal(p.headers["apns-collapse-id"], "message");
    assert.ok(!p.body.includes("dinner") && !p.body.includes("dad"));
    assert.deepEqual(JSON.parse(p.body), {
      aps: { alert: { title: "Dendrop", body: "You have a new message" }, sound: "default", "thread-id": "message" },
      type: "message",
    });
    // The provider token is an ES256 JWT signed with the .p8 key.
    const [h, c, sig] = p.headers.authorization!.replace(/^bearer /, "").split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
    assert.equal(JSON.parse(Buffer.from(c!, "base64url").toString()).iss, "TEAM123456");
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url")));
  });

  it("rings a call through the VoIP token, on the sandbox for Xcode builds", async () => {
    sent.length = 0;
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/call`, headers: { cookie: dad }, payload: {} });
    await wait(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 1);
    const p = sent[0]!;
    assert.equal(p.host, "api.sandbox.push.apple.com");
    assert.equal(p.path, `/3/device/${voipToken}`);
    assert.equal(p.headers["apns-push-type"], "voip");
    assert.equal(p.headers["apns-topic"], "io.github.spacegoose02.dendrop.voip");
    assert.deepEqual(JSON.parse(p.body), { type: "call" });
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/call/leave`, headers: { cookie: dad }, payload: {} });
  });

  it("forgets tokens Apple says are gone or bad", async () => {
    sent.length = 0;
    answer = { status: 400, reason: "BadDeviceToken" };
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/messages`, headers: { cookie: dad }, payload: { body: "still there?" } });
    await wait(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!s.ctx.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(`apns://production/${alertToken}`));
    assert.ok(s.ctx.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(`apns-voip://sandbox/${voipToken}`));
    answer = { status: 200 };
  });
});

describe("iPhone notifications without an APNs key", () => {
  let s: TestServer;
  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
  });
  after(() => s.close());

  it("still saves the token, and says iPhones can't be reached yet", async () => {
    const mom = await account(s, "mom");
    assert.deepEqual((await s.app.inject("/api/push/config")).json().apns, { enabled: false, bundleId: null });
    const ok = await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint: `apns://production/${"ef".repeat(32)}` } });
    assert.equal(ok.statusCode, 204);
  });
});
