import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Channel, ChatServer, Message, PinnedMessage, ServerInvite, Thread } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("threads, forum channels and the pinned board", () => {
  let s: TestServer;
  let owner: string, bob: string, cat: string, out: string;
  let bobId: number, catId: number;
  let serverId: number;
  let general: Channel;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const post = async (cookie: string, conversationId: number, body: string) => call(cookie, "POST", `/api/conversations/${conversationId}/messages`, { body });
  const history = async (cookie: string, conversationId: number) => (await call(cookie, "GET", `/api/conversations/${conversationId}/messages`)).body as Message[];

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    owner = await account(s, "owner");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    out = await account(s, "out");
    [bobId, catId] = ["bob", "cat"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    for (const who of [bob, cat]) {
      const inv = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
      assert.equal((await call(who, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    }
  });
  after(() => s.close());

  let thread: Thread;
  let parent: Message;

  it("starts a thread off a channel message, titled from the message, and opens the same one again", async () => {
    parent = (await post(bob, general.conversationId, "Who's up for game night Friday?\nBring snacks")).body as Message;
    const live = await listen(s, cat);
    const r = await call(cat, "POST", `/api/messages/${parent.id}/thread`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    thread = r.body as Thread;
    assert.equal(thread.title, "Who's up for game night Friday?");
    assert.equal(thread.parentMessageId, parent.id);
    assert.equal(thread.channelId, general.id);
    assert.equal(thread.messageCount, 0);
    assert.equal((await live.waitFor("thread.updated")).thread.id, thread.id);
    // The message now shows its thread, live and in the history.
    assert.equal((await live.waitFor("message.updated")).message.thread?.id, thread.id);
    live.ws.close();
    assert.equal((await history(owner, general.conversationId)).find((m) => m.id === parent.id)!.thread!.conversationId, thread.conversationId);

    const again = await call(owner, "POST", `/api/messages/${parent.id}/thread`, { title: "Something else" });
    assert.equal((again.body as Thread).id, thread.id);
  });

  it("lets everyone in the channel post in the thread, and keeps its count up to date", async () => {
    const live = await listen(s, owner);
    assert.equal((await post(owner, thread.conversationId, "I'm in!")).status, 200);
    assert.equal((await post(bob, thread.conversationId, "Me too")).status, 200);
    const ev = await live.waitFor("thread.updated");
    assert.equal(ev.thread.id, thread.id);
    live.ws.close();
    const t = (await call(cat, "GET", `/api/threads/${thread.id}`)).body as Thread;
    assert.equal(t.messageCount, 2);
    assert.equal(t.preview, "I'm in!");
    assert.equal((await history(owner, general.conversationId)).find((m) => m.id === parent.id)!.thread!.messageCount, 2);
    // Thread conversations aren't DMs.
    assert.equal((await call(owner, "GET", "/api/conversations")).body.length, 0);
    // People outside the server can't see it.
    assert.equal((await call(out, "GET", `/api/threads/${thread.id}`)).status, 404);
    assert.equal((await call(out, "GET", `/api/conversations/${thread.conversationId}/messages`)).status, 404);
    // Threads can't have threads, and DMs and channels' encryption and calls stay off.
    const inThread = (await history(owner, thread.conversationId))[0]!;
    assert.equal((await call(owner, "POST", `/api/messages/${inThread.id}/thread`, {})).status, 400);
    assert.equal((await call(owner, "POST", `/api/conversations/${thread.conversationId}/call`, {})).status, 400);
    assert.equal((await call(owner, "POST", `/api/conversations/${thread.conversationId}/keys`, {})).status, 400);
  });

  it("lists a channel's threads", async () => {
    const list = (await call(bob, "GET", `/api/servers/${serverId}/channels/${general.id}/threads`)).body as Thread[];
    assert.deepEqual(
      list.map((t) => t.id),
      [thread.id],
    );
    assert.equal((await call(out, "GET", `/api/servers/${serverId}/channels/${general.id}/threads`)).status, 404);
  });

  it("lets the starter rename and close a thread, and only moderators post in or reopen a closed one", async () => {
    assert.equal((await call(bob, "PATCH", `/api/threads/${thread.id}`, { title: "Nope" })).status, 403);
    const r = await call(cat, "PATCH", `/api/threads/${thread.id}`, { title: "Game night", closed: true });
    assert.equal(r.status, 200);
    assert.equal((r.body as Thread).closed, true);
    assert.equal((r.body as Thread).title, "Game night");
    const blocked = await post(bob, thread.conversationId, "wait");
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /closed/);
    assert.equal((await post(owner, thread.conversationId, "Closing this, see you Friday")).status, 200);
    // Closed threads drop off the list unless asked for.
    assert.equal(((await call(bob, "GET", `/api/servers/${serverId}/channels/${general.id}/threads`)).body as Thread[]).length, 0);
    assert.equal(((await call(bob, "GET", `/api/servers/${serverId}/channels/${general.id}/threads?closed=true`)).body as Thread[]).length, 1);
    assert.equal((await call(cat, "PATCH", `/api/threads/${thread.id}`, { closed: false })).status, 403);
    assert.equal((await call(owner, "PATCH", `/api/threads/${thread.id}`, { closed: false })).status, 200);
    assert.equal((await post(bob, thread.conversationId, "wait")).status, 200);
  });

  it("follows the channel's lock: people who lose access to the channel lose its threads", async () => {
    await call(owner, "PATCH", `/api/servers/${serverId}/channels/${general.id}`, { locked: true, memberIds: [bobId] });
    assert.equal((await call(cat, "GET", `/api/threads/${thread.id}`)).status, 404);
    assert.equal((await post(cat, thread.conversationId, "hello?")).status, 404);
    assert.equal((await call(bob, "GET", `/api/threads/${thread.id}`)).status, 200);
    await call(owner, "PATCH", `/api/servers/${serverId}/channels/${general.id}`, { locked: false });
    assert.equal((await call(cat, "GET", `/api/threads/${thread.id}`)).status, 200);
  });

  it("applies automod and timeouts in threads like in their channel", async () => {
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { words: { enabled: true, actions: ["block"], words: ["darn"] } });
    const r = await post(bob, thread.conversationId, "well darn");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /word this server blocks/);
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { words: { enabled: false } });

    await call(owner, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 5 });
    assert.equal((await post(cat, thread.conversationId, "hi")).status, 403);
    const fresh = (await post(bob, general.conversationId, "new topic")).body as Message;
    assert.equal((await call(cat, "POST", `/api/messages/${fresh.id}/thread`, {})).status, 403);
    await call(owner, "DELETE", `/api/servers/${serverId}/timeouts/${catId}`);
  });

  let forum: Channel;
  let postThread: Thread;

  it("makes forum channels with tags, which take posts instead of messages", async () => {
    assert.equal((await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "help", kind: "forum", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status, 400);
    const r = await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "help", kind: "forum", topic: "Ask anything", tags: ["Question", "Bug", "question"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    forum = r.body as Channel;
    assert.equal(forum.kind, "forum");
    assert.deepEqual(forum.tags, ["Question", "Bug"]);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}`)).body.channels.find((c: Channel) => c.id === forum.id).kind, "forum");

    // Plain messages don't go in a forum.
    assert.equal((await post(bob, forum.conversationId, "hello")).status, 400);
    // A post needs a title and a first message, and only the forum's tags.
    const make = (body: object) => call(bob, "POST", `/api/servers/${serverId}/channels/${forum.id}/threads`, body);
    assert.equal((await make({ body: "hi" })).status, 400);
    assert.equal((await make({ title: "Hi", body: "hi", tags: ["Nope"] })).status, 400);
    assert.equal((await make({ title: "Empty", body: "" })).status, 400);
    assert.equal(((await call(bob, "GET", `/api/servers/${serverId}/channels/${forum.id}/threads`)).body as Thread[]).length, 0, "a failed post leaves nothing behind");
    // Posts can't be made in text channels.
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/channels/${general.id}/threads`, { title: "Hi", body: "hi" })).status, 400);

    const live = await listen(s, cat);
    const p = await make({ title: "Voice keeps cutting out", body: "Since yesterday my mic drops every few minutes.", tags: ["Bug"] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    postThread = p.body as Thread;
    assert.equal(postThread.parentMessageId, null);
    assert.deepEqual(postThread.tags, ["Bug"]);
    assert.equal(postThread.messageCount, 1);
    assert.match(postThread.preview, /mic drops/);
    assert.equal((await live.waitFor("thread.updated")).thread.id, postThread.id);
    live.ws.close();
    assert.equal((await post(cat, postThread.conversationId, "Try another USB port")).status, 200);
    // Polls go in posts (and count as replies), not in the forum itself; nudges stay out of threads.
    assert.equal((await call(cat, "POST", `/api/conversations/${forum.conversationId}/polls`, { question: "Q", options: ["A", "B"] })).status, 400);
    assert.equal((await call(cat, "POST", `/api/conversations/${postThread.conversationId}/polls`, { question: "Which USB port?", options: ["Front", "Back"] })).status, 200);
    assert.equal((await call(cat, "POST", `/api/conversations/${postThread.conversationId}/nudges`, { kind: "poke" })).status, 400);
    // Replies in threads and forum posts earn server XP like channel messages (cat hasn't posted anywhere else).
    assert.ok(s.ctx.db.prepare("SELECT xp FROM server_xp WHERE server_id = ? AND user_id = ? AND xp > 0").get(serverId, catId));
    const list = (await call(cat, "GET", `/api/servers/${serverId}/channels/${forum.id}/threads`)).body as Thread[];
    assert.equal(list[0]!.messageCount, 3);
  });

  it("retags posts, and drops tags the forum no longer has", async () => {
    assert.equal((await call(bob, "PATCH", `/api/threads/${postThread.id}`, { tags: ["Question", "Bug"] })).status, 200);
    assert.equal((await call(bob, "PATCH", `/api/threads/${thread.id}`, { tags: ["Bug"] })).status, 403, "bob didn't start that thread");
    assert.equal((await call(owner, "PATCH", `/api/threads/${thread.id}`, { tags: ["Bug"] })).status, 400, "only forum posts have tags");
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/channels/${forum.id}`, { tags: ["Question"] })).status, 200);
    assert.deepEqual(((await call(bob, "GET", `/api/threads/${postThread.id}`)).body as Thread).tags, ["Question"]);
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/channels/${general.id}`, { tags: ["x"] })).status, 400);
  });

  it("pins messages to the board: only with Pin messages, and only people who can see them see them", async () => {
    const m1 = (await post(bob, general.conversationId, "House rules: be kind")).body as Message;
    const inThread = (await history(bob, postThread.conversationId))[0]!;
    assert.equal((await call(bob, "PUT", `/api/messages/${m1.id}/pin`)).status, 403);

    const live = await listen(s, bob);
    const r = await call(owner, "PUT", `/api/messages/${m1.id}/pin`);
    assert.equal(r.status, 200);
    assert.equal((r.body as Message).pinned, true);
    assert.equal((await live.waitFor("pins.updated")).messageId, m1.id);
    live.ws.close();

    // A role with Pin messages can pin too, in threads as well.
    const role = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Pinners", permissions: ["pinMessages"] })).body as { id: number };
    await call(owner, "PUT", `/api/servers/${serverId}/members/${bobId}/roles`, { roleIds: [role.id] });
    assert.equal((await call(bob, "PUT", `/api/messages/${inThread.id}/pin`)).status, 200);

    let board = (await call(cat, "GET", `/api/servers/${serverId}/pins`)).body as PinnedMessage[];
    assert.deepEqual(
      board.map((p) => p.message.id),
      [inThread.id, m1.id],
    );
    assert.equal(board[0]!.threadId, postThread.id);
    assert.equal(board[0]!.threadTitle, "Voice keeps cutting out");
    assert.equal(board[0]!.channelId, forum.id);
    board = (await call(cat, "GET", `/api/servers/${serverId}/pins?channelId=${general.id}`)).body as PinnedMessage[];
    assert.deepEqual(
      board.map((p) => p.message.id),
      [m1.id],
    );
    assert.equal((await call(out, "GET", `/api/servers/${serverId}/pins`)).status, 404);

    // Locked away from cat: the pin goes from cat's board.
    await call(owner, "PATCH", `/api/servers/${serverId}/channels/${general.id}`, { locked: true, memberIds: [bobId] });
    board = (await call(cat, "GET", `/api/servers/${serverId}/pins`)).body as PinnedMessage[];
    assert.deepEqual(
      board.map((p) => p.message.id),
      [inThread.id],
    );
    await call(owner, "PATCH", `/api/servers/${serverId}/channels/${general.id}`, { locked: false });

    // Unpinning, and deleting a pinned message, take it off the board.
    assert.equal((await call(bob, "DELETE", `/api/messages/${m1.id}/pin`)).status, 200);
    assert.equal((await call(bob, "DELETE", `/api/messages/${m1.id}/pin`)).status, 404);
    await call(bob, "DELETE", `/api/messages/${inThread.id}`);
    assert.equal(((await call(cat, "GET", `/api/servers/${serverId}/pins`)).body as PinnedMessage[]).length, 0);
  });

  it("deletes threads (moderators), and a channel's threads go with it", async () => {
    assert.equal((await call(cat, "DELETE", `/api/threads/${thread.id}`)).status, 403);
    const live = await listen(s, cat);
    assert.equal((await call(owner, "DELETE", `/api/threads/${thread.id}`)).status, 200);
    assert.equal((await live.waitFor("thread.removed")).threadId, thread.id);
    live.ws.close();
    assert.equal((await call(cat, "GET", `/api/threads/${thread.id}`)).status, 404);
    assert.equal((await history(owner, general.conversationId)).find((m) => m.id === parent.id)!.thread, null);

    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/channels/${forum.id}`)).status, 200);
    assert.equal(s.ctx.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(postThread.conversationId), undefined);
  });
});
