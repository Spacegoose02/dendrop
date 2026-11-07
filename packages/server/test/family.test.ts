import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  findBlockedWords,
  maskBlockedWords,
  type Conversation,
  type FamilyAlert,
  type FamilyChat,
  type FamilyInfo,
  type FamilyKid,
  type FamilyLinkCode,
  type Friend,
  type Me,
  type Message,
} from "@dendrop/shared";
import { localTime } from "../src/family.js";
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

describe("profanity filter", () => {
  it("catches swears and their disguises, and leaves innocent words alone", () => {
    for (const bad of ["shit", "Sh1t", "f*ck", "FUUUCK", "fucking", "a$$hole", "what the f.ck"]) {
      assert.ok(findBlockedWords(bad).length, bad);
    }
    for (const fine of ["class", "Scunthorpe", "as if", "pass the glass", "arsenal", "Fukushima", "assess", "u.s.a."]) {
      assert.deepEqual(findBlockedWords(fine), [], fine);
    }
  });

  it("takes extra words and masks what it finds", () => {
    assert.deepEqual(findBlockedWords("you are a doofus", ["doofus"]), ["doofus"]);
    assert.equal(maskBlockedWords("oh shit, a doofus!", ["doofus"]), "oh ••••, a ••••••!");
  });
});

describe("kid-safe chat", () => {
  let s: TestServer;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let admin: string, mom: string, dad: string, kit: string, sam: string, max: string;
  let momId: number, dadId: number, kitId: number, samId: number, maxId: number;
  const keys: Record<number, string> = {};

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const setUp = async (cookie: string, uid: number) => {
    keys[uid] = publicKey();
    const r = await req(cookie, "PUT", "/api/e2ee", { publicKey: keys[uid], backup: backup() });
    assert.equal(r.statusCode, 200, r.body);
  };
  const befriend = async (a: string, b: string, bId: number, aName: string) => {
    await req(a, "POST", "/api/friends", { username: s.ctx.users.byId(bId)!.username });
    const aId = s.ctx.users.byUsername(aName)!.id;
    return req(b, "POST", `/api/friends/${aId}/accept`);
  };
  const keysFor = (ids: number[]) => Object.fromEntries(ids.map((u) => [u, { publicKey: keys[u], wrapped: wrapped() }]));

  before(async () => {
    s = await startServer(
      { DENDROP_SIGNUP: "true" },
      {
        webhookPost: async (url, body) => {
          posts.push({ url, body: JSON.parse(body) as Record<string, unknown> });
          return 200;
        },
      },
    );
    admin = await account(s, "admin");
    mom = await account(s, "mom");
    dad = await account(s, "dad");
    kit = await account(s, "kit");
    sam = await account(s, "sam");
    max = await account(s, "max");
    [momId, dadId, kitId, samId, maxId] = ["mom", "dad", "kit", "sam", "max"].map((u) => s.ctx.users.byUsername(u)!.id) as [number, number, number, number, number];
  });
  after(() => s.close());

  let samDm: number;

  it("keeps kid and friend chats encrypted before any link", async () => {
    for (const [c, id] of [
      [kit, kitId],
      [sam, samId],
    ] as const)
      await setUp(c, id);
    const r = await befriend(sam, kit, kitId, "sam");
    assert.equal(r.json<Friend>().state, "friends");
    samDm = (await req(kit, "POST", "/api/conversations", { userId: samId })).json<Conversation>().id;
    assert.equal((await req(kit, "POST", `/api/conversations/${samDm}/keys`, { version: 1, keys: keysFor([kitId, samId]) })).statusCode, 200);
  });

  it("needs a parent with encryption to make a link code", async () => {
    const r = await req(mom, "POST", "/api/family/codes");
    assert.equal(r.statusCode, 409);
    await setUp(mom, momId);
    await setUp(dad, dadId);
  });

  it("links a kid with a code, and tells everyone in the kid's chats", async () => {
    const code = (await req(mom, "POST", "/api/family/codes")).json<FamilyLinkCode>();
    assert.match(code.code, /^[A-Z2-9]{8}$/);
    assert.equal((await req(kit, "POST", "/api/family/link", { code: "WRONGONE" })).statusCode, 404);

    const samWs = await listen(s, sam);
    const r = await req(kit, "POST", "/api/family/link", { code: code.code.toLowerCase(), timezone: "America/Chicago" });
    assert.equal(r.statusCode, 200, r.body);
    const info = r.json<FamilyInfo>();
    assert.deepEqual(info.parents.map((p) => p.username), ["mom"]);
    assert.equal(info.rules!.timezone, "America/Chicago");
    assert.equal(info.rules!.approveFriends, true);
    assert.equal((await req(kit, "GET", "/api/me")).json<Me>().isKid, true);

    // Sam is told that Kit's mom is now a guardian of their chat, and its key needs her copy.
    const update = await samWs.waitFor("conversation.updated");
    assert.deepEqual(update.conversation.guardians.map((g) => g.username), ["mom"]);
    assert.deepEqual(update.conversation.e2ee!.missing, [momId]);
    samWs.ws.close();

    // A code works once, and kids can't link others.
    assert.equal((await req(kit, "POST", "/api/family/link", { code: code.code })).statusCode, 404);
    assert.equal((await req(kit, "POST", "/api/family/codes")).statusCode, 403);
  });

  it("makes the next conversation key cover the kid's parents too", async () => {
    const without = await req(sam, "POST", `/api/conversations/${samDm}/keys`, { version: 2, keys: keysFor([kitId, samId]) });
    assert.equal(without.statusCode, 400);
    const r = await req(sam, "POST", `/api/conversations/${samDm}/keys`, { version: 2, keys: keysFor([kitId, samId, momId]) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json<Conversation>().e2ee!.missing, []);
  });

  it("lets a super admin link a second parent", async () => {
    assert.equal((await req(mom, "POST", "/api/admin/family", { parent: "dad", kid: "kit" })).statusCode, 403);
    const r = await req(admin, "POST", "/api/admin/family", { parent: "dad", kid: "kit" });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json<FamilyKid>().parents.map((p) => p.username).sort(), ["dad", "mom"]);
    // Kids can't be parents, and parents can't be kids.
    assert.equal((await req(admin, "POST", "/api/admin/family", { parent: "kit", kid: "max" })).statusCode, 409);
    assert.equal((await req(admin, "POST", "/api/admin/family", { parent: "sam", kid: "mom" })).statusCode, 409);
    const c = (await req(kit, "GET", `/api/conversations/${samDm}`)).json<Conversation>();
    assert.deepEqual(c.e2ee!.missing, [dadId]);
    await req(kit, "POST", `/api/conversations/${samDm}/keys`, { version: 3, keys: keysFor([kitId, samId, momId, dadId]) });
  });

  it("holds new friends until a parent approves", async () => {
    await setUp(max, maxId);
    const momWs = await listen(s, mom);
    const r = await befriend(max, kit, kitId, "max");
    assert.equal(r.json<Friend>().state, "held");
    assert.equal((await req(max, "POST", "/api/conversations", { userId: kitId })).statusCode, 403);

    const alert = (await momWs.waitFor("family.alert")).alert;
    assert.equal(alert.type, "contact");
    assert.equal(alert.other!.username, "max");
    momWs.ws.close();
    assert.equal((await req(mom, "POST", `/api/family/alerts/${alert.id}/resolve`)).statusCode, 409, "has to approve or decline");

    // Someone else's parent can't approve.
    assert.equal((await req(sam, "POST", `/api/family/kids/${kitId}/friends/${maxId}/approve`)).statusCode, 404);
    const ok = await req(mom, "POST", `/api/family/kids/${kitId}/friends/${maxId}/approve`);
    assert.equal(ok.json<Friend>().state, "friends");
    assert.equal((await req(max, "POST", "/api/conversations", { userId: kitId })).statusCode, 200);
    const kidFriends = (await req(dad, "GET", `/api/family/kids/${kitId}/friends`)).json<Friend[]>();
    assert.deepEqual(kidFriends.map((f) => f.user.username).sort(), ["max", "sam"]);
  });

  it("keeps a copy of what a kid deletes, and opens the chat to parents while the alert is open", async () => {
    const form = new FormData();
    const body = ciphertext();
    form.append("body", body);
    form.append("keyVersion", "3");
    form.append("file", new Blob([randomBytes(64)]), "photo.png");
    const sent = await fetch(`${s.url}/api/conversations/${samDm}/messages`, { method: "POST", headers: { cookie: kit }, body: form });
    const m = (await sent.json()) as Message;
    const fileId = m.attachments[0]!.id;

    // Parents can't read the chat before an alert.
    assert.equal((await req(mom, "GET", `/api/conversations/${samDm}/messages`)).statusCode, 404);

    const momWs = await listen(s, mom);
    assert.equal((await req(kit, "DELETE", `/api/messages/${m.id}`)).statusCode, 200);
    const alert = (await momWs.waitFor("family.alert")).alert;
    momWs.ws.close();
    assert.equal(alert.type, "deleted");
    assert.equal(alert.conversationId, samDm);
    assert.ok(existsSync(path.join(s.ctx.config.dataDir, "uploads", fileId)), "the file is kept");

    // Sam sees it deleted.
    const samView = (await req(sam, "GET", `/api/conversations/${samDm}/messages`)).json<Message[]>();
    assert.equal(samView.find((x) => x.id === m.id)!.deleted, true);
    assert.equal(samView.find((x) => x.id === m.id)!.body, "");

    // Mom sees the kept copy, still encrypted, with her own key copies to open it.
    const chat = (await req(mom, "GET", `/api/family/alerts/${alert.id}/chat`)).json<FamilyChat>();
    const copy = chat.messages.find((x) => x.id === m.id)!;
    assert.equal(copy.deletedByKid, true);
    assert.equal(copy.body, body);
    assert.equal(copy.keyVersion, 3);
    const momKeys = (await req(mom, "GET", `/api/family/alerts/${alert.id}/keys`)).json<{ version: number }[]>();
    assert.deepEqual(momKeys.map((k) => k.version), [2, 3]);
    const file = await req(mom, "GET", copy.attachments[0]!.url);
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.length, 64);

    // Others can't use the alert.
    assert.equal((await req(sam, "GET", `/api/family/alerts/${alert.id}/chat`)).statusCode, 404);
    assert.equal((await req(kit, "GET", `/api/family/alerts/${alert.id}/chat`)).statusCode, 404);

    // Kit sees that Mom looked.
    const kitInfo = (await req(kit, "GET", "/api/family")).json<FamilyInfo>();
    assert.equal(kitInfo.audit.length, 1);
    assert.equal(kitInfo.audit[0]!.parent.username, "mom");
    assert.equal(kitInfo.audit[0]!.conversationId, samDm);

    // Done closes the chat again and erases the copy.
    assert.equal((await req(dad, "POST", `/api/family/alerts/${alert.id}/resolve`)).statusCode, 200);
    assert.equal((await req(mom, "GET", `/api/family/alerts/${alert.id}/chat`)).statusCode, 410);
    assert.equal((await req(mom, "GET", `/api/family/alerts/${alert.id}/keys`)).statusCode, 410);
    assert.ok(!existsSync(path.join(s.ctx.config.dataDir, "uploads", fileId)));
  });

  it("takes profanity and help alerts from the kid's app, once while open", async () => {
    assert.equal((await req(sam, "POST", "/api/family/alerts", { type: "help", conversationId: samDm })).statusCode, 403);
    const a = (await req(kit, "POST", "/api/family/alerts", { type: "profanity", conversationId: samDm })).json<FamilyAlert>();
    const b = (await req(kit, "POST", "/api/family/alerts", { type: "profanity", conversationId: samDm })).json<FamilyAlert>();
    assert.equal(a.id, b.id);
    const help = (await req(kit, "POST", "/api/family/alerts", { type: "help", conversationId: samDm })).json<FamilyAlert>();
    assert.notEqual(help.id, a.id);
    const list = (await req(mom, "GET", "/api/family/alerts")).json<FamilyAlert[]>();
    assert.ok(list.some((x) => x.id === help.id && !x.resolvedAt));
  });

  it("sends alerts to a parent's webhook without any message content", async () => {
    assert.equal((await req(mom, "PUT", "/api/family/webhook", { url: "ftp://nope" })).statusCode, 400);
    assert.equal((await req(mom, "PUT", "/api/family/webhook", { url: "http://ntfy.lan/dendrop" })).statusCode, 200);
    posts.length = 0;
    await req(kit, "POST", "/api/family/alerts", { type: "help", conversationId: (await req(max, "POST", "/api/conversations", { userId: kitId })).json<Conversation>().id });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "http://ntfy.lan/dendrop");
    assert.equal(posts[0]!.body.type, "help");
    assert.equal(posts[0]!.body.message, "kit asked you to look at a chat.");
  });

  it("refuses filtered words in plain messages from a kid", async () => {
    // A group with Max has no key yet, so messages are plain and the server can check them.
    const g = (await req(kit, "POST", "/api/conversations", { userIds: [maxId], name: "plain" })).json<Conversation>();
    const bad = await req(kit, "POST", `/api/conversations/${g.id}/messages`, { body: "this is sh1t" });
    assert.equal(bad.statusCode, 400);
    assert.equal((await req(kit, "POST", `/api/conversations/${g.id}/messages`, { body: "this is fine" })).statusCode, 200);
    // Adults aren't filtered by the server.
    assert.equal((await req(max, "POST", `/api/conversations/${g.id}/messages`, { body: "this is sh1t" })).statusCode, 200);
    // A parent's extra words count too, and turning the filter off lets them through.
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { blockedWords: ["doofus"] });
    assert.equal((await req(kit, "POST", `/api/conversations/${g.id}/messages`, { body: "doofus" })).statusCode, 400);
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { profanityFilter: false });
    assert.equal((await req(kit, "POST", `/api/conversations/${g.id}/messages`, { body: "doofus" })).statusCode, 200);
  });

  it("checks rules", async () => {
    const bad = [{ allowedFrom: "7am", allowedUntil: "20:00" }, { allowedFrom: "07:00" , allowedUntil: "07:00" }, { dailyMinutes: 2 }, { timezone: "Mars/Base" }, { blockedWords: "x" }];
    for (const b of bad) assert.equal((await req(mom, "PATCH", `/api/family/kids/${kitId}`, b)).statusCode, 400, JSON.stringify(b));
    assert.equal((await req(sam, "PATCH", `/api/family/kids/${kitId}`, { dailyMinutes: 30 })).statusCode, 404);
    assert.equal((await req(kit, "PATCH", `/api/family/kids/${kitId}`, { dailyMinutes: null })).statusCode, 404, "kids can't change their own rules");
  });

  it("keeps kids out of chat servers unless a parent allows it", async () => {
    const blocked = await req(kit, "POST", "/api/servers", { name: "Kit's place" });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json<{ error: string }>().error, /Ask a parent/);
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { canJoinServers: true });
    // Now it's only the usual rule (a super admin approves server makers).
    assert.doesNotMatch((await req(kit, "POST", "/api/servers", { name: "Kit's place" })).json<{ error: string }>().error, /Ask a parent/);
  });

  it("stops sending outside chat hours, but reading still works", async () => {
    const { minute } = localTime("America/Chicago", new Date());
    const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    // A window that started two hours from now and ends three hours from now.
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { allowedFrom: hhmm(minute + 120), allowedUntil: hhmm(minute + 180) });
    const r = await req(kit, "POST", `/api/conversations/${samDm}/messages`, { body: ciphertext(), keyVersion: 3 });
    assert.equal(r.statusCode, 403);
    assert.match(r.json<{ error: string }>().error, /Chat time is/);
    assert.equal((await req(kit, "GET", `/api/conversations/${samDm}/messages`)).statusCode, 200);
    const info = (await req(kit, "GET", "/api/family")).json<FamilyInfo>();
    assert.equal(info.status!.allowedNow, false);

    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { allowedFrom: null, allowedUntil: null });
    assert.equal((await req(kit, "POST", `/api/conversations/${samDm}/messages`, { body: ciphertext(), keyVersion: 3 })).statusCode, 200);
  });

  it("counts minutes with the app open and stops at the daily limit", async () => {
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { dailyMinutes: 5 });
    const kitWs = await listen(s, kit);
    const momWs = await listen(s, mom);
    for (let i = 0; i < 5; i++) s.ctx.family.tick();
    const update = await kitWs.waitFor("family.updated");
    assert.equal(update.family.status!.allowedNow, false);
    assert.equal((await momWs.waitFor("family.alert")).alert.type, "time_limit");
    assert.equal((await req(kit, "POST", `/api/conversations/${samDm}/messages`, { body: ciphertext(), keyVersion: 3 })).statusCode, 403);
    kitWs.ws.close();
    momWs.ws.close();
    await req(mom, "PATCH", `/api/family/kids/${kitId}`, { dailyMinutes: null });
  });

  it("unlinks, and the last parent going makes it a normal account", async () => {
    assert.equal((await req(kit, "DELETE", `/api/family/kids/${kitId}`)).statusCode, 404, "kids can't unlink themselves");
    assert.equal((await req(dad, "DELETE", `/api/family/kids/${kitId}`)).statusCode, 200);
    assert.equal((await req(kit, "GET", "/api/me")).json<Me>().isKid, true);
    assert.equal((await req(mom, "DELETE", `/api/family/kids/${kitId}`)).statusCode, 200);
    assert.equal((await req(kit, "GET", "/api/me")).json<Me>().isKid, false);
    const c = (await req(sam, "GET", `/api/conversations/${samDm}`)).json<Conversation>();
    assert.deepEqual(c.guardians, []);
    assert.deepEqual((await req(mom, "GET", "/api/family/alerts")).json<FamilyAlert[]>(), []);
  });
});
