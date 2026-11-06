import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import type { CallJoin } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("calls", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let dm: number, group: number;
  let dadId: number, momId: number, kitId: number;
  const post = (cookie: string, url: string, payload: object = {}) => s.app.inject({ method: "POST", url, headers: { cookie }, payload });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK }, { callRingMs: 300 });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    [dadId, momId, kitId] = ["dad", "mom", "kit"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    for (const [c, other, otherId] of [
      [mom, "dad", dadId],
      [kit, "dad", dadId],
    ] as const) {
      await post(dad, "/api/friends", { username: other === "dad" ? (c === mom ? "mom" : "kit") : other });
      await post(c, `/api/friends/${otherId}/accept`);
    }
    dm = (await post(dad, "/api/conversations", { userId: momId })).json().id;
    group = (await post(dad, "/api/conversations", { userIds: [momId, kitId] })).json().id;
  });
  after(() => s.close());

  it("says calls are on, rings the other person and hands out a token for this room only", async () => {
    assert.equal((await s.app.inject({ url: "/api/server", headers: { cookie: dad } })).json().calls, true);
    const momLive = await listen(s, mom);
    const start = await post(dad, `/api/conversations/${dm}/call`, { video: true });
    assert.equal(start.statusCode, 200);
    const join = start.json() as CallJoin;
    assert.equal(join.url, LK.DENDROP_LIVEKIT_URL);
    assert.deepEqual([join.call.joined, join.call.ringing, join.call.video], [[dadId], [momId], true]);
    const ring = await momLive.waitFor("call.updated");
    assert.deepEqual(ring.call.ringing, [momId]);

    const grant = await new TokenVerifier(LK.DENDROP_LIVEKIT_API_KEY, LK.DENDROP_LIVEKIT_API_SECRET).verify(join.token);
    assert.equal(grant.sub, String(dadId));
    assert.equal(grant.video?.room, `dendrop-conversation-${dm}`);

    // Mom answers; then she hangs up, which ends a 1:1 call for both.
    const answer = (await post(mom, `/api/conversations/${dm}/call`)).json() as CallJoin;
    assert.deepEqual(answer.call.joined.sort(), [dadId, momId].sort());
    assert.deepEqual(answer.call.ringing, []);
    await post(mom, `/api/conversations/${dm}/call/leave`);
    const ended = await momLive.waitFor("call.ended");
    assert.deepEqual([ended.conversationId, ended.missed], [dm, false]);
    assert.deepEqual((await s.app.inject({ url: "/api/calls", headers: { cookie: dad } })).json(), []);
    momLive.ws.close();
  });

  it("declining a 1:1 call ends it; no answer counts as missed", async () => {
    const dadLive = await listen(s, dad);
    await post(dad, `/api/conversations/${dm}/call`);
    await post(mom, `/api/conversations/${dm}/call/decline`);
    assert.equal((await dadLive.waitFor("call.ended")).missed, false);

    await post(dad, `/api/conversations/${dm}/call`);
    const missed = await dadLive.waitFor("call.ended", 2000);
    assert.equal(missed.missed, true);
    dadLive.ws.close();
  });

  it("keeps a group call going until the last person leaves", async () => {
    await post(dad, `/api/conversations/${group}/call`);
    await post(kit, `/api/conversations/${group}/call`);
    await post(dad, `/api/conversations/${group}/call/leave`);
    const calls = (await s.app.inject({ url: "/api/calls", headers: { cookie: kit } })).json();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].joined, [kitId]);
    await post(kit, `/api/conversations/${group}/call/leave`);
    assert.deepEqual((await s.app.inject({ url: "/api/calls", headers: { cookie: kit } })).json(), []);
  });

  it("only lets members call, and takes people out of calls when they disconnect", async () => {
    assert.equal((await post(kit, `/api/conversations/${dm}/call`)).statusCode, 404);
    const momLive = await listen(s, mom);
    const dadLive = await listen(s, dad);
    await post(dad, `/api/conversations/${dm}/call`);
    await post(mom, `/api/conversations/${dm}/call`);
    dadLive.ws.close();
    assert.equal((await momLive.waitFor("call.ended")).conversationId, dm);
    momLive.ws.close();
  });

  it("is off without LiveKit settings", async () => {
    const t = await startServer();
    try {
      const c = await account(t, "solo");
      assert.equal((await t.app.inject({ url: "/api/server", headers: { cookie: c } })).json().calls, false);
    } finally {
      await t.close();
    }
  });
});
