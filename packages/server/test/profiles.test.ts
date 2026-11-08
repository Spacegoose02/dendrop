import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { liveStatus, type FamilyAlert, type FamilyKid, type Me, type UserProfile } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const boundary = "----dendrop";
const form = (type = "image/png") =>
  Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="p.png"\r\ncontent-type: ${type}\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

describe("profiles", () => {
  let s: TestServer;
  let admin: string, ann: string, bob: string, eve: string, mom: string, kit: string;
  let annId: number, bobId: number, eveId: number, kitId: number;

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const upload = (cookie: string, kind: "avatar" | "banner") =>
    s.app.inject({ method: "PUT", url: `/api/me/${kind}`, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: form() });
  const me = async (cookie: string) => (await req(cookie, "GET", "/api/me")).json() as Me;
  const befriend = async (a: string, b: string, aId: number) => {
    const bName = (await me(b)).username;
    assert.equal((await req(a, "POST", "/api/friends", { username: bName })).statusCode, 200);
    assert.equal((await req(b, "POST", `/api/friends/${aId}/accept`)).statusCode, 200);
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    admin = await account(s, "admin");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    eve = await account(s, "eve");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    [annId, bobId, eveId, kitId] = await Promise.all([ann, bob, eve, kit].map(async (c) => (await me(c)).id)) as [number, number, number, number];
    await befriend(ann, bob, annId);
    // Parents need encryption on before a kid can be linked to them.
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const b64 = (n: number) => randomBytes(n).toString("base64url");
    const keys = await req(mom, "PUT", "/api/e2ee", {
      publicKey: ecdh.getPublicKey().toString("base64url"),
      backup: { salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) },
    });
    assert.equal(keys.statusCode, 200, keys.body);
    assert.equal((await req(admin, "POST", "/api/admin/family", { parent: "mom", kid: "kit" })).statusCode, 200);
  });
  after(() => s.close());

  it("saves a bio, pronouns, banner color and custom status, and friends see them", async () => {
    const bobWs = await listen(s, bob);
    const r = await req(ann, "PATCH", "/api/me/profile", {
      bio: "Raccoon wrangler.\n\n\n\nLikes snacks.",
      pronouns: "  she / her ",
      bannerColor: "#FFAA00",
      status: { emoji: "🦝", text: " Digging   through the bins ", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json() as UserProfile;
    assert.equal(p.bio, "Raccoon wrangler.\n\nLikes snacks.");
    assert.equal(p.pronouns, "she / her");
    assert.equal(p.bannerColor, "#ffaa00");
    assert.equal(p.user.status?.text, "Digging through the bins");
    assert.equal(p.user.status?.emoji, "🦝");
    // Friends hear about the new status straight away.
    const e = await bobWs.waitFor("user.updated");
    assert.equal(e.user.id, annId);
    assert.equal(e.user.status?.text, "Digging through the bins");
    bobWs.ws.close();

    const seen = await req(bob, "GET", `/api/users/${annId}/profile`);
    assert.equal(seen.statusCode, 200);
    const sp = seen.json() as UserProfile;
    assert.equal(sp.bio, "Raccoon wrangler.\n\nLikes snacks.");
    assert.ok(sp.friendsSince);
  });

  it("checks what a profile takes", async () => {
    assert.equal((await req(ann, "PATCH", "/api/me/profile", { bio: "x".repeat(191) })).statusCode, 400);
    assert.equal((await req(ann, "PATCH", "/api/me/profile", { bannerColor: "orange" })).statusCode, 400);
    assert.equal((await req(ann, "PATCH", "/api/me/profile", { status: { emoji: "not an emoji", text: "hi" } })).statusCode, 400);
    assert.equal((await req(ann, "PATCH", "/api/me/profile", { status: { text: "old", expiresAt: "2001-01-01T00:00:00Z" } })).statusCode, 400);
    assert.equal((await req(ann, "PATCH", "/api/me/profile", { status: { emoji: null, text: "  " } })).statusCode, 400);
  });

  it("drops an expired status", () => {
    assert.equal(liveStatus({ emoji: null, text: "brb", expiresAt: new Date(Date.now() - 1000).toISOString() }), null);
    assert.ok(liveStatus({ emoji: null, text: "brb", expiresAt: null }));
  });

  it("keeps profiles and pictures from strangers", async () => {
    assert.equal((await upload(ann, "avatar")).statusCode, 200);
    const avatar = (await me(ann)).avatar!;
    assert.match(avatar, new RegExp(`^/api/users/${annId}/pictures/[0-9a-f]{32}$`));
    const ok = await req(bob, "GET", avatar);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["content-type"], "image/png");
    assert.equal((await req(eve, "GET", avatar)).statusCode, 404);
    assert.equal((await req(eve, "GET", `/api/users/${annId}/profile`)).statusCode, 404);
    // A new picture replaces the old one, and taking it down clears it.
    assert.equal((await upload(ann, "avatar")).statusCode, 200);
    assert.equal((await req(bob, "GET", avatar)).statusCode, 404);
    assert.equal((await req(ann, "DELETE", "/api/me/avatar")).statusCode, 200);
    assert.equal((await me(ann)).avatar, null);
    const bad = await s.app.inject({ method: "PUT", url: "/api/me/banner", headers: { cookie: ann, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: form("text/html") });
    assert.equal(bad.statusCode, 400);
    void eveId;
    void bobId;
  });

  it("follows parents' rules for kids", async () => {
    // Pictures wait for a parent's OK.
    assert.equal((await upload(kit, "avatar")).statusCode, 403);
    // The family filter checks the bio and status.
    assert.equal((await req(kit, "PATCH", "/api/me/profile", { bio: "this is shit" })).statusCode, 400);
    assert.equal((await req(kit, "PATCH", "/api/me/profile", { status: { emoji: null, text: "f*ck homework" } })).statusCode, 400);
    const ok = await req(kit, "PATCH", "/api/me/profile", { bio: "I like dinosaurs", pronouns: "he/him" });
    assert.equal(ok.statusCode, 200, ok.body);
    // Parents hear about it, and can see the kid's profile.
    const alerts = (await req(mom, "GET", "/api/family/alerts")).json() as FamilyAlert[];
    assert.ok(alerts.some((a) => a.type === "profile" && a.kid.id === kitId));
    assert.equal(((await req(mom, "GET", `/api/users/${kitId}/profile`)).json() as UserProfile).bio, "I like dinosaurs");

    // Mom turns pictures on, kit sets one; turning them off takes it down.
    const on = await req(mom, "PATCH", `/api/family/kids/${kitId}`, { profilePictures: true });
    assert.equal((on.json() as FamilyKid).rules.profilePictures, true);
    assert.equal((await upload(kit, "avatar")).statusCode, 200);
    assert.ok((await me(kit)).avatar);
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { profilePictures: false });
    assert.equal((await me(kit)).avatar, null);

    // Only a parent can clear a kid's profile.
    assert.equal((await req(ann, "DELETE", `/api/family/kids/${kitId}/profile`)).statusCode, 404);
    const reset = await req(mom, "DELETE", `/api/family/kids/${kitId}/profile`);
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal((reset.json() as UserProfile).bio, "");
    assert.equal((reset.json() as UserProfile).isKid, true);
  });

  it("tells friends when a name or color changes", async () => {
    const annWs = await listen(s, ann);
    assert.equal((await req(bob, "PATCH", "/api/me", { nameColor: "#33aa55" })).statusCode, 200);
    const e = await annWs.waitFor("user.updated");
    assert.equal(e.user.nameColor, "#33aa55");
    annWs.ws.close();
  });
});
