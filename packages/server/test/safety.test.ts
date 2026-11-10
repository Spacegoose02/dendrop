import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ChatServer, Report } from "@dendrop/shared";
import { FailureLimiter } from "../src/auth/limiter.js";
import { LOGIN_TRIES_PER_NAME } from "../src/routes/auth.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("safety: blocking, reports, sign-in limits, deleting your account", () => {
  let s: TestServer;
  let admin: string, ann: string, bob: string, cat: string;
  let adminId: number, annId: number, bobId: number, catId: number;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? (res.headers["content-type"]?.toString().includes("json") ? res.json() : res.body) : null, headers: res.headers };
  };
  const befriend = async (a: string, b: string, bId: number, bName: string) => {
    await call(a, "POST", "/api/friends", { username: bName });
    const aId = (await call(a, "GET", "/api/me")).body.id as number;
    await call(b, "POST", `/api/friends/${aId}/accept`);
    void bId;
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    admin = await account(s, "admin");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    [adminId, annId, bobId, catId] = ["admin", "ann", "bob", "cat"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
  });
  after(() => s.close());

  it("blocking ends the friendship and stops requests and the DM both ways", async () => {
    await befriend(ann, bob, bobId, "bob");
    const dm = (await call(ann, "POST", "/api/conversations", { userId: bobId })).body.id as number;
    assert.equal((await call(bob, "POST", `/api/conversations/${dm}/messages`, { body: "hi" })).status, 200);

    const annLive = await listen(s, ann);
    const blocked = await call(ann, "POST", "/api/blocks", { userId: bobId });
    assert.equal(blocked.status, 200);
    assert.deepEqual((await annLive.waitFor("blocks.updated")).blocked.map((u) => u.id), [bobId]);
    annLive.ws.close();
    assert.deepEqual((await call(ann, "GET", "/api/friends")).body, []);
    assert.deepEqual((await call(bob, "GET", "/api/friends")).body, []);

    // Neither can send in the DM, call, or ask to be friends again.
    assert.equal((await call(bob, "POST", `/api/conversations/${dm}/messages`, { body: "hello?" })).status, 403);
    assert.equal((await call(ann, "POST", `/api/conversations/${dm}/messages`, { body: "bye" })).status, 403);
    assert.equal((await call(bob, "POST", `/api/conversations/${dm}/call`, {})).status, 403);
    // The blocked person sees the same answer as for a username that doesn't exist.
    const again = await call(bob, "POST", "/api/friends", { username: "ann" });
    assert.equal(again.status, 404);
    assert.equal(again.body.error, "No one has that username");
    assert.equal((await call(ann, "POST", "/api/friends", { username: "bob" })).status, 409);
    // The old messages stay readable.
    assert.equal((await call(ann, "GET", `/api/conversations/${dm}/messages`)).body.length, 1);

    assert.equal((await call(ann, "DELETE", `/api/blocks/${bobId}`)).status, 200);
    assert.deepEqual((await call(ann, "GET", "/api/blocks")).body, []);
    assert.equal((await call(ann, "DELETE", `/api/blocks/${bobId}`)).status, 404);
    assert.equal((await call(bob, "POST", "/api/friends", { username: "ann" })).body.state, "outgoing");
    assert.equal((await call(ann, "POST", "/api/blocks", { userId: annId })).status, 400);
  });

  it("limits wrong passwords per username, and a right one clears the count", async () => {
    const login = (password: string, username = "cat") => s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    for (let i = 0; i < LOGIN_TRIES_PER_NAME - 1; i++) assert.equal((await login("wrong password")).statusCode, 401);
    assert.equal((await login("correct horse battery")).statusCode, 200);
    for (let i = 0; i < LOGIN_TRIES_PER_NAME; i++) assert.equal((await login("wrong password")).statusCode, 401);
    const locked = await login("correct horse battery");
    assert.equal(locked.statusCode, 429);
    assert.match(locked.json().error, /Try again in 15 minutes/);
    assert.ok(Number(locked.headers["retry-after"]) > 0);
    // Other usernames still work, and the same name in other capitals counts as the same.
    assert.equal((await login("correct horse battery", "ann")).statusCode, 200);
    assert.equal((await login("correct horse battery", "CAT")).statusCode, 429);
  });

  it("the limiter lets tries back in as old failures age out", () => {
    let t = 0;
    const l = new FailureLimiter(3, 1000, () => t);
    for (const at of [0, 100, 200]) {
      t = at;
      l.fail("x");
    }
    t = 300;
    assert.equal(l.waitMs("x"), 700);
    t = 999;
    assert.equal(l.waitMs("x"), 1);
    t = 1000;
    assert.equal(l.waitMs("x"), 0);
  });

  it("reports in a server channel go to its moderators with the message's text", async () => {
    const sv = (await call(admin, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    const inv = (await call(admin, "POST", `/api/servers/${sv.id}/invites`, {})).body.code as string;
    await call(ann, "POST", `/api/invites/${inv}/accept`);
    await call(bob, "POST", `/api/invites/${inv}/accept`);
    const general = sv.channels[0]!;
    const m = (await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "buy my coins" })).body.id as number;

    const adminLive = await listen(s, admin);
    assert.equal((await call(ann, "POST", "/api/reports", { messageId: m, reason: "nope" })).status, 400);
    assert.equal((await call(bob, "POST", "/api/reports", { messageId: m, reason: "spam" })).status, 400);
    assert.equal((await call(cat, "POST", "/api/reports", { messageId: m, reason: "spam" })).status, 404);
    assert.equal((await call(ann, "POST", "/api/reports", { messageId: m, reason: "spam", details: "again" })).status, 200);
    assert.equal((await adminLive.waitFor("report.created")).serverId, sv.id);
    adminLive.ws.close();

    // Deleting the message doesn't lose what was said.
    await call(bob, "DELETE", `/api/messages/${m}`);
    assert.equal((await call(ann, "GET", `/api/servers/${sv.id}/reports`)).status, 403);
    const list = (await call(admin, "GET", `/api/servers/${sv.id}/reports`)).body as Report[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.quote, "buy my coins");
    assert.equal(list[0]!.place, "#general");
    assert.equal(list[0]!.reported!.id, bobId);
    assert.equal(list[0]!.reporter!.id, annId);
    // Not in the super admins' list, which is for DMs and people.
    assert.equal((await call(admin, "GET", "/api/admin/reports")).body.length, 0);

    const done = (await call(admin, "POST", `/api/reports/${list[0]!.id}/resolve`, { resolved: true })).body as Report;
    assert.ok(done.resolvedAt);
    assert.equal(done.resolvedBy!.id, adminId);
    assert.equal((await call(admin, "GET", `/api/servers/${sv.id}/reports?open=1`)).body.length, 0);
    assert.equal((await call(ann, "POST", `/api/reports/${list[0]!.id}/resolve`, {})).status, 403);
  });

  it("reports of people and DMs go to super admins, with only what the reporter shares", async () => {
    await befriend(cat, bob, bobId, "bob");
    const dm = (await call(cat, "POST", "/api/conversations", { userId: bobId })).body.id as number;
    const m = (await call(bob, "POST", `/api/conversations/${dm}/messages`, { body: "mean words" })).body.id as number;
    assert.equal((await call(cat, "POST", "/api/reports", { messageId: m, reason: "harassment" })).status, 200);
    assert.equal((await call(cat, "POST", "/api/reports", { userId: bobId, reason: "spam", details: "bot account" })).status, 200);
    assert.equal((await call(ann, "GET", "/api/admin/reports")).status, 403);
    const list = (await call(admin, "GET", "/api/admin/reports")).body as Report[];
    assert.deepEqual(
      list.map((r) => [r.reason, r.place, r.quote]),
      [
        ["spam", "Their account", null],
        ["harassment", "A group or direct message", "mean words"],
      ],
    );
  });

  it("downloads your data as one file", async () => {
    const r = await call(cat, "GET", "/api/me/export");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-disposition"]), /attachment; filename="dendrop-cat-/);
    const data = r.body;
    assert.equal(data.account.username, "cat");
    assert.equal(data.account.passwordHash, undefined);
    assert.equal(data.friends[0].user.username, "bob");
    assert.ok(Array.isArray(data.messages));
  });

  it("deletes an account after checking the password, and keeps owners and the last super admin from leaving things stranded", async () => {
    // A file, to check it's removed from disk.
    const dm = (await call(cat, "POST", "/api/conversations", { userId: bobId })).body.id as number;
    const form = new FormData();
    form.append("body", "a picture");
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "pic.png");
    const res = await fetch(`${s.url}/api/conversations/${dm}/messages`, { method: "POST", headers: { cookie: bob }, body: form });
    const fileId = ((await res.json()) as { attachments: { id: string }[] }).attachments[0]!.id;
    const file = path.join(s.ctx.config.dataDir, "uploads", fileId);
    assert.ok(existsSync(file));

    assert.equal((await call(bob, "DELETE", "/api/me", { password: "wrong one" })).status, 403);
    const catLive = await listen(s, cat);
    assert.equal((await call(bob, "DELETE", "/api/me", { password: "correct horse battery" })).status, 200);
    assert.equal((await catLive.waitFor("friend.removed")).userId, bobId);
    catLive.ws.close();
    assert.equal(s.ctx.users.byId(bobId), undefined);
    assert.equal(existsSync(file), false);
    assert.equal((await call(bob, "GET", "/api/me")).status, 401);
    // Their messages are gone, and reports about them stay, without a name.
    assert.equal((await call(cat, "GET", `/api/conversations/${dm}/messages`)).body.length, 0);
    assert.equal(((await call(admin, "GET", "/api/admin/reports")).body as Report[])[0]!.reported, null);

    // The owner of a server has to give it away first; the only super admin can't leave.
    const owner = await call(admin, "DELETE", "/api/me", { password: "correct horse battery" });
    assert.equal(owner.status, 409);
    assert.match(owner.body.error, /Den/);
    const sv = ((await call(admin, "GET", "/api/servers")).body as ChatServer[])[0]!;
    await call(admin, "DELETE", `/api/servers/${sv.id}`);
    assert.match((await call(admin, "DELETE", "/api/me", { password: "correct horse battery" })).body.error, /only super admin/);
    void catId;
  });
});
