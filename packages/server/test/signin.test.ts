import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AdminAccount, AdminSignIn, AuthInfo, FamilyKid, Me, MySignIns } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const publicKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
};

describe("linked sign-ins, the admin's sign-in switches, and kid accounts under a parent", () => {
  let s: TestServer;
  let admin: string, mom: string;
  let momId: number;

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const login = async (username: string, password: string) => {
    const r = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { status: r.statusCode, cookie: r.cookies.find((c) => c.name === "dendrop_session") ? `dendrop_session=${r.cookies.find((c) => c.name === "dendrop_session")!.value}` : "" };
  };

  before(async () => {
    // Google configured (it's never contacted: these tests drive the account logic directly).
    s = await startServer({ DENDROP_SIGNUP: "false", DENDROP_PUBLIC_URL: "https://chat.example.com", DENDROP_GOOGLE_CLIENT_ID: "id", DENDROP_GOOGLE_CLIENT_SECRET: "secret" });
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    mom = await account(s, "mom");
    momId = s.ctx.users.byUsername("mom")!.id;
  });
  after(() => s.close());

  it("starts from the DENDROP_* settings, and only a super admin can change them", async () => {
    const info = (await s.app.inject({ method: "GET", url: "/api/auth/info" })).json<AuthInfo>();
    assert.equal(info.signup, true);
    assert.equal(info.google.enabled, true);
    assert.equal(info.oidc.enabled, false, "TinyAuth isn't configured");
    assert.equal((await req(mom, "GET", "/api/admin/signin")).statusCode, 403);
    const view = (await req(admin, "GET", "/api/admin/signin")).json<AdminSignIn>();
    assert.deepEqual(view.configured, { tinyauth: false, tinyauthName: "TinyAuth", google: true, publicUrl: true });

    const off = await req(admin, "PUT", "/api/admin/signin", { signup: false });
    assert.equal(off.json<AdminSignIn>().settings.signup, false);
    const r = await s.app.inject({ method: "POST", url: "/api/auth/signup", payload: { username: "stranger", password: "a long password" } });
    assert.equal(r.statusCode, 403);
    await req(admin, "PUT", "/api/admin/signin", { signup: true });
    assert.equal((await req(admin, "PUT", "/api/admin/signin", { signup: "yes" })).statusCode, 400);
  });

  it("won't let the admin switch off their own only way in", async () => {
    const r = await req(admin, "PUT", "/api/admin/signin", { passwordLogin: false });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /lock you out/);
    // With Google linked, password sign-in can go.
    s.ctx.google.link(s.ctx.users.byUsername("admin")!.id, { sub: "google-admin", email: "admin@gmail.com" });
    assert.equal((await req(admin, "PUT", "/api/admin/signin", { passwordLogin: false })).statusCode, 200);
    assert.equal((await login("mom", "correct horse battery")).status, 403);
    await req(admin, "PUT", "/api/admin/signin", { passwordLogin: true });
    assert.equal((await login("mom", "correct horse battery")).status, 200);
  });

  it("links Google to the account someone signed up with", async () => {
    const before = (await req(mom, "GET", "/api/me/signins")).json<MySignIns>();
    assert.deepEqual(before.google, { linked: false, email: null, available: true });
    assert.equal(before.password, true);
    assert.equal(before.canLink, true);
    assert.equal((await req(mom, "POST", "/api/me/signins/tinyauth")).statusCode, 404, "TinyAuth isn't set up");
  });

  it("signs in with a linked Google account, and won't share one between accounts", () => {
    // Before linking, an unknown Google account gets no account while Google sign-up is off.
    assert.throws(() => s.ctx.google.provisionGoogle({ sub: "google-mom" }), /Sign in another way, then link Google/);
    s.ctx.google.link(momId, { sub: "google-mom", email: "mom@gmail.com" });
    assert.equal(s.ctx.google.provisionGoogle({ sub: "google-mom" }).id, momId);
    assert.throws(() => s.ctx.google.link(momId, { sub: "google-admin" }), /already linked to another Dendrop account/);
  });

  it("only unlinks while another way in is left", async () => {
    const r = await req(mom, "DELETE", "/api/me/signins/google");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json<MySignIns>().google.linked, false);

    // A Google-only account (made when Google sign-up is on) can't drop Google until it has a password.
    await req(admin, "PUT", "/api/admin/signin", { googleSignup: true });
    const g = s.ctx.google.provisionGoogle({ sub: "google-new", email: "sam.raccoon@gmail.com", email_verified: true, name: "Sam" });
    assert.equal(g.username, "sam.raccoon");
    assert.equal(g.email, "sam.raccoon@gmail.com");
    const { token } = s.ctx.sessions.create(g.id);
    const sam = `dendrop_session=${token}`;
    assert.equal((await req(sam, "DELETE", "/api/me/signins/google")).statusCode, 409);
    assert.equal((await req(sam, "PUT", "/api/me/password", { password: "short" })).statusCode, 400);
    assert.equal((await req(sam, "PUT", "/api/me/password", { password: "sam's long password" })).statusCode, 200, "no current password to give");
    assert.equal((await req(sam, "DELETE", "/api/me/signins/google")).statusCode, 200);
  });

  it("changing a password needs the current one and signs out other devices", async () => {
    const other = (await login("mom", "correct horse battery")).cookie;
    assert.equal((await req(mom, "PUT", "/api/me/password", { current: "wrong", password: "a new long password" })).statusCode, 403);
    assert.equal((await req(mom, "PUT", "/api/me/password", { current: "correct horse battery", password: "a new long password" })).statusCode, 200);
    assert.equal((await req(mom, "GET", "/api/me")).statusCode, 200, "this device stays signed in");
    assert.equal((await req(other, "GET", "/api/me")).statusCode, 401, "the other one is signed out");
    assert.equal((await login("mom", "a new long password")).status, 200);
  });

  it("linking can be switched off", async () => {
    await req(admin, "PUT", "/api/admin/signin", { linking: false });
    assert.equal((await req(mom, "POST", "/api/me/signins/google")).statusCode, 403);
    assert.throws(() => s.ctx.google.link(momId, { sub: "google-mom-2" }), /switched off/);
    assert.equal((await req(mom, "GET", "/api/me/signins")).json<MySignIns>().canLink, false);
    await req(admin, "PUT", "/api/admin/signin", { linking: true });
  });

  it("lets the admin see and fix everyone's sign-ins", async () => {
    assert.equal((await req(mom, "GET", "/api/admin/accounts")).statusCode, 403);
    const list = (await req(admin, "GET", "/api/admin/accounts")).json<AdminAccount[]>();
    const a = list.find((x) => x.user.username === "admin")!;
    assert.equal(a.google, "admin@gmail.com");
    assert.equal(a.password, true);
    const removed = await req(admin, "DELETE", `/api/admin/accounts/${a.user.id}/signins/google`);
    assert.equal(removed.json<AdminAccount>().google, null);
    const reset = await req(admin, "PUT", `/api/admin/accounts/${momId}/password`, { password: "reset by the admin" });
    assert.equal(reset.statusCode, 200);
    assert.equal((await req(mom, "GET", "/api/me")).statusCode, 401, "signed out everywhere");
    mom = (await login("mom", "reset by the admin")).cookie;
    assert.ok(mom);
  });

  it("lets a parent make a kid account under theirs, and look after its password", async () => {
    const kidBody = { username: "kit", displayName: "Kit", password: "kit's first password", timezone: "America/Chicago" };
    const noKey = await req(mom, "POST", "/api/family/kids", kidBody);
    assert.equal(noKey.statusCode, 409, "parents need encryption on first");
    assert.equal(s.ctx.users.byUsername("kit"), undefined, "no half-made account");
    await req(mom, "PUT", "/api/e2ee", { publicKey: publicKey(), backup: { salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) } });

    const made = await req(mom, "POST", "/api/family/kids", kidBody);
    assert.equal(made.statusCode, 200, made.body);
    const kidView = made.json<FamilyKid>();
    assert.equal(kidView.managed, true);
    assert.equal(kidView.parents[0]!.id, momId);

    let kit = (await login("kit", "kit's first password")).cookie;
    const me = (await req(kit, "GET", "/api/me")).json<Me>();
    assert.equal(me.isKid, true);
    assert.equal(me.managedBy, momId);
    const mine = (await req(kit, "GET", "/api/me/signins")).json<MySignIns>();
    assert.equal(mine.canLink, false);
    assert.equal(mine.managedBy!.id, momId);
    assert.equal((await req(kit, "PUT", "/api/me/password", { current: "kit's first password", password: "kit picks one" })).statusCode, 403);
    assert.equal((await req(kit, "POST", "/api/me/signins/google")).statusCode, 403);
    assert.throws(() => s.ctx.google.link(kidView.user.id, { sub: "google-kit" }), /parent looks after/);

    // Mom resets it; Kit is signed out and uses the new one.
    assert.equal((await req(admin, "PUT", `/api/family/kids/${kidView.user.id}/password`, { password: "not your kid" })).statusCode, 404);
    assert.equal((await req(mom, "PUT", `/api/family/kids/${kidView.user.id}/password`, { password: "kit's new password" })).statusCode, 200);
    assert.equal((await req(kit, "GET", "/api/me")).statusCode, 401);
    kit = (await login("kit", "kit's new password")).cookie;

    // The last parent can't unlink an account only they look after; handing it over works.
    assert.equal((await req(mom, "DELETE", `/api/family/kids/${kidView.user.id}`)).statusCode, 409);
    const released = await req(mom, "POST", `/api/family/kids/${kidView.user.id}/release`);
    assert.equal(released.json<FamilyKid>().managed, false);
    assert.equal((await req(kit, "GET", "/api/me")).json<Me>().isKid, true, "still a kid account, still linked");
    assert.equal((await req(kit, "PUT", "/api/me/password", { current: "kit's new password", password: "kit picks one now" })).statusCode, 200);
    assert.equal((await req(mom, "PUT", `/api/family/kids/${kidView.user.id}/password`, { password: "mom can't now" })).statusCode, 409);
  });

  it("making kid accounts can be switched off, and kids can't make them", async () => {
    await req(admin, "PUT", "/api/admin/signin", { parentKidAccounts: false });
    const r = await req(mom, "POST", "/api/family/kids", { username: "kit2", password: "a long password" });
    assert.equal(r.statusCode, 403);
    await req(admin, "PUT", "/api/admin/signin", { parentKidAccounts: true });
    const kit = (await login("kit", "kit picks one now")).cookie;
    assert.equal((await req(kit, "POST", "/api/family/kids", { username: "kit3", password: "a long password" })).statusCode, 403);
  });
});
