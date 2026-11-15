import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AdminAccount, MySignIns, SignInMove } from "@dendrop/shared";
import { LinkedElsewhere } from "../src/auth/oidc.js";
import { account, startServer, type TestServer } from "./helpers.js";

describe("linking an existing account to TinyAuth, and moving a TinyAuth login between accounts", () => {
  let s: TestServer;
  let admin: string, raccoon: string;
  let adminId: number, raccoonId: number;

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });

  before(async () => {
    // TinyAuth configured (never contacted: these tests drive the account logic directly).
    s = await startServer({
      DENDROP_PUBLIC_URL: "https://chat.example.com",
      DENDROP_OIDC_ISSUER: "https://auth.example.com",
      DENDROP_OIDC_CLIENT_ID: "dendrop",
    });
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    raccoon = await account(s, "raccoon");
    adminId = s.ctx.users.byUsername("admin")!.id;
    raccoonId = s.ctx.users.byUsername("raccoon")!.id;
  });
  after(() => s.close());

  it("shows TinyAuth in Settings → Sign-in, and says why when it can't be linked", async () => {
    const mine = (await req(raccoon, "GET", "/api/me/signins")).json<MySignIns>();
    assert.deepEqual(mine.tinyauth, { name: "TinyAuth", linked: false, available: true, account: null, note: null });
    assert.equal(mine.google.available, false);
    assert.equal(mine.google.note, null, "only super admins hear what isn't set up");
    const adminView = (await req(admin, "GET", "/api/me/signins")).json<MySignIns>();
    assert.match(adminView.google.note!, /DENDROP_GOOGLE_CLIENT_ID/);

    await s.ctx.signin.save({ tinyauth: false });
    const off = (await req(raccoon, "GET", "/api/me/signins")).json<MySignIns>();
    assert.equal(off.tinyauth.available, false);
    assert.match(off.tinyauth.note!, /switched off signing in with TinyAuth/);
    await s.ctx.signin.save({ tinyauth: true });
  });

  it("offers to move a TinyAuth login a first sign-in put on an account of its own", async () => {
    // Their first TinyAuth sign-in made a separate, unused account.
    const stray = s.ctx.oidc.provision({ sub: "ta-raccoon", preferred_username: "rocky", email: "rocky@den.example" });
    assert.notEqual(stray.id, raccoonId);
    assert.equal(stray.oidcEmail, "rocky@den.example");
    assert.equal(stray.oidcUsername, "rocky");

    // Linking it from their real account finds it taken...
    assert.throws(() => s.ctx.oidc.link(raccoonId, { sub: "ta-raccoon" }), LinkedElsewhere);
    // ...so coming back from TinyAuth hands them an offer to move it.
    const token = s.ctx.oidc.offerMove(raccoonId, stray.id);
    assert.equal((await req(admin, "GET", `/api/me/signins/tinyauth/moves/${token}`)).statusCode, 404, "only for the person who signed in");
    const offer = (await req(raccoon, "GET", `/api/me/signins/tinyauth/moves/${token}`)).json<SignInMove>();
    assert.equal(offer.login, "rocky@den.example");
    assert.equal(offer.from.user.id, stray.id);
    assert.equal(offer.from.messages, 0);
    assert.deepEqual(offer.from.otherWaysIn, []);

    const moved = await req(raccoon, "POST", `/api/me/signins/tinyauth/moves/${token}`, {});
    assert.equal(moved.statusCode, 200);
    assert.deepEqual(moved.json<MySignIns>().tinyauth, { name: "TinyAuth", linked: true, available: true, account: "rocky@den.example", note: null });
    assert.equal(s.ctx.users.byId(stray.id)!.oidcSubject, null);
    // Signing in with TinyAuth now lands in their real account.
    assert.equal(s.ctx.oidc.provision({ sub: "ta-raccoon" }).id, raccoonId);
    // The offer is used up.
    assert.equal((await req(raccoon, "POST", `/api/me/signins/tinyauth/moves/${token}`, {})).statusCode, 404);
  });

  it("lets the super admin link, move and unlink TinyAuth logins on any account", async () => {
    const url = (id: number) => `/api/admin/accounts/${id}/signins/tinyauth`;
    assert.equal((await req(raccoon, "PUT", url(adminId), { subject: "x" })).statusCode, 403);

    // A login that hasn't signed in yet, by its subject.
    const linked = await req(admin, "PUT", url(adminId), { subject: "ta-admin" });
    assert.equal(linked.statusCode, 200);
    assert.deepEqual(linked.json<AdminAccount>().tinyauthLogin, { subject: "ta-admin", email: null, username: null });
    s.ctx.oidc.provision({ sub: "ta-admin", preferred_username: "boss" });
    const list = (await req(admin, "GET", "/api/admin/accounts")).json<AdminAccount[]>();
    assert.equal(list.find((a) => a.user.id === adminId)!.tinyauthLogin!.username, "boss");

    // A subject another account has needs a yes to move.
    const helper = await account(s, "helper");
    const helperId = s.ctx.users.byUsername("helper")!.id;
    const asked = await req(admin, "PUT", url(helperId), { subject: "ta-raccoon" });
    assert.equal(asked.statusCode, 409);
    assert.match(asked.json().error, /on @raccoon/);
    const moved = await req(admin, "PUT", url(helperId), { subject: "ta-raccoon", move: true });
    assert.equal(moved.json<AdminAccount>().tinyauthLogin!.email, "rocky@den.example", "what TinyAuth told us moves with it");
    assert.equal(s.ctx.users.byId(raccoonId)!.oidcSubject, null);

    // Or picked by the account it's on.
    const back = await req(admin, "PUT", url(raccoonId), { fromAccount: helperId });
    assert.equal(back.json<AdminAccount>().tinyauth, true);
    assert.equal(s.ctx.users.byId(helperId)!.oidcSubject, null);
    assert.equal((await req(admin, "PUT", url(raccoonId), { fromAccount: helperId })).statusCode, 404, "nothing left to move");

    const audit = s.ctx.db.prepare("SELECT action FROM audit_log WHERE action = 'account.link'").all();
    assert.equal(audit.length, 3);

    assert.equal((await req(admin, "DELETE", url(raccoonId))).statusCode, 200);
    assert.equal(s.ctx.users.byId(raccoonId)!.oidcSubject, null);
    void helper;
  });
});
