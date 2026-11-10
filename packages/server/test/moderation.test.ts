import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Channel, ChatServer, CustomRole, VoiceChannelState } from "@dendrop/shared";
import { DatabaseSync } from "node:sqlite";
import { migrate, MIGRATIONS } from "../src/db.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("categories, slowmode, read-only channels, finer permissions and voice moderation", () => {
  let s: TestServer;
  let owner: string, mod: string, ann: string, bob: string;
  let modId: number, annId: number, bobId: number;
  let sid: number;
  let general: Channel;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const view = async (cookie: string) => (await call(cookie, "GET", `/api/servers/${sid}`)).body as ChatServer;
  const say = (cookie: string, c: Channel, body: string) => call(cookie, "POST", `/api/conversations/${c.conversationId}/messages`, { body });
  const role = async (name: string, permissions: string[], who: number[]) => {
    const r = (await call(owner, "POST", `/api/servers/${sid}/roles`, { name, permissions })).body as CustomRole;
    for (const u of who) {
      const has = (await view(owner)).members.find((m) => m.user.id === u)!.roleIds;
      await call(owner, "PUT", `/api/servers/${sid}/members/${u}/roles`, { roleIds: [...has, r.id] });
    }
    return r;
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK });
    owner = await account(s, "owner");
    mod = await account(s, "mod");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    [modId, annId, bobId] = ["mod", "ann", "bob"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    sid = sv.id;
    general = sv.channels[0]!;
    for (const c of [mod, ann, bob]) await call(c, "POST", `/api/servers/${sid}/join`);
  });
  after(() => s.close());

  it("groups channels under categories, which only channel managers change", async () => {
    assert.equal((await call(ann, "POST", `/api/servers/${sid}/categories`, { name: "Games" })).status, 403);
    const games = (await call(owner, "POST", `/api/servers/${sid}/categories`, { name: " Games " })).body;
    const grown = (await call(owner, "POST", `/api/servers/${sid}/categories`, { name: "Grown-ups" })).body;
    assert.equal(games.name, "Games");
    const mc = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "minecraft", categoryId: games.id })).body as Channel;
    assert.equal(mc.categoryId, games.id);
    assert.equal((await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "x", categoryId: 999 })).status, 400);
    await call(owner, "PUT", `/api/servers/${sid}/categories/order`, { ids: [grown.id, games.id] });
    await call(owner, "PATCH", `/api/servers/${sid}/categories/${games.id}`, { name: "Gaming" });
    let sv = await view(ann);
    assert.deepEqual(
      sv.categories.map((c) => c.name),
      ["Grown-ups", "Gaming"],
    );
    // Deleting a category keeps its channels.
    await call(owner, "DELETE", `/api/servers/${sid}/categories/${games.id}`);
    sv = await view(ann);
    assert.equal(sv.channels.find((c) => c.name === "minecraft")!.categoryId, null);
    assert.deepEqual(
      sv.categories.map((c) => c.name),
      ["Grown-ups"],
    );
  });

  it("slowmode makes people wait between messages, but not moderators", async () => {
    assert.equal((await call(owner, "PATCH", `/api/servers/${sid}/channels/${general.id}`, { slowmode: 99999 })).status, 400);
    await call(owner, "PATCH", `/api/servers/${sid}/channels/${general.id}`, { slowmode: 30 });
    assert.equal((await view(ann)).channels[0]!.slowmode, 30);
    assert.equal((await say(ann, general, "one")).status, 200);
    const again = await say(ann, general, "two");
    assert.equal(again.status, 429);
    assert.match(again.body.error, /Slowmode is on: you can post again in \d+ seconds/);
    assert.equal((await say(bob, general, "bob's first")).status, 200);
    assert.equal((await say(owner, general, "a")).status, 200);
    assert.equal((await say(owner, general, "b")).status, 200);
    await call(owner, "PATCH", `/api/servers/${sid}/channels/${general.id}`, { slowmode: 0 });
    assert.equal((await say(ann, general, "two")).status, 200);
  });

  it("read-only channels let only picked roles post, and everyone read", async () => {
    const news = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "news", readOnly: true })).body as Channel;
    assert.equal(news.readOnly, true);
    assert.equal((await say(ann, news, "hi")).status, 403);
    assert.equal((await view(ann)).channels.find((c) => c.id === news.id)!.canPost, false);
    const writers = await role("Writers", [], [annId]);
    await call(owner, "PATCH", `/api/servers/${sid}/channels/${news.id}`, { postRoleIds: [writers.id] });
    assert.equal((await view(ann)).channels.find((c) => c.id === news.id)!.canPost, true);
    assert.equal((await say(ann, news, "big news")).status, 200);
    assert.equal((await say(bob, news, "me too")).status, 403);
    // Bob still reads it.
    assert.equal((await call(bob, "GET", `/api/conversations/${news.conversationId}/messages`)).body.length, 1);
    // Who can post is only shown to people who manage channels.
    assert.deepEqual((await view(bob)).channels.find((c) => c.id === news.id)!.postRoleIds, []);
    assert.deepEqual((await view(owner)).channels.find((c) => c.id === news.id)!.postRoleIds, [writers.id]);
  });

  it("splits remove from ban, and adds nicknames, webhooks and the audit log as their own permissions", async () => {
    await role("Bouncers", ["kickMembers", "manageNicknames", "manageWebhooks", "viewAuditLog"], [modId]);
    // Remove, but not ban.
    assert.equal((await call(mod, "DELETE", `/api/servers/${sid}/members/${bobId}?ban=true`)).status, 403);
    assert.equal((await call(mod, "GET", `/api/servers/${sid}/bans`)).status, 403);
    // Nicknames of people ranked below.
    assert.equal((await call(mod, "PATCH", `/api/servers/${sid}/members/${bobId}/nickname`, { nickname: "Bobby" })).status, 200);
    assert.equal((await view(owner)).members.find((m) => m.user.id === bobId)!.nickname, "Bobby");
    assert.equal((await call(ann, "PATCH", `/api/servers/${sid}/members/${bobId}/nickname`, { nickname: "x" })).status, 403);
    // Webhooks, which used to be owner and admins only.
    assert.equal((await call(mod, "POST", `/api/servers/${sid}/webhooks`, { name: "Alerts", channelId: general.id })).status, 200);
    assert.equal((await call(ann, "GET", `/api/servers/${sid}/webhooks`)).status, 403);
    // The audit log, which now shows the nickname change.
    const log = (await call(mod, "GET", `/api/servers/${sid}/audit`)).body as { action: string }[];
    assert.ok(log.some((e) => e.action === "member.nickname"));
    assert.equal((await call(ann, "GET", `/api/servers/${sid}/audit`)).status, 403);
  });

  it("moderators mute, deafen, move and disconnect people in voice", async () => {
    const lounge = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "lounge", kind: "voice" })).body as Channel;
    const games = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "games", kind: "voice" })).body as Channel;
    await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    await role("Voice mods", ["muteMembers", "moveMembers"], [modId]);

    assert.equal((await call(ann, "PUT", `/api/servers/${sid}/voice/${bobId}`, { serverMuted: true })).status, 403);
    const muted = (await call(mod, "PUT", `/api/servers/${sid}/voice/${bobId}`, { serverMuted: true })).body as VoiceChannelState;
    const bobState = () => muted.members.find((m) => m.userId === bobId)!;
    assert.equal(bobState().serverMuted, true);
    assert.equal(bobState().muted, true);
    // Bob can't unmute himself, even after leaving and coming back.
    const tried = (await call(bob, "POST", "/api/voice/state", { muted: false })).body as VoiceChannelState;
    assert.equal(tried.members.find((m) => m.userId === bobId)!.muted, true);
    await call(bob, "POST", "/api/voice/leave", {});
    const back = (await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`)).body.voice as VoiceChannelState;
    assert.equal(back.members.find((m) => m.userId === bobId)!.serverMuted, true);
    const freed = (await call(mod, "PUT", `/api/servers/${sid}/voice/${bobId}`, { serverMuted: false, serverDeafened: true })).body as VoiceChannelState;
    assert.equal(freed.members.find((m) => m.userId === bobId)!.deafened, true);
    await call(mod, "PUT", `/api/servers/${sid}/voice/${bobId}`, { serverDeafened: false });
    assert.equal(((await call(bob, "POST", "/api/voice/state", { muted: false, deafened: false })).body as VoiceChannelState).members[0]!.muted, false);

    // Moving tells Bob's app where to go.
    const bobLive = await listen(s, bob);
    assert.equal((await call(mod, "POST", `/api/servers/${sid}/voice/${bobId}/move`, { channelId: general.id })).status, 404);
    assert.equal((await call(mod, "POST", `/api/servers/${sid}/voice/${bobId}/move`, { channelId: games.id })).status, 200);
    assert.equal((await bobLive.waitFor("voice.move")).channelId, games.id);

    // Disconnecting takes him out, and his app hears it.
    assert.equal((await call(mod, "POST", `/api/servers/${sid}/voice/${bobId}/disconnect`)).status, 200);
    const out = await bobLive.waitFor("voice.updated");
    assert.ok(!out.voice.members.some((m) => m.userId === bobId));
    bobLive.ws.close();
    assert.deepEqual((await call(bob, "GET", "/api/voice")).body, []);
    assert.equal((await call(mod, "POST", `/api/servers/${sid}/voice/${bobId}/disconnect`)).status, 404);
    // Nobody can moderate the owner.
    await call(owner, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    assert.equal((await call(mod, "PUT", `/api/servers/${sid}/voice/${s.ctx.users.byUsername("owner")!.id}`, { serverMuted: true })).status, 403);
  });

  it("roles that could remove people keep being able to ban after upgrading", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const step = MIGRATIONS.findIndex((m) => m.includes("server_categories"));
    for (const m of MIGRATIONS.slice(0, step)) db.exec(m);
    const t = new Date().toISOString();
    db.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (1, 'o', 'o', ?)").run(t);
    db.prepare("INSERT INTO servers (id, name, owner_id, created_at) VALUES (1, 'S', 1, ?)").run(t);
    db.prepare("INSERT INTO server_roles (server_id, name, position, permissions, created_at) VALUES (1, 'Mods', 0, '[\"kickMembers\"]', ?), (1, 'Fans', 1, '[]', ?)").run(t, t);
    db.exec(`PRAGMA user_version = ${step}`);
    migrate(db);
    const perms = (db.prepare("SELECT permissions FROM server_roles ORDER BY position").all() as { permissions: string }[]).map((r) => JSON.parse(r.permissions));
    assert.deepEqual(perms, [["kickMembers", "banMembers"], []]);
    db.close();
  });
});
