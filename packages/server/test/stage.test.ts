import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import type { Channel, ChatServer, VoiceChannelState, VoiceJoin, VoiceMember } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

// No call server answers here: letting someone speak is still recorded, and the call server is told best effort.
const LK = { DENDROP_LIVEKIT_URL: "ws://127.0.0.1:9", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("stage channels", () => {
  let s: TestServer;
  let owner: string, ann: string, bob: string;
  let ownerId: number, annId: number, bobId: number;
  let sid: number;
  let stage: Channel, lounge: Channel;
  const call = async (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const grant = (token: string) => new TokenVerifier(LK.DENDROP_LIVEKIT_API_KEY, LK.DENDROP_LIVEKIT_API_SECRET).verify(token);
  const who = (v: VoiceChannelState, userId: number) => v.members.find((m) => m.userId === userId) as VoiceMember;
  const speak = (cookie: string, userId: number, speaker: boolean) => call(cookie, "PUT", `/api/servers/${sid}/channels/${stage.id}/stage/${userId}`, { speaker });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK });
    owner = await account(s, "owner");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    [ownerId, annId, bobId] = ["owner", "ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    sid = sv.id;
    for (const c of [ann, bob]) await call(c, "POST", `/api/servers/${sid}/join`);
    stage = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "movie-night", kind: "stage" })).body;
    lounge = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "lounge", kind: "voice" })).body;
  });
  after(() => s.close());

  it("brings moderators in as speakers and everyone else in as listeners who can't publish", async () => {
    const host = (await call(owner, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`)).body as VoiceJoin;
    assert.equal(host.voice.stage, true);
    assert.equal(who(host.voice, ownerId).speaker, true);
    assert.equal((await grant(host.token)).video?.canPublish, true);

    const guest = (await call(ann, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`)).body as VoiceJoin;
    const me = who(guest.voice, annId);
    assert.deepEqual([me.speaker, me.muted], [false, true]);
    assert.equal((await grant(guest.token)).video?.canPublish, false);

    // Voice channels are unchanged: everyone talks.
    const lk = (await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`)).body as VoiceJoin;
    assert.equal(lk.voice.stage, false);
    assert.equal(who(lk.voice, bobId).speaker, true);
    assert.equal((await call(bob, "POST", "/api/voice/hand", { raised: true })).status, 400, "no hands in voice channels");
  });

  it("keeps listeners muted, with no camera or screen", async () => {
    const v = (await call(ann, "POST", "/api/voice/state", { muted: false, video: true, screen: true })).body as VoiceChannelState;
    const me = who(v, annId);
    assert.deepEqual([me.muted, me.video, me.screen], [true, false, false]);
  });

  it("lets listeners raise a hand, and moderators let them speak", async () => {
    let v = (await call(ann, "POST", "/api/voice/hand", { raised: true })).body as VoiceChannelState;
    assert.equal(who(v, annId).handRaised, true);
    assert.equal((await call(owner, "POST", "/api/voice/hand", { raised: true })).status, 400, "speakers already speak");

    // Only moderators pick speakers.
    await call(bob, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`);
    assert.equal((await speak(bob, annId, true)).status, 403);
    assert.equal((await speak(bob, bobId, true)).status, 403, "no promoting yourself");

    v = (await speak(owner, annId, true)).body;
    assert.deepEqual([who(v, annId).speaker, who(v, annId).handRaised], [true, false]);
    v = (await call(ann, "POST", "/api/voice/state", { muted: false })).body;
    assert.equal(who(v, annId).muted, false);
    // Rejoining hands out a token that can publish now.
    const again = (await call(ann, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`)).body as VoiceJoin;
    assert.equal((await grant(again.token)).video?.canPublish, true);
  });

  it("moves speakers back to the audience, by a moderator or by themselves", async () => {
    let v = (await speak(owner, annId, false)).body as VoiceChannelState;
    assert.deepEqual([who(v, annId).speaker, who(v, annId).muted], [false, true]);
    v = (await speak(owner, bobId, true)).body;
    assert.equal(who(v, bobId).speaker, true);
    v = (await speak(bob, bobId, false)).body;
    assert.equal(who(v, bobId).speaker, false);
    assert.equal((await speak(owner, 9999, true)).status, 404);
    assert.equal((await call(owner, "PUT", `/api/servers/${sid}/channels/${lounge.id}/stage/${bobId}`, { speaker: true })).status, 400);
  });

  it("lets people with Manage events run the stage too", async () => {
    const role = (await call(owner, "POST", `/api/servers/${sid}/roles`, { name: "Hosts", permissions: ["manageEvents"] })).body;
    await call(owner, "PUT", `/api/servers/${sid}/members/${bobId}/roles`, { roleIds: [role.id] });
    const v = (await speak(bob, annId, true)).body as VoiceChannelState;
    assert.equal(who(v, annId).speaker, true);
  });
});
