import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { LIMITS, type Conversation, type Message, type MessageEdit } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("friends and direct messages", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let dadId: number, momId: number, kitId: number;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    [dadId, momId, kitId] = ["dad", "mom", "kit"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
  });
  after(() => s.close());

  it("can't message someone who isn't a friend", async () => {
    const r = await call(dad, "POST", "/api/conversations", { userId: momId });
    assert.equal(r.status, 403);
  });

  it("sends and accepts a friend request, with live updates to both", async () => {
    const momLive = await listen(s, mom);
    const req = await call(dad, "POST", "/api/friends", { username: "MOM" });
    assert.equal(req.status, 200);
    assert.equal(req.body.state, "outgoing");
    assert.equal((await momLive.waitFor("friend.updated")).friend.state, "incoming");
    const acc = await call(mom, "POST", `/api/friends/${dadId}/accept`);
    assert.equal(acc.body.state, "friends");
    assert.equal((await call(dad, "GET", "/api/friends")).body[0].state, "friends");
    momLive.ws.close();
    assert.equal((await call(dad, "POST", "/api/friends", { username: "nobody_here" })).status, 404);
  });

  it("opens one DM per pair and delivers messages live", async () => {
    const momLive = await listen(s, mom);
    const first = await call(dad, "POST", "/api/conversations", { userId: momId });
    const again = await call(mom, "POST", "/api/conversations", { userId: dadId });
    assert.equal(first.body.id, again.body.id);
    const cid = (first.body as Conversation).id;
    await momLive.waitFor("conversation.created");

    const sent = await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: "  Dinner at 6?  " });
    assert.equal(sent.body.body, "Dinner at 6?");
    assert.equal((await momLive.waitFor("message.created")).message.body, "Dinner at 6?");

    // Typing reaches the other person but not the typer.
    const dadLive = await listen(s, dad);
    dadLive.ws.send(JSON.stringify({ type: "typing", conversationId: cid }));
    assert.equal((await momLive.waitFor("typing")).userId, dadId);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dadLive.events.filter((e) => e.type === "typing").length, 0);

    // Kit isn't in the conversation and can't read or post.
    assert.equal((await call(kit, "GET", `/api/conversations/${cid}/messages`)).status, 404);
    assert.equal((await call(kit, "POST", `/api/conversations/${cid}/messages`, { body: "hi" })).status, 404);
    // And a typing ping from outside the conversation goes nowhere.
    const kitLive = await listen(s, kit);
    kitLive.ws.send(JSON.stringify({ type: "typing", conversationId: cid }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(momLive.events.filter((e) => e.type === "typing").length, 0);
    for (const l of [momLive, dadLive, kitLive]) l.ws.close();
  });

  it("edits and deletes only your own messages, keeping the deleted one's place", async () => {
    const cid = (await call(dad, "POST", "/api/conversations", { userId: momId })).body.id as number;
    const m = (await call(mom, "POST", `/api/conversations/${cid}/messages`, { body: "Yes!" })).body as Message;
    assert.equal((await call(dad, "PATCH", `/api/messages/${m.id}`, { body: "No" })).status, 403);
    const edited = await call(mom, "PATCH", `/api/messages/${m.id}`, { body: "Yes, 6 works" });
    assert.ok(edited.body.editedAt);
    const del = await call(mom, "DELETE", `/api/messages/${m.id}`);
    assert.equal(del.body.deleted, true);
    assert.equal(del.body.body, "");
    const history = (await call(dad, "GET", `/api/conversations/${cid}/messages`)).body as Message[];
    assert.deepEqual(
      history.map((x) => [x.body, x.deleted]),
      [
        ["Dinner at 6?", false],
        ["", true],
      ],
    );
    assert.equal(s.ctx.db.prepare("SELECT body FROM messages WHERE id = ?").get(m.id)!.body, "", "the text is gone from the database too");
  });

  it("rejects empty and overlong messages, and pages back through history", async () => {
    const cid = (await call(dad, "POST", "/api/conversations", { userId: momId })).body.id as number;
    assert.equal((await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: "   " })).status, 400);
    assert.equal((await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: "x".repeat(4001) })).status, 400);
    for (let i = 0; i < 5; i++) await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: `n${i}` });
    const page = (await call(dad, "GET", `/api/conversations/${cid}/messages?limit=3`)).body as Message[];
    assert.deepEqual(page.map((x) => x.body), ["n2", "n3", "n4"]);
    const older = (await call(dad, "GET", `/api/conversations/${cid}/messages?limit=3&before=${page[0]!.id}`)).body as Message[];
    assert.deepEqual(older.map((x) => x.body), ["", "n0", "n1"]);
  });

  it("makes group DMs only with friends", async () => {
    assert.equal((await call(dad, "POST", "/api/conversations", { userIds: [momId, kitId] })).status, 403);
    await call(dad, "POST", "/api/friends", { username: "kit" });
    await call(kit, "POST", "/api/friends", { username: "dad" }); // asking back accepts
    const g = await call(dad, "POST", "/api/conversations", { userIds: [momId, kitId], name: "Family" });
    assert.equal(g.status, 200);
    assert.equal(g.body.isGroup, true);
    assert.equal(g.body.members.length, 3);
    const kitList = (await call(kit, "GET", "/api/conversations")).body as Conversation[];
    assert.ok(kitList.some((c) => c.name === "Family"));
  });

  it("shows friends when each other comes online", async () => {
    const momLive = await listen(s, mom);
    const dadLive = await listen(s, dad);
    const p = await momLive.waitFor("presence");
    assert.deepEqual([p.userId, p.online], [dadId, true]);
    const list = (await call(mom, "GET", "/api/friends")).body as { user: { id: number }; online: boolean }[];
    assert.equal(list.find((f) => f.user.id === dadId)!.online, true);
    dadLive.ws.close();
    const off = await momLive.waitFor("presence");
    assert.equal(off.online, false);
    momLive.ws.close();
  });

  it("keeps earlier versions of an edited message for the conversation, until it's deleted", async () => {
    const cid = (await call(dad, "POST", "/api/conversations", { userId: momId })).body.id as number;
    const m = (await call(mom, "POST", `/api/conversations/${cid}/messages`, { body: "Pizza tonight" })).body as Message;
    assert.deepEqual((await call(dad, "GET", `/api/messages/${m.id}/edits`)).body, [], "nothing until it's edited");
    await call(mom, "PATCH", `/api/messages/${m.id}`, { body: "Tacos tonight" });
    const last = (await call(mom, "PATCH", `/api/messages/${m.id}`, { body: "Tacos at 7" })).body as Message;
    const edits = (await call(dad, "GET", `/api/messages/${m.id}/edits`)).body as MessageEdit[];
    assert.deepEqual(
      edits.map((e) => [e.body, e.keyVersion]),
      [
        ["Pizza tonight", null],
        ["Tacos tonight", null],
      ],
    );
    assert.equal(edits[0]!.writtenAt, m.createdAt);
    assert.equal(edits[1]!.writtenAt, edits[0]!.replacedAt);
    assert.equal(edits[1]!.replacedAt, last.editedAt);
    // Only people in the conversation see them.
    assert.equal((await call(kit, "GET", `/api/messages/${m.id}/edits`)).status, 404);
    // Deleting takes the old versions too, from the database as well.
    await call(mom, "DELETE", `/api/messages/${m.id}`);
    assert.deepEqual((await call(dad, "GET", `/api/messages/${m.id}/edits`)).body, []);
    assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM message_edits WHERE message_id = ?").get(m.id)!.n, 0);
  });

  it("keeps at most LIMITS.editHistory earlier versions", async () => {
    const cid = (await call(dad, "POST", "/api/conversations", { userId: momId })).body.id as number;
    const m = (await call(mom, "POST", `/api/conversations/${cid}/messages`, { body: "v0" })).body as Message;
    for (let i = 1; i <= LIMITS.editHistory + 2; i++) await call(mom, "PATCH", `/api/messages/${m.id}`, { body: `v${i}` });
    const edits = (await call(mom, "GET", `/api/messages/${m.id}/edits`)).body as MessageEdit[];
    assert.equal(edits.length, LIMITS.editHistory);
    assert.equal(edits[0]!.body, "v2", "the oldest went first");
    assert.equal(edits.at(-1)!.body, `v${LIMITS.editHistory + 1}`);
  });
});

describe("presence on new friendships", () => {
  it("tells both people the other is online when they become friends while connected", async () => {
    const s = await startServer({ DENDROP_SIGNUP: "true" });
    try {
      const a = await account(s, "ann");
      const b = await account(s, "bob");
      const bobId = s.ctx.users.byUsername("bob")!.id;
      const annId = s.ctx.users.byUsername("ann")!.id;
      const annLive = await listen(s, a);
      const bobLive = await listen(s, b);
      await s.app.inject({ method: "POST", url: "/api/friends", headers: { cookie: a }, payload: { username: "bob" } });
      await s.app.inject({ method: "POST", url: `/api/friends/${annId}/accept`, headers: { cookie: b } });
      const seen = async (l: Awaited<ReturnType<typeof listen>>) => {
        for (;;) {
          const e = await l.waitFor("friend.updated");
          if (e.friend.state === "friends") return e.friend;
        }
      };
      const fa = await seen(annLive);
      assert.deepEqual([fa.user.id, fa.online], [bobId, true]);
      assert.equal((await seen(bobLive)).online, true);
      annLive.ws.close();
      bobLive.ws.close();
    } finally {
      await s.close();
    }
  });
});
