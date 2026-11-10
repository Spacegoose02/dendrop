import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ChatServer, Friend, Me, UnreadCount } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("unread counts, mark as unread, Do Not Disturb and appearing offline", () => {
  let s: TestServer;
  let ann: string, bob: string;
  let annId: number, bobId: number;
  let dm: number;
  const call = async (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const say = async (cookie: string, cid: number, body: string) => (await call(cookie, "POST", `/api/conversations/${cid}/messages`, { body })).body.id as number;
  const unread = async (cookie: string) => (await call(cookie, "GET", "/api/unread")).body as UnreadCount[];

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    [annId, bobId] = ["ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
    await call(ann, "POST", "/api/friends", { username: "bob" });
    await call(bob, "POST", `/api/friends/${annId}/accept`);
    dm = (await call(ann, "POST", "/api/conversations", { userId: bobId })).body.id;
  });
  after(() => s.close());

  it("counts unread messages and pings per conversation, and reading clears them", async () => {
    assert.deepEqual(await unread(bob), []);
    await say(ann, dm, "one");
    await say(ann, dm, "two");
    const last = await say(ann, dm, `hey <@${bobId}>`);
    assert.deepEqual(await unread(bob), [{ conversationId: dm, count: 3, mentions: 1 }]);
    // Your own messages never count.
    assert.deepEqual(await unread(ann), []);
    await call(bob, "POST", `/api/conversations/${dm}/read`, { messageId: last });
    assert.deepEqual(await unread(bob), []);

    // Channels count too, @everyone included.
    const sv = (await call(ann, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    await call(bob, "POST", `/api/servers/${sv.id}/join`);
    await say(ann, sv.channels[0]!.conversationId, "@everyone dinner");
    assert.deepEqual(await unread(bob), [{ conversationId: sv.channels[0]!.conversationId, count: 1, mentions: 1 }]);
  });

  it("marks a conversation unread from a message on, without moving read receipts", async () => {
    const first = await say(ann, dm, "remember this");
    const second = await say(ann, dm, "and this");
    await call(bob, "POST", `/api/conversations/${dm}/read`, { messageId: second });
    const bobLive = await listen(s, bob);
    const r = (await call(bob, "POST", `/api/conversations/${dm}/unread`, { messageId: first })).body as UnreadCount;
    assert.deepEqual(r, { conversationId: dm, count: 2, mentions: 0 });
    assert.deepEqual((await bobLive.waitFor("unread")).unread, r);
    bobLive.ws.close();
    // Ann still sees that Bob read it.
    const reads = (await call(ann, "GET", `/api/conversations/${dm}`)).body.reads as { userId: number; messageId: number }[];
    assert.equal(reads.find((x) => x.userId === bobId)!.messageId, second);
    // Reading again clears the mark.
    await call(bob, "POST", `/api/conversations/${dm}/read`, { messageId: second });
    assert.equal((await unread(bob)).find((u) => u.conversationId === dm), undefined);
    assert.equal((await call(bob, "POST", `/api/conversations/${dm}/unread`, { messageId: 999999 })).status, 404);
  });

  it("Do Not Disturb keeps messages coming but without notifications, and can end by itself", async () => {
    const bobLive = await listen(s, bob);
    const me = (await call(bob, "PUT", "/api/me/presence", { presence: "dnd", minutes: 60 })).body as Me;
    assert.equal(me.presence, "dnd");
    assert.ok(Date.parse(me.dndUntil!) > Date.now() + 59 * 60_000);
    assert.equal((await bobLive.waitFor("me.updated")).user.presence, "dnd");
    const annFriends = (await call(ann, "GET", "/api/friends")).body as Friend[];
    assert.equal(annFriends[0]!.dnd, true);
    await say(ann, dm, "quiet please");
    const got = await bobLive.waitFor("message.created");
    assert.equal(got.notify, false);
    // Once it runs out it's as if it was off.
    s.ctx.db.prepare("UPDATE users SET dnd_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), bobId);
    assert.equal(((await call(bob, "GET", "/api/me")).body as Me).presence, "online");
    await say(ann, dm, "loud again");
    assert.equal((await bobLive.waitFor("message.created")).notify, true);
    bobLive.ws.close();
    assert.equal((await call(bob, "PUT", "/api/me/presence", { presence: "away" })).status, 400);
  });

  it("appearing offline hides you from friends while you're connected", async () => {
    const annLive = await listen(s, ann);
    const bobLive = await listen(s, bob);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(((await call(ann, "GET", "/api/friends")).body as Friend[])[0]!.online, true);
    annLive.events.length = 0;
    await call(bob, "PUT", "/api/me/presence", { presence: "invisible" });
    const p = await annLive.waitFor("presence");
    assert.equal(p.userId, bobId);
    assert.equal(p.online, false);
    assert.equal(((await call(ann, "GET", "/api/friends")).body as Friend[])[0]!.online, false);
    // Reconnecting doesn't give it away either.
    bobLive.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    annLive.events.length = 0;
    const again = await listen(s, bob);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(annLive.events.filter((e) => e.type === "presence" && e.online).length, 0);
    annLive.events.length = 0;
    await call(bob, "PUT", "/api/me/presence", { presence: "online" });
    assert.equal((await annLive.waitFor("presence")).online, true);
    again.ws.close();
    annLive.ws.close();
  });
});
