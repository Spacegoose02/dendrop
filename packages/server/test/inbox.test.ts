import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { MessageInPlace, RailItem } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("forwarding, saved messages, the mentions inbox and server folders", () => {
  let s: TestServer;
  let ann: string, bob: string, cat: string;
  let annId: number, bobId: number;
  let dm: number;
  let den: { id: number; channels: { conversationId: number; id: number }[] };

  const call = async (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const say = async (cookie: string, cid: number, body: string, extra: object = {}) => (await call(cookie, "POST", `/api/conversations/${cid}/messages`, { body, ...extra })).body;

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    [annId, bobId] = ["ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
    await call(ann, "POST", "/api/friends", { username: "bob" });
    await call(bob, "POST", `/api/friends/${annId}/accept`);
    dm = (await call(ann, "POST", "/api/conversations", { userId: bobId })).body.id;
    den = (await call(ann, "POST", "/api/servers", { name: "Den", isPublic: true })).body;
    await call(bob, "POST", `/api/servers/${den.id}/join`);
  });
  after(() => s.close());

  it("forwards a message with its original author and time, pinging nobody", async () => {
    const orig = await say(bob, dm, `dinner at 6, <@${annId}>`);
    const fwd = await say(ann, den.channels[0]!.conversationId, `dinner at 6, <@${annId}>`, { forwardOf: orig.id });
    assert.deepEqual(fwd.forwarded, { authorId: bobId, authorName: "bob", createdAt: orig.createdAt });
    assert.deepEqual(fwd.mentions, []);
    // Forwarding the forward keeps the first author.
    const again = await say(bob, dm, "x", { forwardOf: fwd.id });
    assert.equal(again.forwarded.authorId, bobId);
    // You can't forward what you can't see.
    const secret = await say(ann, dm, "just us");
    await call(cat, "POST", `/api/servers/${den.id}/join`);
    assert.equal((await call(cat, "POST", `/api/conversations/${den.channels[0]!.conversationId}/messages`, { body: "leak", forwardOf: secret.id })).status, 404);
  });

  it("keeps saved messages per person, with where they are", async () => {
    const m = await say(bob, den.channels[0]!.conversationId, "remember the milk");
    const live = await listen(s, ann);
    assert.equal((await call(ann, "PUT", `/api/saved/${m.id}`)).status, 200);
    assert.deepEqual(await live.waitFor("saved.updated"), { type: "saved.updated", messageId: m.id, saved: true });
    live.ws.close();
    const list = (await call(ann, "GET", "/api/saved")).body as MessageInPlace[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.message.id, m.id);
    assert.equal(list[0]!.place.kind, "channel");
    assert.equal(list[0]!.place.serverName, "Den");
    assert.ok(list[0]!.savedAt);
    assert.deepEqual((await call(bob, "GET", "/api/saved")).body, []);
    // Deleted messages drop out.
    await call(bob, "DELETE", `/api/messages/${m.id}`);
    assert.deepEqual((await call(ann, "GET", "/api/saved")).body, []);
    const n = await say(bob, dm, "keep");
    await call(ann, "PUT", `/api/saved/${n.id}`);
    assert.equal(((await call(ann, "GET", "/api/saved")).body as MessageInPlace[])[0]!.place.name, "bob");
    // Not in that chat: can't save from it.
    assert.equal((await call(cat, "PUT", `/api/saved/${n.id}`)).status, 404);
    await call(ann, "DELETE", `/api/saved/${n.id}`);
    assert.deepEqual((await call(ann, "GET", "/api/saved")).body, []);
  });

  it("lists the messages that pinged you, newest first", async () => {
    const ch = den.channels[0]!.conversationId;
    const a = await say(ann, ch, `hey <@${bobId}>`);
    const b = await say(ann, ch, "@everyone game night");
    await say(ann, ch, "nobody pinged");
    const c = await say(ann, dm, "yo");
    const r = await say(ann, dm, "answering", { replyToId: (await say(bob, dm, "question?")).id });
    const list = (await call(bob, "GET", "/api/mentions")).body as MessageInPlace[];
    const ids = list.map((x) => x.message.id);
    assert.deepEqual(ids.slice(0, 3), [r.id, b.id, a.id]);
    assert.ok(!ids.includes(c.id));
    assert.equal(list[1]!.place.kind, "channel");
    assert.equal(list[0]!.place.kind, "dm");
    const older = (await call(bob, "GET", `/api/mentions?before=${b.id}`)).body as MessageInPlace[];
    assert.equal(older[0]!.message.id, a.id);
    // Ann pinged @everyone herself: not in her own inbox.
    assert.ok(!((await call(ann, "GET", "/api/mentions")).body as MessageInPlace[]).some((x) => x.message.id === b.id));
  });

  it("stores server folders, keeping only servers you're in", async () => {
    const two = (await call(ann, "POST", "/api/servers", { name: "Two" })).body;
    const three = (await call(ann, "POST", "/api/servers", { name: "Three" })).body;
    assert.deepEqual((await call(ann, "GET", "/api/me/rail")).body, []);
    const live = await listen(s, ann);
    const rail: RailItem[] = [
      { type: "server", id: three.id },
      { type: "folder", id: "f1", name: "  Family  ", color: "#FF8800", serverIds: [den.id, two.id, 999999, den.id] },
      { type: "folder", id: "f2", name: "Empty", color: null, serverIds: [] },
    ];
    const saved = (await call(ann, "PUT", "/api/me/rail", { rail })).body;
    assert.deepEqual(saved, [
      { type: "server", id: three.id },
      { type: "folder", id: "f1", name: "Family", color: "#ff8800", serverIds: [den.id, two.id] },
    ]);
    assert.deepEqual((await live.waitFor("rail.updated")).rail, saved);
    live.ws.close();
    // Leaving a server takes it out.
    await call(ann, "DELETE", `/api/servers/${two.id}`);
    assert.deepEqual(((await call(ann, "GET", "/api/me/rail")).body as RailItem[])[1], { type: "folder", id: "f1", name: "Family", color: "#ff8800", serverIds: [den.id] });
    assert.equal((await call(ann, "PUT", "/api/me/rail", { rail: [{ type: "nope" }] })).status, 400);
    assert.equal((await call(ann, "PUT", "/api/me/rail", { rail: [{ type: "folder", id: "a b!", name: "x", serverIds: [] }] })).status, 400);
  });
});
