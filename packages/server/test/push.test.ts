import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { account, listen, startServer, type TestServer } from "./helpers.js";

interface Sent {
  url: string;
  body: Buffer | string;
  headers: Record<string, string>;
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};

/** Decrypts an RFC 8291 aes128gcm push the way a phone does. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

describe("phone notifications", () => {
  let s: TestServer;
  const sent: Sent[] = [];
  let status = 201;
  let dad: string, mom: string;
  let dm: number;
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const wait = async (n: number) => {
    for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };

  before(async () => {
    s = await startServer(
      { DENDROP_SIGNUP: "true", DENDROP_LIVEKIT_URL: "wss://x", DENDROP_LIVEKIT_API_KEY: "k", DENDROP_LIVEKIT_API_SECRET: "s".repeat(32) },
      {
        pushPost: async (url, body, headers) => {
          sent.push({ url, body, headers });
          return status;
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

  it("gives out a VAPID key and takes subscriptions only from signed-in people", async () => {
    const cfg = (await s.app.inject("/api/push/config")).json();
    assert.match(cfg.vapidPublicKey, /^[\w-]{80,}$/);
    const anon = await s.app.inject({ method: "POST", url: "/api/push/subscriptions", payload: { endpoint: "https://ntfy.sh/upX" } });
    assert.equal(anon.statusCode, 401);
    const http = await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint: "http://10.0.0.2/up" } });
    assert.equal(http.statusCode, 400, "http endpoints need DENDROP_PUSH_ALLOW_HTTP");
    const ok = await s.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: mom },
      payload: {
        endpoint: "https://ntfy.example/upMom",
        keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
        provider: "unifiedpush",
        deviceName: "Pixel 8",
      },
    });
    assert.equal(ok.statusCode, 204);
  });

  it("wakes the phone with an encrypted, content-free push when nothing is open", async () => {
    sent.length = 0;
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/messages`, headers: { cookie: dad }, payload: { body: "secret dinner plans" } });
    await wait(1);
    assert.equal(sent.length, 1);
    const p = sent[0]!;
    assert.equal(p.url, "https://ntfy.example/upMom");
    assert.equal(p.headers["Content-Encoding"], "aes128gcm");
    assert.match(p.headers.Authorization!, /^vapid t=/);
    assert.ok(!Buffer.from(p.body).toString("latin1").includes("dinner"));
    assert.equal(decrypt(Buffer.from(p.body), ua, auth), '{"type":"message"}');
  });

  it("doesn't push while the app is open, but always rings phones for a new call", async () => {
    const momLive = await listen(s, mom);
    sent.length = 0;
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/messages`, headers: { cookie: dad }, payload: { body: "hi" } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 0);
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/call`, headers: { cookie: dad }, payload: {} });
    await wait(1);
    assert.equal(decrypt(Buffer.from(sent[0]!.body), ua, auth), '{"type":"call"}');
    assert.equal(sent[0]!.headers.Urgency, "high");
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/call/leave`, headers: { cookie: dad }, payload: {} });
    momLive.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("sends a plain push to endpoints without keys, and forgets endpoints that are gone", async () => {
    await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint: "https://ntfy.example/upPlain" } });
    sent.length = 0;
    status = 410;
    await s.app.inject({ method: "POST", url: `/api/conversations/${dm}/messages`, headers: { cookie: dad }, payload: { body: "anyone?" } });
    await wait(2);
    const plain = sent.find((x) => x.url.endsWith("upPlain"))!;
    assert.equal(plain.body, '{"type":"message"}');
    const left = s.ctx.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number };
    assert.equal(Number(left.n), 0);
    status = 201;
  });

  it("unsubscribes only your own endpoints", async () => {
    await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint: "https://ntfy.example/upMom2" } });
    await s.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: { cookie: dad }, payload: { endpoint: "https://ntfy.example/upMom2" } });
    assert.ok(s.ctx.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get("https://ntfy.example/upMom2"));
    const del = await s.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: { cookie: mom }, payload: { endpoint: "https://ntfy.example/upMom2" } });
    assert.equal(del.statusCode, 204);
    assert.ok(!s.ctx.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get("https://ntfy.example/upMom2"));
  });
});
