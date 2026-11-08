import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Conversation, CouplesItem, CouplesKit, FamilyLinkCode } from "@dendrop/shared";
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

describe("couples kit", () => {
  let s: TestServer;
  let ann: string, bea: string, kit: string, cal: string;
  let annId: number, beaId: number, kitId: number, calId: number;
  let dm: number, kidDm: number, group: number;
  const keys: Record<number, string> = {};

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const kitOf = async (cookie: string, cid = dm) => (await req(cookie, "GET", `/api/couples/${cid}`)).json<CouplesKit>();
  const item = async (cookie: string, itemId: number) => (await kitOf(cookie)).items.find((i) => i.id === itemId);
  const add = (cookie: string, payload: object) => req(cookie, "POST", `/api/couples/${dm}/items`, { keyVersion: 1, body: ciphertext(), ...payload });

  const setUp = async (cookie: string, uid: number) => {
    keys[uid] = publicKey();
    await req(cookie, "PUT", "/api/e2ee", { publicKey: keys[uid], backup: backup() });
  };
  /** Ann asks, the other person accepts. */
  const befriend = async (b: string, bName: string) => {
    await req(ann, "POST", "/api/friends", { username: bName });
    await req(b, "POST", `/api/friends/${annId}/accept`);
  };
  const keyFor = (cid: number, ids: number[]) =>
    req(ann, "POST", `/api/conversations/${cid}/keys`, {
      version: 1,
      keys: Object.fromEntries(ids.map((u) => [u, { publicKey: keys[u], wrapped: wrapped() }])),
    });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ann = await account(s, "ann");
    bea = await account(s, "bea");
    kit = await account(s, "kit");
    cal = await account(s, "cal");
    [annId, beaId, kitId, calId] = ["ann", "bea", "kit", "cal"].map((u) => s.ctx.users.byUsername(u)!.id) as [number, number, number, number];
    await befriend(bea, "bea");
    await befriend(kit, "kit");
    await befriend(cal, "cal");
    dm = (await req(ann, "POST", "/api/conversations", { userId: beaId })).json<Conversation>().id;
    group = (await req(ann, "POST", "/api/conversations", { userIds: [beaId, calId] })).json<Conversation>().id;
  });
  after(() => s.close());

  it("needs end-to-end encryption first", async () => {
    const k = await kitOf(ann);
    assert.equal(k.state, "off");
    assert.match(k.unavailable!, /encryption/);
    assert.equal((await req(ann, "POST", `/api/couples/${dm}/invite`)).statusCode, 403);
  });

  it("is only for 1:1 chats the caller is in", async () => {
    assert.equal((await req(ann, "GET", `/api/couples/${group}`)).statusCode, 404);
    assert.equal((await req(cal, "GET", `/api/couples/${dm}`)).statusCode, 404);
  });

  it("turns on only once both say yes", async () => {
    for (const [c, id] of [
      [ann, annId],
      [bea, beaId],
    ] as const)
      await setUp(c, id);
    assert.equal((await keyFor(dm, [annId, beaId])).statusCode, 200);

    const beaWs = await listen(s, bea);
    const r = await req(ann, "POST", `/api/couples/${dm}/invite`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json<CouplesKit>().state, "invited");
    await beaWs.waitFor("couples.updated");
    beaWs.ws.close();

    assert.equal((await req(ann, "POST", `/api/couples/${dm}/accept`)).statusCode, 409, "can't say yes for the other person");
    assert.equal((await add(ann, { kind: "idea" })).statusCode, 404, "nothing goes in until it's on");
    const on = await req(bea, "POST", `/api/couples/${dm}/accept`);
    assert.equal(on.json<CouplesKit>().state, "on");
    assert.equal((await kitOf(ann)).state, "on");
  });

  it("only takes ciphertext with the current key", async () => {
    assert.equal((await add(ann, { kind: "idea", body: "a plain idea" })).statusCode, 400);
    assert.equal((await add(ann, { kind: "idea", keyVersion: 2 })).statusCode, 409);
    assert.equal((await add(ann, { kind: "nope" })).statusCode, 400);
    assert.equal((await add(ann, { kind: "photo" })).statusCode, 400, "a photo needs its file");
    assert.equal((await add(ann, { kind: "idea", deliverAt: new Date(Date.now() + 60_000).toISOString() })).statusCode, 400, "only notes are scheduled");
  });

  it("only reveals mutual yeses on the Yes / No / Maybe list", async () => {
    const idea = (await add(ann, { kind: "idea" })).json<CouplesItem>();
    const vote = (c: string, v: string | null) => req(c, "PUT", `/api/couples/${dm}/items/${idea.id}/vote`, { vote: v });
    assert.equal((await vote(ann, "sure")).statusCode, 400);

    assert.equal((await vote(ann, "yes")).json<CouplesItem>().myVote, "yes");
    const beaView = (await item(bea, idea.id))!;
    assert.equal(beaView.myVote, null, "bea can't see ann's vote");
    assert.equal(beaView.match, null);
    assert.ok(!JSON.stringify({ ...beaView, body: "" }).includes("yes"));

    // A no looks exactly like not having voted.
    await vote(bea, "no");
    const annAfterNo = (await item(ann, idea.id))!;
    assert.equal(annAfterNo.match, null);
    assert.equal(annAfterNo.partnerAnswered, false);
    assert.ok(!JSON.stringify({ ...annAfterNo, body: "" }).includes('"no"'));

    await vote(bea, "maybe");
    assert.equal((await item(ann, idea.id))!.match, "maybe");
    await vote(bea, "yes");
    assert.equal((await item(ann, idea.id))!.match, "yes");
    assert.equal((await item(bea, idea.id))!.match, "yes");
    // Taking a vote back hides the match again.
    await vote(bea, null);
    assert.equal((await item(ann, idea.id))!.match, null);
  });

  it("shows question answers once both have answered, and then locks them", async () => {
    const q = (await add(bea, { kind: "question" })).json<CouplesItem>();
    const answer = (c: string, v: unknown) => req(c, "PUT", `/api/couples/${dm}/items/${q.id}/vote`, { vote: v });
    assert.equal((await answer(ann, 10)).statusCode, 400);
    await answer(ann, 1);
    const beaView = (await item(bea, q.id))!;
    assert.equal(beaView.partnerAnswered, true);
    assert.equal(beaView.answers, null);
    await answer(bea, 0);
    assert.deepEqual((await item(ann, q.id))!.answers, { [annId]: 1, [beaId]: 0 });
    assert.equal((await answer(ann, 0)).statusCode, 409);
  });

  it("lets the writer change cards, spinners and countdowns, and either person delete", async () => {
    const card = (await add(ann, { kind: "card" })).json<CouplesItem>();
    const body = ciphertext(80);
    assert.equal((await req(bea, "PATCH", `/api/couples/${dm}/items/${card.id}`, { body, keyVersion: 1 })).statusCode, 403);
    assert.equal((await req(ann, "PATCH", `/api/couples/${dm}/items/${card.id}`, { body, keyVersion: 1 })).json<CouplesItem>().body, body);
    const idea = (await add(ann, { kind: "idea" })).json<CouplesItem>();
    assert.equal((await req(ann, "PATCH", `/api/couples/${dm}/items/${idea.id}`, { body, keyVersion: 1 })).statusCode, 400);
    assert.equal((await req(bea, "DELETE", `/api/couples/${dm}/items/${card.id}`)).statusCode, 200);
    assert.equal(await item(ann, card.id), undefined);
  });

  it("holds a love note back until its time, then tells the other person", async () => {
    const at = new Date(Date.now() + 3600_000);
    const tooFar = new Date(Date.now() + 400 * 86_400_000).toISOString();
    assert.equal((await add(ann, { kind: "note", deliverAt: tooFar })).statusCode, 400);
    const note = (await add(ann, { kind: "note", deliverAt: at.toISOString() })).json<CouplesItem>();
    assert.equal(note.deliverAt, at.toISOString());
    assert.equal(await item(bea, note.id), undefined, "bea can't see it yet");
    assert.equal((await req(bea, "DELETE", `/api/couples/${dm}/items/${note.id}`)).statusCode, 404);
    assert.ok(await item(ann, note.id), "ann sees what she scheduled");

    const beaWs = await listen(s, bea);
    s.ctx.couples.tick(new Date(at.getTime() - 1000));
    s.ctx.couples.tick(new Date(at.getTime() + 1000));
    const e = await beaWs.waitFor("couples.updated");
    assert.equal(e.noteFrom, annId);
    beaWs.ws.close();
    // Shown by its time, not by the timer, so it's there as soon as it's due.
    assert.ok(s.ctx.couples.get(dm, beaId, new Date(at.getTime() + 1000)).items.some((i) => i.id === note.id));
  });

  let photoFile: string;

  it("lets a view-once photo be opened once, by the person it was sent to", async () => {
    const uploads = path.join(s.ctx.config.dataDir, "uploads");
    const before = new Set(readdirSync(uploads));
    const bytes = randomBytes(2000);
    const form = new FormData();
    form.append("kind", "photo");
    form.append("body", ciphertext());
    form.append("keyVersion", "1");
    form.append("file", new Blob([bytes]), "photo");
    const res = await fetch(`${s.url}/api/couples/${dm}/items`, { method: "POST", headers: { cookie: ann }, body: form });
    assert.equal(res.status, 200, await res.clone().text());
    const photo = (await res.json()) as CouplesItem;
    assert.equal(photo.fileSize, 2000);
    photoFile = readdirSync(uploads).find((f) => !before.has(f))!;
    assert.ok(photoFile);

    assert.equal((await req(ann, "GET", `/api/couples/${dm}/items/${photo.id}/photo`)).statusCode, 403, "not the sender");
    assert.equal((await req(cal, "GET", `/api/couples/${dm}/items/${photo.id}/photo`)).statusCode, 404);
    const open = await req(bea, "GET", `/api/couples/${dm}/items/${photo.id}/photo`);
    assert.equal(open.statusCode, 200);
    assert.deepEqual(open.rawPayload, bytes);
    assert.equal(open.headers["cache-control"], "no-store");
    assert.equal((await req(bea, "GET", `/api/couples/${dm}/items/${photo.id}/photo`)).statusCode, 410);
    assert.equal(existsSync(path.join(uploads, photoFile)), false, "deleted from the server");
    const after = (await item(ann, photo.id))!;
    assert.equal(after.opened, true);
    assert.equal(after.body, "");
  });

  it("isn't there for kid accounts, or chats with them", async () => {
    await setUp(cal, calId);
    await setUp(kit, kitId);
    kidDm = (await req(ann, "POST", "/api/conversations", { userId: kitId })).json<Conversation>().id;
    await keyFor(kidDm, [annId, kitId]);
    const code = (await req(cal, "POST", "/api/family/codes")).json<FamilyLinkCode>();
    assert.equal((await req(kit, "POST", "/api/family/link", { code: code.code })).statusCode, 200);

    assert.equal((await req(kit, "GET", `/api/couples/${kidDm}`)).statusCode, 404, "kids don't see it at all");
    assert.equal((await req(kit, "POST", `/api/couples/${kidDm}/invite`)).statusCode, 404);
    assert.match((await kitOf(ann, kidDm)).unavailable!, /adult/);
    assert.equal((await req(ann, "POST", `/api/couples/${kidDm}/invite`)).statusCode, 403);
  });

  it("is deleted, files and all, if either person becomes a kid account", async () => {
    // A photo still waiting to be opened, so there's a file to remove.
    const form = new FormData();
    form.append("kind", "photo");
    form.append("body", ciphertext());
    form.append("keyVersion", "1");
    form.append("file", new Blob([randomBytes(100)]), "photo");
    await fetch(`${s.url}/api/couples/${dm}/items`, { method: "POST", headers: { cookie: ann }, body: form });
    const uploads = path.join(s.ctx.config.dataDir, "uploads");
    const filesBefore = readdirSync(uploads).length;
    assert.ok((await kitOf(ann)).items.length > 0);

    const code = (await req(cal, "POST", "/api/family/codes")).json<FamilyLinkCode>();
    assert.equal((await req(bea, "POST", "/api/family/link", { code: code.code })).statusCode, 200);

    const k = await kitOf(ann);
    assert.equal(k.state, "off");
    assert.deepEqual(k.items, []);
    assert.match(k.unavailable!, /adult/);
    assert.equal(readdirSync(uploads).length, filesBefore - 1);
    const left = s.ctx.db.prepare("SELECT COUNT(*) AS n FROM couples_items").get() as { n: number };
    assert.equal(left.n, 0);
    assert.equal((await req(bea, "GET", `/api/couples/${dm}`)).statusCode, 404);
  });

  it("deletes everything when turned off", async () => {
    // Unlink bea again, so the DM is between two adults once more.
    assert.equal((await req(cal, "DELETE", `/api/family/kids/${beaId}`)).statusCode, 200);
    await req(ann, "POST", `/api/couples/${dm}/invite`);
    await req(bea, "POST", `/api/couples/${dm}/accept`);
    await add(bea, { kind: "countdown" });
    assert.equal((await kitOf(ann)).items.length, 1);
    const off = await req(bea, "DELETE", `/api/couples/${dm}`);
    assert.equal(off.json<CouplesKit>().state, "off");
    const left = s.ctx.db.prepare("SELECT COUNT(*) AS n FROM couples_items").get() as { n: number };
    assert.equal(left.n, 0);
  });
});
