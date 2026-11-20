import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Conversation } from "@dendrop/shared";
import { SPAM_LIMITS, SpamGuard, waitWords } from "../src/spam.js";
import { account, startServer, type TestServer } from "./helpers.js";

describe("spam limits", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let cid: number;
  let clock = 1_000_000;
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082", "hex");
  const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json(), retryAfter: res.headers["retry-after"] };
  };
  const postFiles = async (cookie: string, n: number) => {
    const form = new FormData();
    form.append("body", "pics");
    for (let i = 0; i < n; i++) form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), `p${i}.png`);
    const res = await fetch(`${s.url}/api/conversations/${cid}/messages`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  before(async () => {
    // Small limits and a clock the test moves, so nothing has to wait for real.
    const spam = new SpamGuard(
      {
        messages: [{ max: 3, windowMs: 10_000 }],
        uploads: [{ max: 4, windowMs: 60_000 }],
        friendRequests: [{ max: 2, windowMs: 600_000 }],
      },
      () => clock,
    );
    s = await startServer({ DENDROP_SIGNUP: "true" }, { spam });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    const momId = s.ctx.users.byUsername("mom")!.id;
    await call(mom, "POST", "/api/friends", { username: "dad" });
    await call(dad, "POST", `/api/friends/${momId}/accept`);
    cid = ((await call(dad, "POST", "/api/conversations", { userId: momId })).body as Conversation).id;
  });
  after(() => s.close());

  it("lets a burst of messages through, then asks to slow down, then lets them go again", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: `hi ${i}` })).status, 200);
    const r = await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: "one more" });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /^Easy, raccoon! .*send more messages in 10 seconds\.$/);
    assert.equal(r.retryAfter, "10");
    // The flood never reached the chat.
    const msgs = (await call(mom, "GET", `/api/conversations/${cid}/messages`)).body as { body: string }[];
    assert.ok(!msgs.some((m) => m.body === "one more"));
    // It's per account: mom can still talk.
    assert.equal((await call(mom, "POST", `/api/conversations/${cid}/messages`, { body: "slow down!" })).status, 200);
    // Polls count as messages too.
    assert.equal((await call(dad, "POST", `/api/conversations/${cid}/polls`, { question: "Pizza?", options: ["Yes", "No"] })).status, 429);
    clock += 10_001;
    assert.equal((await call(dad, "POST", `/api/conversations/${cid}/messages`, { body: "sorry" })).status, 200);
  });

  it("counts each file, and cleans up the files of a message it turns away", async () => {
    clock += 60_000;
    const uploads = path.join(s.ctx.config.dataDir, "uploads");
    const before = readdirSync(uploads).length;
    assert.equal((await postFiles(mom, 3)).status, 200);
    const over = await postFiles(mom, 2);
    assert.equal(over.status, 429);
    assert.match(over.body.error ?? "", /upload more files in 1 minute/);
    assert.equal(readdirSync(uploads).length, before + 3);
    // Out of uploads: the next one is turned away before it's read, but plain messages still go.
    assert.equal((await postFiles(mom, 1)).status, 429);
    assert.equal((await call(mom, "POST", `/api/conversations/${cid}/messages`, { body: "no pics then" })).status, 200);
    clock += 60_001;
    assert.equal((await postFiles(mom, 1)).status, 200);
  });

  it("limits friend requests, counting ones for usernames that aren't there", async () => {
    assert.equal((await call(kit, "POST", "/api/friends", { username: "nobody_here" })).status, 404);
    assert.equal((await call(kit, "POST", "/api/friends", { username: "mom" })).status, 200);
    const r = await call(kit, "POST", "/api/friends", { username: "dad" });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /send more friend requests in 10 minutes/);
    // Accepting a request isn't limited.
    const kitId = s.ctx.users.byUsername("kit")!.id;
    assert.equal((await call(mom, "POST", `/api/friends/${kitId}/accept`)).status, 200);
    clock += 600_001;
    assert.equal((await call(kit, "POST", "/api/friends", { username: "dad" })).status, 200);
  });

  it("has defaults a family won't hit, and says how long to wait in plain words", () => {
    assert.ok(SPAM_LIMITS.messages[0].max >= 20);
    assert.ok(SPAM_LIMITS.uploads[0].max >= 3 * 10);
    assert.equal(waitWords(1), "1 second");
    assert.equal(waitWords(59_000), "59 seconds");
    assert.equal(waitWords(61_000), "2 minutes");
    assert.equal(waitWords(3 * 3_600_000), "3 hours");
  });
});
