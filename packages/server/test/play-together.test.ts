import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Channel, ChatServer } from "@dendrop/shared";
import type { LootdenFetch } from "../src/lootden.js";
import { playChannelName } from "../src/play-together.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("voice channels for playing together", () => {
  let s: TestServer;
  let admin: string, bob: string, ann: string, kid: string;
  let adminId: number, bobId: number, annId: number, kidId: number;
  let serverId: number;
  /** LootDen's Playing now: [LootDen profile id, title]. */
  let playing: [number, string][] = [];

  const reply = (status: number, body: unknown) => ({
    ok: status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers({ "content-type": "application/json" }),
  });
  const fetchImpl: LootdenFetch = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/api/users")
      return reply(200, [
        { id: 1, username: "admin", displayName: "Admin", email: null, kidMode: false, role: "admin" },
        { id: 2, username: "bob", displayName: "Bob", email: null, kidMode: false, role: "user" },
        { id: 3, username: "ann", displayName: "Ann", email: null, kidMode: false, role: "user" },
        { id: 4, username: "kiddo", displayName: "Kiddo", email: null, kidMode: true, role: "user" },
      ]);
    if (p === "/api/family/now-playing")
      return reply(
        200,
        playing.map(([userId, title], i) => ({ userId, device: `PC-${i}`, title, href: null, startedAt: "2026-11-07T18:00:00Z" })),
      );
    return reply(404, { error: "Not found" });
  };

  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const check = () => call(admin, "POST", "/api/admin/lootden/check");
  const voiceOf = async (cookie: string): Promise<Channel[]> =>
    ((await call(cookie, "GET", `/api/servers/${serverId}`)).body as ChatServer).channels.filter((c) => c.kind === "voice");

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK }, { lootdenFetch: fetchImpl });
    admin = await account(s, "admin");
    bob = await account(s, "bob");
    ann = await account(s, "ann");
    kid = await account(s, "kiddo");
    [adminId, bobId, annId, kidId] = ["admin", "bob", "ann", "kiddo"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
    const sv = (await call(admin, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    serverId = sv.id;
    for (const c of [bob, ann]) assert.equal((await call(c, "POST", `/api/servers/${serverId}/join`)).status, 200);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden", { url: "https://games.example.net", token: "t" })).status, 200);
  });
  after(() => s.close());

  it("names channels after the game", () => {
    assert.equal(playChannelName("Stardew Valley"), "playing-stardew-valley");
    assert.equal(playChannelName("!!!"), "playing");
    assert.ok(playChannelName("The Legend of Something Very Long Indeed").length <= 32);
  });

  it("opens nothing for one person playing alone", async () => {
    playing = [[2, "Stardew Valley"]];
    await check();
    assert.deepEqual(await voiceOf(bob), []);
  });

  it("opens a voice channel when two play the same game, and asks them to join", async () => {
    const bobGw = await listen(s, bob);
    const annGw = await listen(s, ann);
    const adminGw = await listen(s, admin);
    playing = [
      [2, "Stardew Valley"],
      [3, "Stardew Valley"],
      [1, "DOOM"],
    ];
    await check();
    const [voice] = await voiceOf(bob);
    assert.equal(voice?.name, "playing-stardew-valley");
    assert.equal(voice?.locked, false);
    const e = await bobGw.waitFor("play.together");
    assert.deepEqual(e.invite, { serverId, channelId: voice!.id, game: "Stardew Valley", userIds: [bobId, annId] });
    assert.equal((await annGw.waitFor("play.together")).invite.channelId, voice!.id);
    // Asked once, not every check; and the one playing something else isn't asked.
    await check();
    assert.equal(bobGw.events.some((x) => x.type === "play.together"), false);
    assert.equal(adminGw.events.some((x) => x.type === "play.together"), false);
    assert.equal((await voiceOf(bob)).length, 1);
    for (const g of [bobGw, annGw, adminGw]) g.ws.close();
  });

  it("keeps it while anyone's playing or talking, and takes it away after", async () => {
    const [voice] = await voiceOf(bob);
    playing = [[2, "Stardew Valley"]];
    await check();
    assert.equal((await voiceOf(bob)).length, 1, "Bob is still playing");
    playing = [];
    assert.equal((await call(ann, "POST", `/api/servers/${serverId}/channels/${voice!.id}/voice`, {})).status, 200);
    await check();
    assert.equal((await voiceOf(bob)).length, 1, "Ann is still talking in it");
    await call(ann, "POST", "/api/voice/leave", {});
    await check();
    assert.deepEqual(await voiceOf(bob), []);
    assert.equal(s.ctx.db.prepare("SELECT COUNT(*) AS n FROM play_together_channels").get()!.n, 0);
  });

  it("only counts people who share what they're playing", async () => {
    assert.equal((await call(ann, "PATCH", "/api/me", { shareActivity: false })).status, 200);
    playing = [
      [2, "Hades"],
      [3, "Hades"],
    ];
    await check();
    assert.deepEqual(await voiceOf(bob), []);
    // Turning it back on counts again straight away.
    assert.equal((await call(ann, "PATCH", "/api/me", { shareActivity: true })).status, 200);
    assert.equal((await voiceOf(bob))[0]?.name, "playing-hades");
    playing = [];
    await check();
    assert.deepEqual(await voiceOf(bob), []);
  });

  it("doesn't open it again after a moderator deletes it, until everyone's stopped", async () => {
    playing = [
      [2, "Celeste"],
      [3, "Celeste"],
    ];
    await check();
    const [voice] = await voiceOf(bob);
    assert.equal((await call(admin, "DELETE", `/api/servers/${serverId}/channels/${voice!.id}`)).status, 200);
    await check();
    assert.deepEqual(await voiceOf(bob), []);
    playing = [];
    await check();
    playing = [
      [2, "Celeste"],
      [3, "Celeste"],
    ];
    await check();
    assert.equal((await voiceOf(bob))[0]?.name, "playing-celeste");
    playing = [];
    await check();
  });

  it("can be turned off for a server", async () => {
    assert.equal((await call(bob, "PATCH", `/api/servers/${serverId}`, { playTogether: false })).status, 403);
    const res = await call(admin, "PATCH", `/api/servers/${serverId}`, { playTogether: false });
    assert.equal((res.body as ChatServer).playTogether, false);
    playing = [
      [2, "Hades"],
      [3, "Hades"],
    ];
    await check();
    assert.deepEqual(await voiceOf(bob), []);
    await call(admin, "PATCH", `/api/servers/${serverId}`, { playTogether: true });
    await check();
    assert.equal((await voiceOf(bob)).length, 1);
    playing = [];
    await check();
  });

  it("keeps grown-up games from kids, and opens kid-safe ones to everyone", async () => {
    // kiddo becomes a kid account and joins the server.
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kidId, adminId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, can_join_servers) VALUES (?, 1)").run(kidId);
    assert.equal((await call(kid, "POST", `/api/servers/${serverId}/join`)).status, 200);

    // A grown-up game: locked to the grown-ups, so kiddo doesn't see its name.
    playing = [
      [2, "DOOM"],
      [3, "DOOM"],
    ];
    await check();
    const [doom] = await voiceOf(bob);
    assert.equal(doom?.name, "playing-doom");
    assert.equal(doom?.locked, true);
    assert.deepEqual(await voiceOf(kid), []);
    playing = [];
    await check();

    // kiddo's LootDen profile is a kid profile, so what they play is kid-safe: open to all.
    const kidGw = await listen(s, kid);
    playing = [
      [4, "Minecraft"],
      [2, "Minecraft"],
    ];
    await check();
    const [mc] = await voiceOf(kid);
    assert.equal(mc?.name, "playing-minecraft");
    assert.equal(mc?.locked, false);
    assert.deepEqual((await kidGw.waitFor("play.together")).invite.userIds.sort(), [bobId, kidId].sort());
    kidGw.ws.close();
    playing = [];
    await check();
  });
});
