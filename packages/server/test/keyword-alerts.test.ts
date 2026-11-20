import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanKeywords, matchesKeyword, type ChatServer, type Message, type NotificationSettings, type ServerInvite } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("keyword matching", () => {
  it("matches whole words and phrases, ignoring case", () => {
    assert.equal(matchesKeyword("Is Sam coming?", ["sam"]), true);
    assert.equal(matchesKeyword("sam's here", ["Sam"]), true);
    assert.equal(matchesKeyword("Samuel and the same old", ["sam"]), false);
    assert.equal(matchesKeyword("who's up for GAME   night?", ["game night"]), true);
    assert.equal(matchesKeyword("game tonight", ["game night"]), false);
    assert.equal(matchesKeyword("Zoë is home", ["zoë"]), true);
    assert.equal(matchesKeyword("c++ rocks", ["c++"]), true);
    assert.equal(matchesKeyword("anything", []), false);
    assert.equal(matchesKeyword("anything", undefined), false);
  });

  it("skips message tokens like emoji and stickers", () => {
    assert.equal(matchesKeyword("<:pizza:12> <sticker:pizza:3>", ["pizza"]), false);
    assert.equal(matchesKeyword("<:pizza:12> pizza!", ["pizza"]), true);
  });

  it("cleans a list of keywords", () => {
    assert.deepEqual(cleanKeywords(["  Game   night ", "game night", "", "Sam"]), ["Game night", "Sam"]);
    assert.equal(typeof cleanKeywords("sam"), "string");
    assert.equal(typeof cleanKeywords([1]), "string");
    assert.equal(typeof cleanKeywords(["!!!"]), "string");
    assert.equal(typeof cleanKeywords(["x".repeat(41)]), "string");
    assert.equal(typeof cleanKeywords(Array.from({ length: 26 }, (_, i) => `word${i}`)), "string");
  });
});

describe("keyword alerts", () => {
  let s: TestServer;
  let ann: string, bob: string;
  let annId: number, bobId: number;
  let general: number;
  let serverId: number;

  const call = async (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const post = (cookie: string, cid: number, body: string) => call(cookie, "POST", `/api/conversations/${cid}/messages`, { body });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    [annId, bobId] = ["ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number];
    const sv = (await call(ann, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!.conversationId;
    const inv = (await call(ann, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(bob, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
  });
  after(() => s.close());

  it("saves keywords with your notification settings and tells your other devices", async () => {
    const live = await listen(s, bob);
    const r = await call(bob, "PUT", "/api/notification-settings", { keywords: ["Game night", " sam ", "game NIGHT"] });
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as NotificationSettings).keywords, ["Game night", "sam"]);
    const e = await live.waitFor("notifications.updated");
    assert.deepEqual(e.settings.keywords, ["Game night", "sam"]);
    assert.deepEqual(((await call(bob, "GET", "/api/notification-settings")).body as NotificationSettings).keywords, ["Game night", "sam"]);
    assert.equal((await call(bob, "PUT", "/api/notification-settings", { keywords: "sam" })).status, 400);
    live.ws.close();
  });

  it("pings like a mention when someone else writes a keyword", async () => {
    await call(bob, "PUT", "/api/notification-settings", { serverId, level: "mentions" });
    const live = await listen(s, bob);
    await post(ann, general, "nothing special");
    let e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.keyword], [false, false, undefined]);
    await post(ann, general, "Who's in for game night?");
    e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.keyword], [true, true, true]);
    // Not your own messages.
    await post(bob, general, "game night is on");
    e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.keyword], [false, false, undefined]);
    // Muted still means muted: an unread badge, but nothing pops up.
    await call(bob, "PUT", "/api/notification-settings", { conversationId: general, level: "nothing" });
    await post(ann, general, "sam?");
    e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.muted, e.keyword], [false, true, true, true]);
    await call(bob, "PUT", "/api/notification-settings", { conversationId: general, level: null });
    live.ws.close();
  });

  it("can't read encrypted messages, so leaves those to the app, and wakes phones like a mention", async () => {
    for (let i = 0; i < 100 && s.ctx.gateway.isOnline(bobId); i++) await new Promise((r) => setTimeout(r, 10));
    const sent: [number[], string][] = [];
    const orig = s.ctx.push.notify.bind(s.ctx.push);
    s.ctx.push.notify = async (ids, kind) => {
      sent.push([ids, kind as string]);
    };
    try {
      const base = { id: 1, conversationId: general, authorId: annId, mentions: [], mentionsEveryone: false, deleted: false };
      s.ctx.notifications.deliver({ ...base, body: "sam", keyVersion: 3 } as unknown as Message, [annId, bobId], annId);
      assert.deepEqual(sent, []);
      s.ctx.notifications.deliver({ ...base, body: "sam", keyVersion: null } as unknown as Message, [annId, bobId], annId);
      assert.deepEqual(sent, [[[bobId], "mention"]]);
    } finally {
      s.ctx.push.notify = orig;
    }
  });

  it("clears keywords with an empty list", async () => {
    const r = await call(bob, "PUT", "/api/notification-settings", { keywords: [] });
    assert.deepEqual((r.body as NotificationSettings).keywords, []);
    assert.equal((s.ctx.db.prepare("SELECT keyword_alerts FROM users WHERE id = ?").get(bobId) as { keyword_alerts: string | null }).keyword_alerts, null);
  });
});

