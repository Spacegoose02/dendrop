import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AutomodEvent, AutomodSettings, ChatServer, ServerInvite } from "@dendrop/shared";
import { linkHosts } from "../src/automod.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("automod", () => {
  let s: TestServer;
  let owner: string, bob: string, cat: string;
  let bobId: number, catId: number;
  let serverId: number;
  let general: { id: number; conversationId: number };
  let offTopic: { id: number; conversationId: number };
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const post = (cookie: string, conv: { conversationId: number }, body: string) =>
    call(cookie, "POST", `/api/conversations/${conv.conversationId}/messages`, { body });
  const rules = (patch: object) => call(owner, "PATCH", `/api/servers/${serverId}/automod`, patch);
  const events = async () => (await call(owner, "GET", `/api/servers/${serverId}/automod/events`)).body as AutomodEvent[];
  const reset = () =>
    rules({
      words: { enabled: false },
      spam: { enabled: false },
      links: { enabled: false },
      newAccounts: { enabled: false },
    });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", DENDROP_PUBLIC_URL: "https://chat.example.net" });
    owner = await account(s, "owner");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    [bobId, catId] = ["bob", "cat"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    offTopic = (await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "off-topic" })).body;
    for (const who of [bob, cat]) {
      const inv = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
      assert.equal((await call(who, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    }
  });
  after(() => s.close());

  it("starts with every rule off, and only moderators see the rules", async () => {
    const r = await call(owner, "GET", `/api/servers/${serverId}/automod`);
    assert.equal(r.status, 200);
    const a = r.body as AutomodSettings;
    assert.equal(a.words.enabled || a.spam.enabled || a.links.enabled || a.newAccounts.enabled, false);
    assert.deepEqual(a.words.exemptRoles, ["owner", "admin"]);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}/automod`)).status, 403);
    assert.equal((await call(bob, "PATCH", `/api/servers/${serverId}/automod`, { words: { enabled: true } })).status, 403);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}/automod/events`)).status, 403);
    assert.equal((await post(bob, general, "shit happens")).status, 200);
  });

  it("checks the settings it's given", async () => {
    assert.equal((await rules({ nope: {} })).status, 400);
    assert.equal((await rules({ words: { actions: ["explode"] } })).status, 400);
    assert.equal((await rules({ words: { words: ["two words"] } })).status, 400);
    assert.equal((await rules({ spam: { maxMessages: 1000 } })).status, 400);
    assert.equal((await rules({ links: { allowedDomains: ["not a site"] } })).status, 400);
    assert.equal((await rules({ words: { exemptChannelIds: [999999] } })).status, 400);
    assert.equal((await rules({ words: { exemptRoles: ["god"] } })).status, 400);
    const ok = await rules({ words: { words: [" Darn ", "darn", "heck*"] }, links: { allowedDomains: ["https://www.YouTube.com/watch?v=1"] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.words.words, ["darn", "heck*"]);
    assert.deepEqual(ok.body.links.allowedDomains, ["youtube.com"]);
  });

  it("blocks words with the kid-safe filter, logs it and alerts moderators", async () => {
    await rules({ words: { enabled: true, actions: ["block", "alert"], words: ["darn", "heck*"] } });
    const live = await listen(s, owner);
    const r = await post(bob, general, "well d4rn it");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /word this server blocks/);
    const alert = await live.waitFor("automod.alert");
    live.ws.close();
    assert.equal(alert.event.rule, "words");
    assert.equal(alert.event.user?.id, bobId);
    assert.equal(alert.event.reason, "Blocked word: d4rn");
    assert.equal(alert.event.excerpt, "well d4rn it");
    assert.deepEqual(alert.event.actions, ["block", "alert"]);
    // The built-in list is on by default, and stems catch longer words.
    assert.equal((await post(bob, general, "what the f*ck")).status, 400);
    assert.equal((await post(bob, general, "heckin good")).status, 400);
    // Words that only contain a blocked word are fine.
    assert.equal((await post(bob, general, "darning socks in Scunthorpe")).status, 200);
    // Nothing blocked was saved.
    const msgs = (await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).body as { body: string }[];
    assert.ok(!msgs.some((m) => m.body.includes("d4rn")));
    assert.equal((await events())[0]!.reason, "Blocked word: heckin");
  });

  it("can use only the server's own words", async () => {
    await rules({ words: { useBuiltinList: false } });
    assert.equal((await post(bob, general, "oh shit")).status, 200);
    assert.equal((await post(bob, general, "darn")).status, 400);
    await rules({ words: { useBuiltinList: true } });
  });

  it("leaves exempt roles and channels alone", async () => {
    // The owner is exempt by default.
    assert.equal((await post(owner, general, "darn")).status, 200);
    await rules({ words: { exemptRoles: [] } });
    assert.equal((await post(owner, general, "darn")).status, 400);
    await rules({ words: { exemptRoles: ["owner", "admin"], exemptChannelIds: [offTopic.id] } });
    assert.equal((await post(bob, offTopic, "darn")).status, 200);
    assert.equal((await post(bob, general, "darn")).status, 400);
    // A deleted channel drops out of the exemptions.
    const temp = (await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "temp" })).body;
    await rules({ words: { exemptChannelIds: [offTopic.id, temp.id] } });
    await call(owner, "DELETE", `/api/servers/${serverId}/channels/${temp.id}`);
    assert.deepEqual((await call(owner, "GET", `/api/servers/${serverId}/automod`)).body.words.exemptChannelIds, [offTopic.id]);
  });

  it("checks edits too", async () => {
    const m = (await post(bob, general, "nice")).body;
    const r = await call(bob, "PATCH", `/api/messages/${m.id}`, { body: "darn nice" });
    assert.equal(r.status, 400);
    assert.equal((await call(bob, "PATCH", `/api/messages/${m.id}`, { body: "very nice" })).status, 200);
  });

  it("only logs when a rule has no actions", async () => {
    await rules({ words: { actions: [] } });
    const before = (await events()).length;
    assert.equal((await post(bob, general, "darn")).status, 200);
    const after = await events();
    assert.equal(after.length, before + 1);
    assert.deepEqual(after[0]!.actions, []);
    await reset();
  });

  it("filters links, except allowed sites and this Dendrop", async () => {
    await rules({ links: { enabled: true, actions: ["block"], allowedDomains: ["youtube.com"] } });
    assert.equal((await post(bob, general, "free nitro at https://scam.example.org/claim")).status, 400);
    assert.equal((await post(bob, general, "go to cheap-games.xyz now")).status, 400);
    assert.equal((await post(bob, general, "watch https://www.youtube.com/watch?v=abc")).status, 200);
    assert.equal((await post(bob, general, "or m.youtube.com/watch")).status, 200);
    assert.equal((await post(bob, general, "join https://chat.example.net/invite/abc")).status, 200);
    assert.equal((await post(bob, general, "mail me at bob@example.com, notes in plan.txt")).status, 200);
    assert.equal((await events())[0]!.reason, "Link to cheap-games.xyz");
    await reset();
  });

  it("finds link hosts", () => {
    assert.deepEqual(linkHosts("see https://A.Example.com:8080/x?y and www.foo.org, also bar.gg/abc"), ["a.example.com", "foo.org", "bar.gg"]);
    assert.deepEqual(linkHosts("e.g. version 1.2.3 in file.txt, mail a@b.com"), []);
  });

  it("stops flooding with a timeout, and the timeout stops posting in the whole server", async () => {
    await rules({ spam: { enabled: true, actions: ["block", "timeout"], maxMessages: 3, perSeconds: 60, maxDuplicates: 0, maxMentions: 0, timeoutMinutes: 5 } });
    // Earlier tests posted in general; start the count fresh.
    s.ctx.db.prepare("UPDATE messages SET created_at = '2000-01-01T00:00:00.000Z' WHERE author_id = ?").run(catId);
    const live = await listen(s, cat);
    for (const n of [1, 2, 3]) assert.equal((await post(cat, general, `msg ${n}`)).status, 200);
    const r = await post(cat, general, "msg 4");
    assert.equal(r.status, 403);
    assert.match(r.body.error, /timed you out for 5 minutes because of spam \(4 messages in 60 seconds\)/);
    const update = await live.waitFor("server.updated");
    live.ws.close();
    assert.ok(update.server.timedOutUntil);
    const blocked = await post(cat, offTopic, "hello?");
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /timed out in this server for 5 minutes/);

    const list = (await call(owner, "GET", `/api/servers/${serverId}/timeouts`)).body;
    assert.equal(list[0].user.id, catId);
    assert.equal(list[0].by, null);
    assert.match(list[0].reason, /^Automod: /);
    // Moderators end it early.
    assert.equal((await call(bob, "DELETE", `/api/servers/${serverId}/timeouts/${catId}`)).status, 403);
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/timeouts/${catId}`)).status, 200);
    assert.equal((await call(cat, "GET", `/api/servers/${serverId}`)).body.timedOutUntil, null);
    await reset();
  });

  it("catches repeats and mention spam", async () => {
    await rules({ spam: { enabled: true, actions: ["block"], maxMessages: 0, maxDuplicates: 2, maxMentions: 2 } });
    assert.equal((await post(cat, general, "buy now")).status, 200);
    assert.equal((await post(cat, general, "Buy now")).status, 200);
    const r = await post(cat, general, "buy now");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /same message 3 times/);
    assert.equal((await post(cat, general, "@bob @owner look")).status, 200);
    assert.equal((await post(cat, general, "@bob @owner @everyone look")).status, 400);
    // Names that aren't members, and email addresses, aren't mentions.
    assert.equal((await post(cat, general, "@nobody @ghost @bob mail x@owner.com")).status, 200);
    await reset();
  });

  it("holds back new accounts and people who just joined", async () => {
    await rules({ newAccounts: { enabled: true, actions: ["block"], minAccountAgeHours: 24, minMemberMinutes: 0 } });
    const r = await post(cat, general, "hi");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /account is too new/);
    s.ctx.db.prepare("UPDATE users SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(catId);
    assert.equal((await post(cat, general, "hi")).status, 200);
    await rules({ newAccounts: { minAccountAgeHours: 0, minMemberMinutes: 30 } });
    const j = await post(cat, general, "hi again");
    assert.equal(j.status, 400);
    assert.match(j.body.error, /only just joined/);
    await reset();
  });

  it("lets moderators time people out by hand, within their role", async () => {
    assert.equal((await call(bob, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 10 })).status, 403);
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 0 })).status, 400);
    const ownerId = s.ctx.users.byUsername("owner")!.id;
    await call(owner, "PATCH", `/api/servers/${serverId}/members/${bobId}`, { role: "admin" });
    assert.equal((await call(bob, "PUT", `/api/servers/${serverId}/timeouts/${ownerId}`, { minutes: 10 })).status, 403);
    const t = await call(bob, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 60, reason: "cool off" });
    assert.equal(t.status, 200);
    assert.equal((await post(cat, general, "hey")).status, 403);
    // A moderator can shorten it, unlike automod.
    await call(bob, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 1 });
    const list = (await call(owner, "GET", `/api/servers/${serverId}/timeouts`)).body;
    assert.ok(Date.parse(list[0].until) - Date.now() < 2 * 60_000);
    assert.equal(list[0].by.id, bobId);
    await call(owner, "DELETE", `/api/servers/${serverId}/timeouts/${catId}`);
    await call(owner, "PATCH", `/api/servers/${serverId}/members/${bobId}`, { role: "member" });
    assert.equal((await post(cat, general, "back")).status, 200);
  });

  it("never touches direct messages", async () => {
    await rules({ words: { enabled: true, actions: ["block"] } });
    await call(bob, "POST", "/api/friends", { username: "cat" });
    await call(cat, "POST", `/api/friends/${bobId}/accept`);
    const dm = (await call(bob, "POST", "/api/conversations", { userId: catId })).body;
    assert.equal((await post(bob, { conversationId: dm.id }, "darn it")).status, 200);
    await reset();
  });
});
