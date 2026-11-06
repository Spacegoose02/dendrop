import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Conversation, Message } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

/** Sends a multipart message the way a browser does. */
async function post(s: TestServer, cookie: string, cid: number, body: string | null, files: { name: string; type: string; data: Buffer }[]) {
  const form = new FormData();
  if (body !== null) form.append("body", body);
  for (const f of files) form.append("file", new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  const res = await fetch(`${s.url}/api/conversations/${cid}/messages`, { method: "POST", headers: { cookie }, body: form });
  return { status: res.status, body: (await res.json()) as Message & { error?: string } };
}

describe("files, read receipts", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let cid: number;
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082", "hex");

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", DENDROP_MAX_UPLOAD_MB: "1" });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    const momId = s.ctx.users.byUsername("mom")!.id;
    const dadId = s.ctx.users.byUsername("dad")!.id;
    await s.app.inject({ method: "POST", url: "/api/friends", headers: { cookie: dad }, payload: { username: "mom" } });
    await s.app.inject({ method: "POST", url: `/api/friends/${dadId}/accept`, headers: { cookie: mom } });
    cid = (await s.app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: dad }, payload: { userId: momId } })).json().id;
  });
  after(() => s.close());

  it("sends pictures and files; pictures show inline, other files download", async () => {
    const r = await post(s, dad, cid, "Look!", [
      { name: "../../etc/kids.png", type: "image/png", data: PNG },
      { name: "plan.html", type: "text/html", data: Buffer.from("<script>alert(1)</script>") },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.body, "Look!");
    const [img, html] = r.body.attachments;
    assert.equal(img!.name, "kids.png", "no path in the name");
    assert.equal(img!.size, PNG.length);

    const got = await fetch(`${s.url}${img!.url}`, { headers: { cookie: mom } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.match(got.headers.get("content-disposition")!, /^inline/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

    const h = await fetch(`${s.url}${html!.url}`, { headers: { cookie: mom } });
    assert.equal(h.headers.get("content-type"), "application/octet-stream");
    assert.match(h.headers.get("content-disposition")!, /^attachment/);
    await h.arrayBuffer();

    const outsider = await fetch(`${s.url}${img!.url}`, { headers: { cookie: kit } });
    assert.equal(outsider.status, 404);
  });

  it("allows a file with no text, but not an empty message", async () => {
    assert.equal((await post(s, dad, cid, null, [{ name: "a.txt", type: "text/plain", data: Buffer.from("hi") }])).status, 200);
    assert.equal((await post(s, dad, cid, "", [])).status, 400);
  });

  it("refuses files over the limit and leaves nothing behind", async () => {
    const uploads = path.join(s.ctx.config.dataDir, "uploads");
    const before = readdirSync(uploads).length;
    const r = await post(s, dad, cid, "big", [{ name: "big.bin", type: "application/octet-stream", data: Buffer.alloc(1024 * 1024 + 10) }]);
    assert.equal(r.status, 413);
    assert.equal(readdirSync(uploads).length, before);
  });

  it("deleting a message removes its files", async () => {
    const r = await post(s, dad, cid, "oops", [{ name: "x.png", type: "image/png", data: PNG }]);
    const file = path.join(s.ctx.config.dataDir, "uploads", r.body.attachments[0]!.id);
    assert.ok(existsSync(file));
    const del = await s.app.inject({ method: "DELETE", url: `/api/messages/${r.body.id}`, headers: { cookie: dad } });
    assert.deepEqual(del.json().attachments, []);
    assert.ok(!existsSync(file));
  });

  it("shares how far each person has read, unless they turn read receipts off", async () => {
    const last = (await s.app.inject({ url: `/api/conversations/${cid}/messages`, headers: { cookie: mom } })).json().at(-1) as Message;
    const read = await s.app.inject({ method: "POST", url: `/api/conversations/${cid}/read`, headers: { cookie: mom }, payload: { messageId: last.id } });
    assert.equal(read.statusCode, 200);
    const momId = s.ctx.users.byUsername("mom")!.id;
    const seenBy = (list: Conversation[]) => list.find((c) => c.id === cid)!.reads.find((r) => r.userId === momId)?.messageId;
    assert.equal(seenBy((await s.app.inject({ url: "/api/conversations", headers: { cookie: dad } })).json()), last.id);

    // Moving back does nothing.
    await s.app.inject({ method: "POST", url: `/api/conversations/${cid}/read`, headers: { cookie: mom }, payload: { messageId: 1 } });
    assert.equal(seenBy((await s.app.inject({ url: "/api/conversations", headers: { cookie: dad } })).json()), last.id);

    await s.app.inject({ method: "PATCH", url: "/api/me", headers: { cookie: mom }, payload: { readReceipts: false } });
    assert.equal(seenBy((await s.app.inject({ url: "/api/conversations", headers: { cookie: dad } })).json()), undefined, "dad no longer sees mom's");
    const momView = (await s.app.inject({ url: "/api/conversations", headers: { cookie: mom } })).json() as Conversation[];
    assert.deepEqual(momView.find((c) => c.id === cid)!.reads, [], "and mom sees no one's");

    // Kit can't mark a conversation they're not in.
    const k = await s.app.inject({ method: "POST", url: `/api/conversations/${cid}/read`, headers: { cookie: kit }, payload: { messageId: last.id } });
    assert.equal(k.statusCode, 404);
  });
});
