import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Channel, ChatServer, Conversation, Message, ScheduledMessage } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const publicKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
};
const backup = () => ({ salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) });
const wrapped = () => `${b64(65)}.${b64(12)}.${b64(48)}`;
const ciphertext = (n = 40) => `${b64(12)}.${b64(n)}`;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("send later", () => {
  let s: TestServer;
  let ana: string, ben: string, cat: string, kid: string;
  let anaId: number, benId: number, catId: number, kidId: number;
  let dm: number, catDm: number, kidDm: number;

  const call = async <T = ScheduledMessage>(cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json<T & { error?: string }>() };
  };
  const befriend = async (a: string, b: string, bId: number, aId: number) => {
    await call(a, "POST", "/api/friends", { username: s.ctx.users.byId(bId)!.username });
    await call(b, "POST", `/api/friends/${aId}/accept`);
  };
  const messages = async (cookie: string, cid: number) => (await call<Message[]>(cookie, "GET", `/api/conversations/${cid}/messages`)).body;

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ana = await account(s, "ana");
    ben = await account(s, "ben");
    cat = await account(s, "cat");
    kid = await account(s, "kid");
    [anaId, benId, catId, kidId] = ["ana", "ben", "cat", "kid"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
    await befriend(ana, ben, benId, anaId);
    await befriend(ana, cat, catId, anaId);
    await befriend(ana, kid, kidId, anaId);
    dm = (await call<Conversation>(ana, "POST", "/api/conversations", { userId: benId })).body.id;
    catDm = (await call<Conversation>(ana, "POST", "/api/conversations", { userId: catId })).body.id;
    kidDm = (await call<Conversation>(ana, "POST", "/api/conversations", { userId: kidId })).body.id;
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kidId, catId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, blocked_words) VALUES (?, ?)").run(kidId, JSON.stringify(["broccoli"]));
  });
  after(() => s.close());

  it("checks what's scheduled", async () => {
    for (const bad of [{ body: "hi" }, { body: "hi", sendAt: "soon" }, { body: "hi", sendAt: inMinutes(-1) }, { body: "hi", sendAt: inMinutes(60 * 24 * 400) }, { body: " ", sendAt: inMinutes(5) }]) {
      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/scheduled`, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(cat, "POST", `/api/conversations/${dm}/scheduled`, { body: "hi", sendAt: inMinutes(5) })).status, 404, "not in that chat");
  });

  it("schedules a message only its author sees, then sends it on time", async () => {
    const anaWs = await listen(s, ana);
    const benWs = await listen(s, ben);
    try {
      const r = await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: "  Happy birthday! 🎂 ", sendAt: inMinutes(10) });
      assert.equal(r.status, 200);
      assert.equal(r.body.body, "Happy birthday! 🎂");
      assert.equal(r.body.error, null);
      assert.equal((await anaWs.waitFor("scheduled.updated")).scheduled.id, r.body.id);
      assert.deepEqual(
        (await call<ScheduledMessage[]>(ana, "GET", "/api/scheduled")).body.map((x) => x.id),
        [r.body.id],
      );
      assert.deepEqual((await call<ScheduledMessage[]>(ana, "GET", `/api/scheduled?conversationId=${catDm}`)).body, []);
      assert.deepEqual((await call<ScheduledMessage[]>(ben, "GET", "/api/scheduled")).body, [], "only the author sees it");
      assert.equal((await call(ben, "PATCH", `/api/scheduled/${r.body.id}`, { body: "hacked" })).status, 404);
      assert.equal((await call(ben, "DELETE", `/api/scheduled/${r.body.id}`)).status, 404);

      // Not due yet: nothing happens.
      s.ctx.fireScheduled!(new Date(Date.now() + 5 * 60_000));
      assert.ok(!(await messages(ben, dm)).some((m) => m.body.startsWith("Happy")));

      // Edited, then due.
      const sendAt = inMinutes(20);
      const e = await call(ana, "PATCH", `/api/scheduled/${r.body.id}`, { body: "Happy birthday, Ben!", sendAt });
      assert.equal(e.body.body, "Happy birthday, Ben!");
      assert.equal(e.body.sendAt, sendAt);
      s.ctx.fireScheduled!(new Date(Date.now() + 21 * 60_000));
      const sent = (await messages(ben, dm)).at(-1)!;
      assert.equal(sent.body, "Happy birthday, Ben!");
      assert.equal(sent.authorId, anaId);
      assert.equal((await benWs.waitFor("message.created")).message.id, sent.id);
      const gone = await anaWs.waitFor("scheduled.removed");
      assert.equal(gone.id, r.body.id);
      assert.equal(gone.messageId, sent.id);
      assert.deepEqual((await call<ScheduledMessage[]>(ana, "GET", "/api/scheduled")).body, []);
    } finally {
      anaWs.ws.close();
      benWs.ws.close();
    }
  });

  it("can be sent right away, or cancelled", async () => {
    const a = (await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: "Now please", sendAt: inMinutes(60) })).body;
    const m = await call<Message>(ana, "POST", `/api/scheduled/${a.id}/send`);
    assert.equal(m.status, 200);
    assert.equal(m.body.body, "Now please");
    assert.equal((await call(ana, "POST", `/api/scheduled/${a.id}/send`)).status, 404, "it's gone once sent");

    const b = (await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: "Never mind", sendAt: inMinutes(5) })).body;
    assert.equal((await call(ana, "DELETE", `/api/scheduled/${b.id}`)).status, 200);
    s.ctx.fireScheduled!(new Date(Date.now() + 10 * 60_000));
    assert.ok(!(await messages(ben, dm)).some((x) => x.body === "Never mind"));
  });

  it("keeps a message that can't go out, with why, until it's fixed", async () => {
    const ws = await listen(s, ana);
    try {
      const r = (await call(ana, "POST", `/api/conversations/${catDm}/scheduled`, { body: "See you later", sendAt: inMinutes(5) })).body;
      await ws.waitFor("scheduled.updated");
      await call(cat, "POST", "/api/blocks", { userId: anaId });
      s.ctx.fireScheduled!(new Date(Date.now() + 6 * 60_000));
      const failed = (await ws.waitFor("scheduled.updated")).scheduled;
      assert.equal(failed.id, r.id);
      assert.match(failed.error!, /can't message/);
      // Not tried again by itself.
      s.ctx.fireScheduled!(new Date(Date.now() + 7 * 60_000));
      assert.equal((await call<ScheduledMessage[]>(ana, "GET", `/api/scheduled?conversationId=${catDm}`)).body[0]!.error, failed.error);
      assert.equal((await call(ana, "POST", `/api/conversations/${catDm}/scheduled`, { body: "x", sendAt: inMinutes(5) })).status, 403, "blocked when scheduling too");

      await call(cat, "DELETE", `/api/blocks/${anaId}`);
      const retry = await call(ana, "PATCH", `/api/scheduled/${r.id}`, { sendAt: inMinutes(8) });
      assert.equal(retry.body.error, null);
      s.ctx.fireScheduled!(new Date(Date.now() + 9 * 60_000));
      assert.equal((await messages(cat, catDm)).at(-1)!.body, "See you later");
    } finally {
      ws.ws.close();
    }
  });

  it("keeps encrypted chats encrypted", async () => {
    const keys: Record<number, string> = {};
    for (const [cookie, uid] of [
      [ana, anaId],
      [ben, benId],
    ] as const) {
      keys[uid] = publicKey();
      await call(cookie, "PUT", "/api/e2ee", { publicKey: keys[uid], backup: backup() });
    }
    const keysFor = Object.fromEntries([anaId, benId].map((u) => [u, { publicKey: keys[u], wrapped: wrapped() }]));
    assert.equal((await call(ana, "POST", `/api/conversations/${dm}/keys`, { version: 1, keys: keysFor })).status, 200);

    assert.equal((await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: "plain", sendAt: inMinutes(5) })).status, 409);
    assert.equal((await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: "plain", keyVersion: 1, sendAt: inMinutes(5) })).status, 400);
    assert.equal((await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body: ciphertext(), keyVersion: 2, sendAt: inMinutes(5) })).status, 409);
    const body = ciphertext();
    const r = await call(ana, "POST", `/api/conversations/${dm}/scheduled`, { body, keyVersion: 1, mentions: [benId], sendAt: inMinutes(5) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.mentions, [benId]);
    s.ctx.fireScheduled!(new Date(Date.now() + 6 * 60_000));
    const m = (await messages(ben, dm)).at(-1)!;
    assert.equal(m.body, body);
    assert.equal(m.keyVersion, 1);
    assert.deepEqual(m.mentions, [benId]);
  });

  it("follows kids' rules", async () => {
    assert.equal((await call(kid, "POST", `/api/conversations/${kidDm}/scheduled`, { body: "I hate broccoli", sendAt: inMinutes(5) })).status, 400);
    const ok = await call(kid, "POST", `/api/conversations/${kidDm}/scheduled`, { body: "Good night", sendAt: inMinutes(5) });
    assert.equal(ok.status, 200);
    assert.equal((await call(kid, "PATCH", `/api/scheduled/${ok.body.id}`, { body: "broccoli!" })).status, 400);
    // A word added to the filter later still stops it.
    s.ctx.db.prepare("UPDATE kid_rules SET blocked_words = ? WHERE kid_id = ?").run(JSON.stringify(["broccoli", "night"]), kidId);
    s.ctx.fireScheduled!(new Date(Date.now() + 6 * 60_000));
    assert.match((await call<ScheduledMessage[]>(kid, "GET", "/api/scheduled")).body[0]!.error!, /family filter/);
  });

  it("waits out slowmode, and doesn't go into read-only channels", async () => {
    const sv = (await call<ChatServer>(ana, "POST", "/api/servers", { name: "Den", isPublic: true })).body;
    const general: Channel = sv.channels[0]!;
    await call(ben, "POST", `/api/servers/${sv.id}/join`);
    const cid = general.conversationId;
    await call(ana, "PATCH", `/api/servers/${sv.id}/channels/${general.id}`, { slowmode: 600 });
    assert.equal((await call<Message>(ben, "POST", `/api/conversations/${cid}/messages`, { body: "first" })).status, 200);
    const r = (await call(ben, "POST", `/api/conversations/${cid}/scheduled`, { body: "second", sendAt: inMinutes(1) })).body;
    s.ctx.fireScheduled!(new Date(Date.now() + 2 * 60_000));
    const waiting = (await call<ScheduledMessage[]>(ben, "GET", `/api/scheduled?conversationId=${cid}`)).body;
    assert.equal(waiting[0]!.id, r.id);
    assert.equal(waiting[0]!.error, null, "slowmode just makes it wait");
    assert.equal((await call(ben, "POST", `/api/scheduled/${r.id}/send`)).status, 429);

    await call(ana, "PATCH", `/api/servers/${sv.id}/channels/${general.id}`, { slowmode: 0, readOnly: true });
    assert.equal((await call(ben, "POST", `/api/conversations/${cid}/scheduled`, { body: "x", sendAt: inMinutes(5) })).status, 403);
    s.ctx.fireScheduled!(new Date(Date.now() + 2 * 60_000));
    assert.match((await call<ScheduledMessage[]>(ben, "GET", `/api/scheduled?conversationId=${cid}`)).body[0]!.error!, /Only some people/);
  });
});
