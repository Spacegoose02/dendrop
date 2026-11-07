import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import type { Channel, ChatServer, VoiceChannelState, VoiceJoin } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("voice channels", () => {
  let s: TestServer;
  let owner: string, ann: string, bob: string, out: string;
  let ownerId: number, annId: number, bobId: number;
  let sid: number;
  let lounge: Channel, games: Channel, general: Channel;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const ids = (v: VoiceChannelState) => v.members.map((m) => m.userId).sort();

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK });
    owner = await account(s, "owner");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    out = await account(s, "out");
    [ownerId, annId, bobId] = ["owner", "ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    sid = sv.id;
    general = sv.channels[0]!;
    for (const c of [ann, bob]) assert.equal((await call(c, "POST", `/api/servers/${sid}/join`)).status, 200);
    lounge = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "lounge", kind: "voice" })).body;
    games = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "games", kind: "voice" })).body;
  });
  after(() => s.close());

  it("makes voice channels, and keeps text the default", async () => {
    assert.equal(lounge.kind, "voice");
    assert.equal(general.kind, "text");
    assert.equal((await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "x", kind: "video" })).status, 400);
    const sv = (await call(ann, "GET", `/api/servers/${sid}`)).body as ChatServer;
    assert.deepEqual(
      sv.channels.map((c) => [c.name, c.kind]),
      [
        ["general", "text"],
        ["lounge", "voice"],
        ["games", "voice"],
      ],
    );
  });

  it("drops people in without ringing, tells everyone who can see it, and hands out a token for that room", async () => {
    const bobLive = await listen(s, bob);
    const r = await call(ann, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    assert.equal(r.status, 200);
    const join = r.body as VoiceJoin;
    assert.equal(join.url, LK.DENDROP_LIVEKIT_URL);
    assert.deepEqual(ids(join.voice), [annId]);
    const grant = await new TokenVerifier(LK.DENDROP_LIVEKIT_API_KEY, LK.DENDROP_LIVEKIT_API_SECRET).verify(join.token);
    assert.equal(grant.sub, String(annId));
    assert.equal(grant.video?.room, `dendrop-voice-${lounge.id}`);
    assert.equal(grant.video?.canPublishData, false);

    const seen = await bobLive.waitFor("voice.updated");
    assert.equal(seen.voice.channelId, lounge.id);
    assert.deepEqual(ids(seen.voice), [annId]);
    assert.deepEqual((await call(bob, "GET", "/api/voice")).body.map((v: VoiceChannelState) => v.channelId), [lounge.id]);
    bobLive.ws.close();
  });

  it("keeps you in one voice channel at a time", async () => {
    await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    await call(ann, "POST", `/api/servers/${sid}/channels/${games.id}/voice`);
    const all = (await call(owner, "GET", "/api/voice")).body as VoiceChannelState[];
    const by = Object.fromEntries(all.map((v) => [v.channelId, ids(v)]));
    assert.deepEqual(by, { [lounge.id]: [bobId], [games.id]: [annId] });
  });

  it("shares mute and deafen; deafened means muted too", async () => {
    let v = (await call(bob, "POST", "/api/voice/state", { muted: true })).body as VoiceChannelState;
    assert.equal(v.members[0]!.muted, true);
    v = (await call(bob, "POST", "/api/voice/state", { muted: false, deafened: true })).body;
    assert.deepEqual([v.members[0]!.muted, v.members[0]!.deafened], [true, true]);
    assert.equal((await call(owner, "POST", "/api/voice/state", { muted: true })).status, 400);
  });

  it("refuses text channels, other servers' channels, and people who aren't in the server", async () => {
    assert.equal((await call(ann, "POST", `/api/servers/${sid}/channels/${general.id}/voice`)).status, 400);
    assert.equal((await call(out, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`)).status, 404);
    assert.equal((await call(out, "GET", "/api/voice")).body.length, 0);
    assert.equal((await call(ann, "POST", `/api/servers/${sid}/channels/999/voice`)).status, 404);
  });

  it("takes people out when the channel is locked away from them, and hides it from them", async () => {
    const bobLive = await listen(s, bob);
    // games is locked to the owner (and admins) only; ann is in it.
    assert.equal((await call(owner, "PATCH", `/api/servers/${sid}/channels/${games.id}`, { locked: true, memberIds: [] })).status, 200);
    assert.equal((await call(ann, "GET", "/api/voice")).body.some((v: VoiceChannelState) => v.channelId === games.id), false);
    assert.equal((await call(ann, "POST", `/api/servers/${sid}/channels/${games.id}/voice`)).status, 404);
    // Bob can't see games any more, so he hears nothing about it.
    const v = (await call(owner, "POST", `/api/servers/${sid}/channels/${games.id}/voice`)).body as VoiceJoin;
    assert.deepEqual(ids(v.voice), [ownerId]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      bobLive.events.some((e) => e.type === "voice.updated" && e.voice.channelId === games.id),
      false,
    );
    bobLive.ws.close();
  });

  it("takes people out when they're removed from the server, and when they leave", async () => {
    // Closing his last connection earlier took bob out of voice; he's back in.
    const bobLive = await listen(s, bob);
    await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    await bobLive.waitFor("voice.updated");
    assert.equal((await call(owner, "DELETE", `/api/servers/${sid}/members/${bobId}`)).status, 200);
    const gone = await bobLive.waitFor("voice.updated");
    assert.equal(gone.voice.members.some((m) => m.userId === bobId), false);
    assert.equal((await call(owner, "GET", "/api/voice")).body.some((v: VoiceChannelState) => v.channelId === lounge.id), false);
    bobLive.ws.close();

    await call(owner, "POST", "/api/voice/leave");
    assert.deepEqual((await call(owner, "GET", "/api/voice")).body, []);
  });

  it("takes people out when their last connection closes", async () => {
    const annLive = await listen(s, ann);
    await call(ann, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    assert.equal((await call(owner, "GET", "/api/voice")).body.length, 1);
    annLive.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await call(owner, "GET", "/api/voice")).body, []);
  });

  it("empties a server's voice channels when it's deleted", async () => {
    await call(owner, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    assert.equal((await call(owner, "DELETE", `/api/servers/${sid}`)).status, 200);
    assert.deepEqual((await call(owner, "GET", "/api/voice")).body, []);
  });
});

describe("voice channels without a call server", () => {
  it("says voice isn't set up", async () => {
    const s = await startServer({ DENDROP_SIGNUP: "true", DENDROP_CALLS: "off" });
    try {
      const owner = await account(s, "owner");
      const sv = (await s.app.inject({ method: "POST", url: "/api/servers", headers: { cookie: owner }, payload: { name: "Den" } })).json() as ChatServer;
      const ch = (
        await s.app.inject({ method: "POST", url: `/api/servers/${sv.id}/channels`, headers: { cookie: owner }, payload: { name: "lounge", kind: "voice" } })
      ).json() as Channel;
      const r = await s.app.inject({ method: "POST", url: `/api/servers/${sv.id}/channels/${ch.id}/voice`, headers: { cookie: owner } });
      assert.equal(r.statusCode, 404);
    } finally {
      await s.close();
    }
  });
});
