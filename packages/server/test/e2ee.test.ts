import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Conversation, E2eeSetup, Message, MessageEdit, WrappedKey } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const publicKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
};
const backup = () => ({ salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) });
/** Stand-ins for what the web client makes; the server only checks their shape. */
const wrapped = () => `${b64(65)}.${b64(12)}.${b64(48)}`;
const ciphertext = (n = 40) => `${b64(12)}.${b64(n)}`;

describe("end-to-end encryption", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let dadId: number, momId: number;
  let cid: number;
  const keys: Record<number, string> = {};

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });

  const setUp = async (cookie: string, uid: number, reset = false) => {
    keys[uid] = publicKey();
    return req(cookie, "PUT", "/api/e2ee", { publicKey: keys[uid], backup: backup(), reset });
  };

  const keysFor = (ids: number[]) => Object.fromEntries(ids.map((u) => [u, { publicKey: keys[u], wrapped: wrapped() }]));

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    dadId = s.ctx.users.byUsername("dad")!.id;
    momId = s.ctx.users.byUsername("mom")!.id;
    await req(dad, "POST", "/api/friends", { username: "mom" });
    await req(mom, "POST", `/api/friends/${dadId}/accept`);
    cid = (await req(dad, "POST", "/api/conversations", { userId: momId })).json<Conversation>().id;
  });
  after(() => s.close());

  it("starts with no keys, and plain messages work", async () => {
    assert.deepEqual((await req(dad, "GET", "/api/e2ee")).json(), { publicKey: null, backup: null });
    const c = (await req(dad, "GET", "/api/conversations")).json<Conversation[]>()[0]!;
    assert.equal(c.e2ee, null);
    const m = (await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: "hi before encryption" })).json<Message>();
    assert.equal(m.keyVersion, null);
  });

  it("checks public keys and backups", async () => {
    assert.equal((await req(dad, "PUT", "/api/e2ee", { publicKey: "nope", backup: backup() })).statusCode, 400);
    assert.equal((await req(dad, "PUT", "/api/e2ee", { publicKey: b64(65), backup: backup() })).statusCode, 400, "not a point on the curve");
    assert.equal((await req(dad, "PUT", "/api/e2ee", { publicKey: publicKey(), backup: { ...backup(), iterations: 10 } })).statusCode, 400);
  });

  it("saves keys, and a different key needs reset", async () => {
    const r = await setUp(dad, dadId);
    assert.equal(r.statusCode, 200, r.body);
    const mine = (await req(dad, "GET", "/api/e2ee")).json<E2eeSetup>();
    assert.equal(mine.publicKey, keys[dadId]);
    assert.equal(mine.backup!.iterations, 600_000);

    // Changing the passphrase keeps the key.
    const again = await req(dad, "PUT", "/api/e2ee", { publicKey: keys[dadId], backup: backup() });
    assert.equal(again.statusCode, 200);
    const other = await req(dad, "PUT", "/api/e2ee", { publicKey: publicKey(), backup: backup() });
    assert.equal(other.statusCode, 409);

    // Others see the public key, to encrypt to it.
    const friends = (await req(mom, "GET", "/api/friends")).json<{ user: { publicKey: string } }[]>();
    assert.equal(friends[0]!.user.publicKey, keys[dadId]);
  });

  it("won't make a conversation key until everyone has set up", async () => {
    const r = await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 1, keys: { [dadId]: { publicKey: keys[dadId], wrapped: wrapped() } } });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /mom hasn't set up/);
  });

  it("makes a key for everyone, then only takes encrypted messages", async () => {
    await setUp(mom, momId);
    const momEvents = await listen(s, mom);

    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 1, keys: { [dadId]: { publicKey: keys[dadId], wrapped: wrapped() } } })).statusCode, 400, "must cover mom");
    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 2, keys: keysFor([dadId, momId]) })).statusCode, 409, "versions go in order");
    const stale = keysFor([dadId, momId]);
    stale[momId]!.publicKey = publicKey();
    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 1, keys: stale })).statusCode, 409, "wrapped to an old key");
    assert.equal((await req(kit, "POST", `/api/conversations/${cid}/keys`, { version: 1, keys: keysFor([dadId, momId]) })).statusCode, 404);

    const r = await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 1, keys: keysFor([dadId, momId]) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json<Conversation>().e2ee, { version: 1, missing: [] });
    const update = await momEvents.waitFor("conversation.updated");
    assert.equal(update.conversation.e2ee?.version, 1);
    momEvents.ws.close();

    const mine = (await req(mom, "GET", `/api/conversations/${cid}/keys`)).json<WrappedKey[]>();
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.version, 1);
    assert.equal((await req(kit, "GET", `/api/conversations/${cid}/keys`)).statusCode, 404);

    const plain = await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: "in the clear" });
    assert.equal(plain.statusCode, 409, "no plain messages once there's a key");
    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: "not ciphertext", keyVersion: 1 })).statusCode, 400);
    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: ciphertext(), keyVersion: 2 })).statusCode, 409);

    const body = ciphertext();
    const m = await req(dad, "POST", `/api/conversations/${cid}/messages`, { body, keyVersion: 1 });
    assert.equal(m.statusCode, 200, m.body);
    assert.equal(m.json<Message>().keyVersion, 1);
    assert.equal(m.json<Message>().body, body);

    // Edits stay encrypted.
    const id = m.json<Message>().id;
    assert.equal((await req(dad, "PATCH", `/api/messages/${id}`, { body: "plain edit" })).statusCode, 409);
    const edited = await req(dad, "PATCH", `/api/messages/${id}`, { body: ciphertext(60), keyVersion: 1 });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.ok(edited.json<Message>().editedAt);
    // The earlier version is kept as the ciphertext it was, never in the clear.
    const edits = (await req(mom, "GET", `/api/messages/${id}/edits`)).json<MessageEdit[]>();
    assert.deepEqual(edits.map((e) => [e.body, e.keyVersion]), [[body, 1]]);
    assert.equal((await req(kit, "GET", `/api/messages/${id}/edits`)).statusCode, 404);
  });

  it("stores encrypted files without their names or types", async () => {
    const form = new FormData();
    form.append("body", ciphertext());
    form.append("keyVersion", "1");
    form.append("file", new Blob([new Uint8Array(randomBytes(100))], { type: "image/png" }), "secret-plans.png");
    const res = await fetch(`${s.url}/api/conversations/${cid}/messages`, { method: "POST", headers: { cookie: mom }, body: form });
    const m = (await res.json()) as Message;
    assert.equal(res.status, 200, JSON.stringify(m));
    assert.equal(m.attachments[0]!.name, "file");
    assert.equal(m.attachments[0]!.contentType, "application/octet-stream");
    const got = await fetch(`${s.url}${m.attachments[0]!.url}`, { headers: { cookie: dad } });
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    assert.equal((await got.arrayBuffer()).byteLength, 100);
  });

  it("after a reset, the conversation needs a new key version", async () => {
    const before = (await req(mom, "GET", `/api/conversations/${cid}/keys`)).json<WrappedKey[]>();
    assert.equal(before.length, 1);
    assert.equal((await setUp(mom, momId, true)).statusCode, 200);
    // Mom's copy was for her old key, so she can't use it, and she shows as missing.
    assert.deepEqual((await req(mom, "GET", `/api/conversations/${cid}/keys`)).json(), []);
    const c = (await req(dad, "GET", "/api/conversations")).json<Conversation[]>().find((x) => x.id === cid)!;
    assert.deepEqual(c.e2ee, { version: 1, missing: [momId] });

    const r = await req(dad, "POST", `/api/conversations/${cid}/keys`, { version: 2, keys: keysFor([dadId, momId]) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json<Conversation>().e2ee, { version: 2, missing: [] });
    assert.equal((await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: ciphertext(), keyVersion: 1 })).statusCode, 409, "must use the newest key");
    assert.equal((await req(dad, "GET", `/api/conversations/${cid}/keys`)).json<WrappedKey[]>().length, 2);
    assert.equal((await req(mom, "GET", `/api/conversations/${cid}/keys`)).json<WrappedKey[]>().length, 1);
  });

  it("deleting an encrypted message drops its ciphertext", async () => {
    const m = (await req(dad, "POST", `/api/conversations/${cid}/messages`, { body: ciphertext(), keyVersion: 2 })).json<Message>();
    const d = (await s.app.inject({ method: "DELETE", url: `/api/messages/${m.id}`, headers: { cookie: dad } })).json<Message>();
    assert.equal(d.deleted, true);
    assert.equal(d.body, "");
    assert.equal(d.keyVersion, null);
  });
});
