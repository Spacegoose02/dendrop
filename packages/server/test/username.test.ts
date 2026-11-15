import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { AuditEntry, Me, Message } from "@dendrop/shared";
import { migrate, MIGRATIONS } from "../src/db.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("changing your username", () => {
  let s: TestServer;
  let admin: string, dad: string, mom: string;
  let dadId: number, momId: number;
  const req = async (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  /** A session cookie for an account made outside the sign-up form (TinyAuth, tests). */
  const cookieFor = async (userId: number): Promise<string> => {
    const { token } = s.ctx.sessions.create(userId, "test");
    return `dendrop_session=${token}`;
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    admin = await account(s, "admin");
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    [dadId, momId] = ["dad", "mom"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
  });
  after(() => s.close());

  it("checks whether a name is free as you type", async () => {
    assert.deepEqual((await req(dad, "GET", "/api/usernames/available?name=raccoon_dad")).body, { available: true });
    assert.equal((await req(dad, "GET", "/api/usernames/available?name=MOM")).body.available, false, "taken in any capitals");
    assert.equal((await req(dad, "GET", "/api/usernames/available?name=DAD")).body.available, true, "your own name in new capitals is fine");
    const bad = (await req(dad, "GET", "/api/usernames/available?name=has%20space")).body;
    assert.equal(bad.available, false);
    assert.match(bad.reason, /letters, numbers/);
    assert.equal((await req(dad, "GET", "/api/usernames/available?name=everyone")).body.available, false, "@everyone is saved for mentions");
    assert.equal((await s.app.inject("/api/usernames/available?name=x1")).statusCode, 401);
  });

  it("refuses bad, reserved and taken names", async () => {
    assert.equal((await req(dad, "PUT", "/api/me/username", { username: "a" })).status, 400);
    assert.equal((await req(dad, "PUT", "/api/me/username", { username: "no spaces" })).status, 400);
    assert.equal((await req(dad, "PUT", "/api/me/username", { username: "Everyone" })).status, 400);
    assert.equal((await req(dad, "PUT", "/api/me/username", { username: 42 })).status, 400);
    const taken = await req(dad, "PUT", "/api/me/username", { username: "Mom" });
    assert.equal(taken.status, 409);
    assert.equal(s.ctx.users.byId(dadId)!.username, "dad");
    // Signing up as "everyone" is refused too.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/signup", payload: { username: "everyone", password: "long enough pw" } })).statusCode, 400);
  });

  it("renames, and friends, DMs, mentions and password sign-in all carry on", async () => {
    // Friends with a DM and a mention from before the rename.
    await req(dad, "POST", "/api/friends", { username: "mom" });
    await req(mom, "POST", `/api/friends/${dadId}/accept`);
    const cid = (await req(dad, "POST", "/api/conversations", { userId: momId })).body.id as number;
    await req(mom, "POST", `/api/conversations/${cid}/messages`, { body: `hi <@${dadId}>` });

    const momLive = await listen(s, mom);
    const dadLive = await listen(s, dad);
    const res = await req(dad, "PUT", "/api/me/username", { username: "Raccoon.Dad" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as Me).username, "Raccoon.Dad");
    assert.equal((res.body as Me).id, dadId, "same account");

    // Friends and the people in your chats see the new name straight away, and so do your other devices.
    const seen = await momLive.waitFor("user.updated");
    assert.equal(seen.user.id, dadId);
    assert.equal(seen.user.username, "Raccoon.Dad");
    assert.equal((await dadLive.waitFor("me.updated")).user.username, "Raccoon.Dad");
    momLive.ws.close();
    dadLive.ws.close();

    const friends = (await req(mom, "GET", "/api/friends")).body as { user: { id: number; username: string }; state: string }[];
    assert.deepEqual(
      friends.map((f) => [f.user.id, f.user.username, f.state]),
      [[dadId, "Raccoon.Dad", "friends"]],
    );
    const history = (await req(dad, "GET", `/api/conversations/${cid}/messages`)).body as Message[];
    assert.deepEqual(history.at(-1)!.mentions, [dadId], "mentions point at the account, not the name");
    assert.equal((await req(dad, "GET", "/api/me")).body.username, "Raccoon.Dad", "the old session still works");

    // Password sign-in uses the new name; the old one is free for someone else.
    const login = (username: string) => s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "correct horse battery" } });
    assert.equal((await login("raccoon.dad")).statusCode, 200);
    assert.equal((await login("dad")).statusCode, 401);
    assert.equal((await req(mom, "POST", "/api/friends", { username: "dad" })).status, 404);
    assert.equal((await req(mom, "GET", "/api/usernames/available?name=dad")).body.available, true);

    // Super admins can still tell who it was.
    const log = (await req(admin, "GET", "/api/admin/audit")).body as AuditEntry[];
    const entry = log.find((e) => e.action === "account.rename");
    assert.ok(entry, "logged");
    assert.equal(entry.actor.id, dadId);
    assert.equal(entry.details, "@dad → @Raccoon.Dad");
  });

  it("lets you change only the capitals of your own name", async () => {
    const res = await req(mom, "PUT", "/api/me/username", { username: "MOM" });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, "MOM");
  });

  it("asks people whose first sign-in was TinyAuth or Google to pick a name, once", async () => {
    const sso = s.ctx.oidc.provision({ sub: "tiny-1", preferred_username: "jdoe42", name: "Jamie" });
    assert.equal(sso.username, "jdoe42");
    const cookie = await cookieFor(sso.id);
    assert.equal((await req(cookie, "GET", "/api/me")).body.pickUsername, true);

    // Keeping the name answers it.
    const kept = await req(cookie, "PUT", "/api/me/username", { username: "jdoe42" });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.pickUsername, false);
    assert.equal((await req(cookie, "GET", "/api/me")).body.pickUsername, false);
    // No log entry for keeping it.
    const log = (await req(admin, "GET", "/api/admin/audit")).body as AuditEntry[];
    assert.ok(!log.some((e) => e.details.includes("jdoe42")));

    // Another TinyAuth account picks a new one.
    const other = s.ctx.oidc.provision({ sub: "tiny-2", preferred_username: "user.xyz" });
    const c2 = await cookieFor(other.id);
    const picked = await req(c2, "PUT", "/api/me/username", { username: "jamie_r" });
    assert.equal(picked.body.username, "jamie_r");
    assert.equal(picked.body.pickUsername, false);
    assert.equal(s.ctx.oidc.provision({ sub: "tiny-2" }).id, other.id, "TinyAuth still finds the account by its sign-in, not its name");

    // Password and Google-linked accounts aren't asked.
    assert.equal((await req(mom, "GET", "/api/me")).body.pickUsername, false);
  });

  it("doesn't hand out a reserved name from a sign-in provider", () => {
    const u = s.ctx.oidc.provision({ sub: "tiny-3", preferred_username: "everyone" });
    assert.notEqual(u.username.toLowerCase(), "everyone");
  });

  it("leaves kid accounts under a parent to their parent", async () => {
    const kid = s.ctx.users.create({ username: "little_kit", displayName: "Kit", managedBy: momId });
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kid.id, momId, new Date().toISOString());
    const c = await cookieFor(kid.id);
    assert.equal((await req(c, "PUT", "/api/me/username", { username: "big_kit" })).status, 403);
    assert.equal(s.ctx.users.byId(kid.id)!.username, "little_kit");
  });

  it("asks existing accounts that only ever signed in through TinyAuth or Google, after upgrading", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const step = MIGRATIONS.findIndex((m) => m.includes("username_picked"));
    for (const m of MIGRATIONS.slice(0, step)) db.exec(m);
    db.exec(`PRAGMA user_version = ${step}`);
    const add = db.prepare("INSERT INTO users (username, display_name, password_hash, oidc_subject, google_subject, is_bot, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')");
    add.run("pw_only", "A", "hash", null, null, 0);
    add.run("tiny_only", "B", null, "sub-b", null, 0);
    add.run("google_only", "C", null, null, "g-c", 0);
    add.run("pw_and_tiny", "D", "hash", "sub-d", null, 0);
    add.run("a_bot", "E", null, null, null, 1);
    migrate(db);
    const rows = db.prepare("SELECT username, username_picked FROM users ORDER BY id").all() as { username: string; username_picked: number }[];
    assert.deepEqual(
      rows.map((r) => [r.username, r.username_picked]),
      [
        ["pw_only", 1],
        ["tiny_only", 0],
        ["google_only", 0],
        ["pw_and_tiny", 1],
        ["a_bot", 1],
      ],
    );
  });
});
