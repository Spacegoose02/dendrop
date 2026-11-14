import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Activity, ChatServer, LootdenStatus, Me, Message, NewWebhook, ScheduledEvent, ServerInvite, Webhook } from "@dendrop/shared";
import type { LootdenFetch } from "../src/lootden.js";
import { webhookPost } from "../src/routes/webhooks.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

type Call = (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => Promise<{ status: number; body: any }>;

const caller =
  (s: TestServer): Call =>
  async (cookie, method, url, payload) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

describe("webhook posts", () => {
  it("reads Apprise, Discord, Slack and plain text posts", () => {
    assert.deepEqual(webhookPost({ version: "1.0", title: "New game", message: "Hades II is in the library", type: "info" }), {
      text: "New game\nHades II is in the library",
      name: null,
    });
    assert.deepEqual(webhookPost({ title: "LootDen: Deal", body: "50% off" }), { text: "LootDen: Deal\n50% off", name: null });
    assert.deepEqual(webhookPost({ content: "hi", username: "Bot" }), { text: "hi", name: "Bot" });
    assert.deepEqual(webhookPost({ embeds: [{ title: "T", description: "D" }] }), { text: "T\nD", name: null });
    assert.deepEqual(webhookPost({ text: "slack" }), { text: "slack", name: null });
    assert.deepEqual(webhookPost("  plain  "), { text: "plain", name: null });
    assert.deepEqual(webhookPost({ title: "Same", message: "Same" }), { text: "Same", name: null });
    assert.equal(webhookPost({ content: "x".repeat(10_000) }).text.length, 4000);
    assert.throws(() => webhookPost({}), /no text/);
    assert.throws(() => webhookPost(""), /no text/);
  });
});

describe("incoming webhooks", () => {
  let s: TestServer;
  let call: Call;
  let owner: string, bob: string;
  let serverId: number;
  let general: { id: number; conversationId: number };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", DENDROP_PUBLIC_URL: "https://chat.example.net" });
    call = caller(s);
    owner = await account(s, "owner");
    bob = await account(s, "bob");
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    const inv = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(bob, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
  });
  after(() => s.close());

  const hookPath = (url: string) => new URL(url).pathname;

  it("only the owner and admins can make them, and the address is shown once", async () => {
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: "Nope" })).status, 403);
    assert.equal((await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: " " })).status, 400);
    assert.equal((await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: 9999, name: "X" })).status, 404);
    const made = await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: "LootDen" });
    assert.equal(made.status, 200);
    const hook = made.body as NewWebhook;
    assert.match(hook.url, /^https:\/\/chat\.example\.net\/api\/hooks\/\d+\/[\w-]{32}$/);
    const list = (await call(owner, "GET", `/api/servers/${serverId}/webhooks`)).body as Webhook[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "LootDen");
    assert.equal((list[0] as Partial<NewWebhook>).url, undefined);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}/webhooks`)).status, 403);
  });

  it("posts into the channel under its name, without a sign-in", async () => {
    const hook = (await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: "Alerts" })).body as NewWebhook;
    const gw = await listen(s, bob);
    const res = await s.app.inject({
      method: "POST",
      url: hookPath(hook.url),
      payload: { version: "1.0", title: "LootDen: New game", message: "Hades II was added", type: "info" },
    });
    assert.equal(res.statusCode, 204);
    const { message } = await gw.waitFor("message.created");
    gw.ws.close();
    assert.equal(message.body, "LootDen: New game\nHades II was added");
    assert.deepEqual(message.webhook, { id: hook.id, name: "Alerts" });
    const history = (await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[];
    assert.equal(history.at(-1)!.webhook?.name, "Alerts");
    // Form posts and plain text work too.
    const form = await s.app.inject({
      method: "POST",
      url: hookPath(hook.url),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "title=Hi&body=From+a+form",
    });
    assert.equal(form.statusCode, 204);
    const text = await s.app.inject({ method: "POST", url: hookPath(hook.url), headers: { "content-type": "text/plain" }, payload: "plain" });
    assert.equal(text.statusCode, 204);
    const last = (await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[];
    assert.deepEqual(
      last.slice(-2).map((m) => m.body),
      ["Hi\nFrom a form", "plain"],
    );
  });

  it("its maker can't edit its messages, but moderators can delete them", async () => {
    const msgs = (await call(owner, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[];
    const m = msgs.find((x) => x.webhook)!;
    assert.equal((await call(owner, "PATCH", `/api/messages/${m.id}`, { body: "changed" })).status, 403);
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/messages/${m.id}`)).status, 200);
  });

  it("refuses wrong secrets, and a new address retires the old one", async () => {
    const hook = (await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: "Reset me" })).body as NewWebhook;
    const path = hookPath(hook.url);
    const wrong = path.replace(/[^/]+$/, "x".repeat(32));
    assert.equal((await s.app.inject({ method: "POST", url: wrong, payload: { content: "hi" } })).statusCode, 404);
    assert.equal((await s.app.inject({ method: "POST", url: "/api/hooks/999/abc", payload: { content: "hi" } })).statusCode, 404);
    assert.equal((await s.app.inject({ method: "POST", url: path, payload: {} })).statusCode, 400);
    const reset = (await call(owner, "POST", `/api/servers/${serverId}/webhooks/${hook.id}/reset`)).body as NewWebhook;
    assert.notEqual(reset.url, hook.url);
    assert.equal((await s.app.inject({ method: "POST", url: path, payload: { content: "hi" } })).statusCode, 404);
    assert.equal((await s.app.inject({ method: "POST", url: hookPath(reset.url), payload: { content: "hi" } })).statusCode, 204);
    // Renamed, then deleted.
    const renamed = await call(owner, "PATCH", `/api/servers/${serverId}/webhooks/${hook.id}`, { name: "Renamed" });
    assert.equal(renamed.body.name, "Renamed");
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/webhooks/${hook.id}`)).status, 200);
    assert.equal((await s.app.inject({ method: "POST", url: hookPath(reset.url), payload: { content: "hi" } })).statusCode, 404);
  });

  it("limits how often a webhook can post", async () => {
    const hook = (await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: general.id, name: "Chatty" })).body as NewWebhook;
    let status = 0;
    for (let i = 0; i < 31; i++) status = (await s.app.inject({ method: "POST", url: hookPath(hook.url), payload: { content: `n${i}` } })).statusCode;
    assert.equal(status, 429);
  });

  it("goes when its channel does", async () => {
    const ch = (await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "temp" })).body as { id: number };
    const hook = (await call(owner, "POST", `/api/servers/${serverId}/webhooks`, { channelId: ch.id, name: "Temp" })).body as NewWebhook;
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/channels/${ch.id}`)).status, 200);
    assert.equal((await s.app.inject({ method: "POST", url: hookPath(hook.url), payload: { content: "hi" } })).statusCode, 404);
  });
});

describe("LootDen link", () => {
  let s: TestServer;
  let call: Call;
  let admin: string, bob: string, cat: string, kid: string, stranger: string;
  let bobId: number;
  let nowPlaying: object[] = [];
  let lootdenUsers: object[] = [];
  let answer: number = 200;
  const asked: { url: string; auth: string }[] = [];

  const fetchImpl: LootdenFetch = async (url, init) => {
    asked.push({ url, auth: init.headers.authorization! });
    const body = url.endsWith("/api/users") ? lootdenUsers : nowPlaying;
    return { ok: answer < 300, status: answer, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { lootdenFetch: fetchImpl });
    call = caller(s);
    admin = await account(s, "admin");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    kid = await account(s, "kiddo");
    stranger = await account(s, "stranger");
    bobId = s.ctx.users.byUsername("bob")!.id;
    s.ctx.db.prepare("UPDATE users SET email = 'bob@example.net' WHERE username = 'bob'").run();
    // cat is bob's friend; kiddo shares a server with bob; stranger knows nobody.
    assert.equal((await call(bob, "POST", "/api/friends", { username: "cat" })).status, 200);
    assert.equal((await call(cat, "POST", `/api/friends/${bobId}/accept`)).status, 200);
    const sv = (await call(admin, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    for (const who of [bob, kid]) {
      const inv = (await call(admin, "POST", `/api/servers/${sv.id}/invites`, {})).body as ServerInvite;
      assert.equal((await call(who, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    }
    // kiddo is a kid account (linked to admin as parent).
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(s.ctx.users.byUsername("kiddo")!.id, s.ctx.users.byUsername("admin")!.id, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, can_join_servers) VALUES (?, 1)").run(s.ctx.users.byUsername("kiddo")!.id);
    lootdenUsers = [
      { id: 7, username: "robert", displayName: "Bob", email: "BOB@example.net", kidMode: false },
      { id: 8, username: "cat", displayName: "Cat", email: null, kidMode: false },
      { id: 9, username: "nobody", displayName: "Nobody", email: null, kidMode: true },
    ];
  });
  after(() => s.close());

  it("only a super admin can link it, and the token is never sent back", async () => {
    assert.equal((await call(bob, "GET", "/api/admin/lootden")).status, 403);
    assert.equal((await call(bob, "PUT", "/api/admin/lootden", { url: "https://x" })).status, 403);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden", { url: "not a url", token: "t" })).status, 400);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden", { url: "ftp://games.example.net", token: "t" })).status, 400);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden", { url: "https://games.example.net" })).status, 400);
    const res = await call(admin, "PUT", "/api/admin/lootden", { url: "https://games.example.net/", token: "secret-token" });
    assert.equal(res.status, 200);
    const st = res.body as LootdenStatus;
    assert.deepEqual(st.settings, { url: "https://games.example.net", hasToken: true, gameNights: null, screenshots: null });
    assert.equal(JSON.stringify(st).includes("secret-token"), false);
    assert.equal(st.error, null);
    assert.ok(st.lastOkAt);
    assert.deepEqual(asked.at(-1), { url: "https://games.example.net/api/family/now-playing", auth: "Bearer secret-token" });
  });

  it("lines up LootDen profiles with accounts by email, then username", async () => {
    const st = (await call(admin, "GET", "/api/admin/lootden")).body as LootdenStatus;
    assert.deepEqual(
      st.accounts.map((a) => [a.lootden.username, a.user?.username ?? null, a.matchedBy]),
      [
        ["robert", "bob", "email"],
        ["cat", "cat", "username"],
        ["nobody", null, null],
      ],
    );
  });

  it("shows what someone's playing to their friends and server-mates", async () => {
    const catGw = await listen(s, cat);
    nowPlaying = [
      { userId: 7, device: "Den-PC", title: "Stardew Valley", href: "/games/stardew", startedAt: "2026-11-07T12:00:00.000Z" },
      { userId: 9, device: "Kid-PC", title: "Minecraft", href: null, startedAt: "2026-11-07T12:00:00.000Z" },
    ];
    await call(admin, "POST", "/api/admin/lootden/check");
    const e = await catGw.waitFor("activity");
    catGw.ws.close();
    const playing: Activity = { kind: "playing", title: "Stardew Valley", device: "Den-PC", startedAt: "2026-11-07T12:00:00.000Z", url: "https://games.example.net/games/stardew" };
    assert.deepEqual(e, { type: "activity", userId: bobId, activity: playing });
    assert.deepEqual((await call(cat, "GET", "/api/activities")).body, { [bobId]: playing });
    assert.deepEqual((await call(bob, "GET", "/api/activities")).body, { [bobId]: playing });
    assert.deepEqual((await call(stranger, "GET", "/api/activities")).body, {});
    // Kids don't see the names of grown-ups' games.
    assert.deepEqual((await call(kid, "GET", "/api/activities")).body, { [bobId]: { ...playing, title: "a game", url: null } });
  });

  it("respects turning activity sharing off", async () => {
    const catGw = await listen(s, cat);
    const me = (await call(bob, "PATCH", "/api/me", { shareActivity: false })).body as Me;
    assert.equal(me.shareActivity, false);
    assert.deepEqual(await catGw.waitFor("activity"), { type: "activity", userId: bobId, activity: null });
    catGw.ws.close();
    assert.deepEqual((await call(cat, "GET", "/api/activities")).body, {});
    // You still see your own.
    assert.equal(Object.keys((await call(bob, "GET", "/api/activities")).body).length, 1);
    assert.equal((await call(bob, "PATCH", "/api/me", { shareActivity: "no" })).status, 400);
    await call(bob, "PATCH", "/api/me", { shareActivity: true });
    assert.equal(Object.keys((await call(cat, "GET", "/api/activities")).body).length, 1);
  });

  it("clears activity when the game stops, and reports LootDen errors", async () => {
    const catGw = await listen(s, cat);
    nowPlaying = [];
    await call(admin, "POST", "/api/admin/lootden/check");
    assert.deepEqual(await catGw.waitFor("activity"), { type: "activity", userId: bobId, activity: null });
    catGw.ws.close();
    answer = 403;
    const st = (await call(admin, "POST", "/api/admin/lootden/check")).body as LootdenStatus;
    assert.match(st.error!, /admin/);
    answer = 200;
  });

  it("unlinks", async () => {
    const st = (await call(admin, "PUT", "/api/admin/lootden", { url: "" })).body as LootdenStatus;
    assert.deepEqual(st.settings, { url: "", hasToken: false, gameNights: null, screenshots: null });
    assert.deepEqual(st.accounts, []);
  });
});

describe("LootDen game links, game nights, screenshots and kids", () => {
  let s: TestServer;
  let call: Call;
  let admin: string, bob: string, kid: string;
  let serverId: number;
  let general: { id: number; conversationId: number };
  let nights: object[] = [];
  const seats: { path: string; body: string }[] = [];
  let shots: object[] = [];
  const installs: { device: string; body: string }[] = [];
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const games: Record<string, object> = {
    stardew: { id: "stardew", title: "Stardew Valley", coverUrl: "/api/games/stardew/cover?v=1", releaseYear: 2016, genres: ["Farming"], platform: "pc", sizeBytes: 500, kidSafe: true, kind: "game" },
    doom: { id: "doom", title: "DOOM", coverUrl: null, releaseYear: 2016, genres: ["Shooter"], platform: "pc", sizeBytes: 900, kidSafe: false, kind: "game" },
  };

  const reply = (status: number, body: unknown, type = "application/json") => ({
    ok: status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
    },
    headers: new Headers({ "content-type": type }),
  });
  const fetchImpl: LootdenFetch = async (url, init) => {
    const p = new URL(url).pathname;
    if (p === "/api/users")
      return reply(200, [
        { id: 1, username: "admin", displayName: "Admin", email: null, kidMode: false, role: "admin" },
        { id: 2, username: "bob", displayName: "Bob", email: null, kidMode: false, role: "user" },
        { id: 3, username: "kiddo", displayName: "Kiddo", email: null, kidMode: true, role: "user" },
      ]);
    if (p === "/api/family/now-playing") return reply(200, []);
    if (p === "/api/pcs/targets")
      return reply(200, [
        { name: "Den-PC", online: true, lastUser: "Bob", freeBytes: 1 },
        { name: "Office", online: false, lastUser: "Admin", freeBytes: 1 },
      ]);
    let m = /^\/api\/pcs\/([^/]+)\/install$/.exec(p);
    if (m && init.method === "POST") {
      installs.push({ device: decodeURIComponent(m[1]!), body: init.body ?? "" });
      return reply(200, { ok: true });
    }
    m = /^\/api\/games\/([^/]+)(\/cover)?$/.exec(p);
    if (m) {
      const g = games[decodeURIComponent(m[1]!)];
      if (!g) return reply(404, { error: "No such game" });
      return m[2] ? reply(200, PNG, "image/png") : reply(200, g);
    }
    if (p === "/api/game-nights") return reply(200, { upcoming: nights, past: [], timeZone: "America/Chicago" });
    if (/^\/api\/game-nights\/\d+\/players\/\d+$/.test(p) && init.method === "PUT") {
      seats.push({ path: p, body: init.body ?? "" });
      return reply(200, {});
    }
    if (p === "/api/screenshots") return reply(200, shots);
    if (/^\/api\/screenshots\/\d+\/image$/.test(p)) return reply(200, PNG, "image/png");
    return reply(404, { error: "Not found" });
  };

  const check = () => call(admin, "POST", "/api/admin/lootden/check");
  const lastMessages = async (n: number) => ((await call(admin, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[]).slice(-n);

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { lootdenFetch: fetchImpl });
    call = caller(s);
    admin = await account(s, "admin");
    bob = await account(s, "bob");
    kid = await account(s, "kiddo");
    const sv = (await call(admin, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    const inv = (await call(admin, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(bob, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden", { url: "https://games.example.net", token: "t" })).status, 200);
  });
  after(() => s.close());

  it("tells clients where LootDen is, for game links", async () => {
    assert.equal((await call(bob, "GET", "/api/server")).body.lootdenUrl, "https://games.example.net");
  });

  it("shows a game's card and cover, and hides grown-up games from kids", async () => {
    const g = (await call(bob, "GET", "/api/lootden/games/stardew")).body;
    assert.deepEqual(g, {
      id: "stardew",
      title: "Stardew Valley",
      coverUrl: "/api/lootden/games/stardew/cover",
      releaseYear: 2016,
      genres: ["Farming"],
      platform: "pc",
      sizeBytes: 500,
      url: "https://games.example.net/games/stardew",
      canSend: true,
    });
    const cover = await s.app.inject({ method: "GET", url: "/api/lootden/games/stardew/cover", headers: { cookie: bob } });
    assert.equal(cover.headers["content-type"], "image/png");
    assert.deepEqual(cover.rawPayload, PNG);
    assert.equal((await call(bob, "GET", "/api/lootden/games/nope")).status, 404);
    // kiddo's LootDen profile is a kid profile.
    assert.equal((await call(kid, "GET", "/api/lootden/games/doom")).status, 404);
    assert.equal((await call(kid, "GET", "/api/lootden/games/stardew")).status, 200);
  });

  it("sends games to PCs you use (any PC for LootDen admins)", async () => {
    assert.deepEqual(((await call(bob, "GET", "/api/lootden/pcs")).body as { name: string }[]).map((p) => p.name), ["Den-PC"]);
    assert.deepEqual(((await call(admin, "GET", "/api/lootden/pcs")).body as { name: string }[]).map((p) => p.name), ["Den-PC", "Office"]);
    assert.equal((await call(bob, "POST", "/api/lootden/games/stardew/send", { device: "Office" })).status, 403);
    assert.equal((await call(bob, "POST", "/api/lootden/games/stardew/send", { device: "Den-PC" })).status, 200);
    assert.deepEqual(installs.at(-1), { device: "Den-PC", body: JSON.stringify({ gameId: "stardew" }) });
  });

  it("only lets a super admin pick channels in servers they moderate", async () => {
    assert.equal((await call(bob, "PUT", "/api/admin/lootden/channels", { gameNights: { serverId, channelId: general.id } })).status, 403);
    // A server the super admin isn't in.
    s.ctx.users.setCanCreateServers(s.ctx.users.byUsername("bob")!.id, true);
    const bobs = (await call(bob, "POST", "/api/servers", { name: "Bob's" })).body as ChatServer;
    assert.equal((await call(admin, "PUT", "/api/admin/lootden/channels", { gameNights: { serverId: bobs.id, channelId: bobs.channels[0]!.id } })).status, 403);
    assert.equal((await call(admin, "PUT", "/api/admin/lootden/channels", { gameNights: { serverId, channelId: 9999 } })).status, 404);
  });

  it("announces game nights with a voice channel, updates them, and tidies up after", async () => {
    nights = [{ id: 5, title: "Mario Party", date: "2030-11-15", time: "19:00", players: [{ id: 2, name: "Bob" }], game: { id: "mp", title: "Mario Party" }, note: null }];
    const res = await call(admin, "PUT", "/api/admin/lootden/channels", { gameNights: { serverId, channelId: general.id } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.settings.gameNights, { serverId, channelId: general.id });
    let view = (await call(bob, "GET", `/api/servers/${serverId}`)).body as ChatServer;
    const voice = view.channels.find((c) => c.kind === "voice");
    assert.equal(voice?.name, "game-night-mario-party");
    let [m] = await lastMessages(1);
    assert.equal(m!.webhook?.name, "LootDen");
    assert.equal(m!.body, "🎲 Game night: Mario Party\nFri, Nov 15 at 7:00 PM\nPlaying Mario Party\nWith Bob\nVoice: 🔊 game-night-mario-party");
    // A change in LootDen edits the announcement.
    nights = [{ ...nights[0]!, time: "20:30" }];
    await call(admin, "PUT", "/api/admin/lootden/channels", {});
    [m] = await lastMessages(1);
    assert.match(m!.body, /at 8:30 PM/);
    assert.ok(m!.editedAt);
    // It's a server event too, in the household's time zone, with LootDen's players going.
    let events = (await call(bob, "GET", `/api/servers/${serverId}/events`)).body as ScheduledEvent[];
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.name, "🎲 Mario Party");
    assert.equal(ev.channelId, voice!.id);
    assert.equal(ev.startsAt, "2030-11-16T02:30:00.000Z", "8:30 PM in Chicago");
    assert.equal(ev.myRsvp, "going");
    assert.match(ev.description, /Playing Mario Party/);
    // Bob takes his Going back: LootDen takes him off the night.
    assert.equal((await call(bob, "PUT", `/api/events/${ev.id}/rsvp`, { status: null })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seats.at(-1), { path: "/api/game-nights/5/players/2", body: JSON.stringify({ going: false }) });
    // The admin (LootDen profile 1) says Going: LootDen adds them.
    assert.equal((await call(admin, "PUT", `/api/events/${ev.id}/rsvp`, { status: "going" })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seats.at(-1), { path: "/api/game-nights/5/players/1", body: JSON.stringify({ going: true }) });
    // LootDen now says the admin is playing and Bob isn't; the next sync keeps that.
    nights = [{ ...nights[0]!, players: [{ id: 1, name: "Admin" }] }];
    await call(admin, "PUT", "/api/admin/lootden/channels", {});
    events = (await call(bob, "GET", `/api/servers/${serverId}/events`)).body as ScheduledEvent[];
    assert.equal(events.length, 1, "updated, not doubled");
    assert.equal(events[0]!.myRsvp, null);
    assert.deepEqual(events[0]!.goingIds, [s.ctx.users.byUsername("admin")!.id]);
    // Over: the voice channel and the event go.
    nights = [];
    await call(admin, "PUT", "/api/admin/lootden/channels", {});
    view = (await call(bob, "GET", `/api/servers/${serverId}`)).body as ChatServer;
    assert.equal(view.channels.some((c) => c.kind === "voice"), false);
    assert.deepEqual((await call(bob, "GET", `/api/servers/${serverId}/events`)).body, []);
    await call(admin, "PUT", "/api/admin/lootden/channels", { gameNights: null });
  });

  it("shares new screenshots, not the ones already on the wall", async () => {
    shots = [{ id: 10, imageUrl: "/api/screenshots/10/image", by: { id: 2, name: "Bob" }, game: { id: "stardew", title: "Stardew Valley" }, caption: "old" }];
    await call(admin, "PUT", "/api/admin/lootden/channels", { screenshots: { serverId, channelId: general.id } });
    const before = (await lastMessages(1))[0]!.id;
    shots = [
      { id: 12, imageUrl: "/api/screenshots/12/image", by: { id: 2, name: "Bob" }, game: { id: "doom", title: "DOOM" }, caption: null },
      { id: 11, imageUrl: "/api/screenshots/11/image", by: { id: 2, name: "Bob" }, game: { id: "stardew", title: "Stardew Valley" }, caption: "Big harvest" },
      ...shots,
    ];
    await check();
    const posted = (await lastMessages(3)).filter((x) => x.id > before);
    assert.deepEqual(
      posted.map((x) => x.body),
      ["📸 Bob shared a screenshot from Stardew Valley\nBig harvest", "📸 Bob shared a screenshot from DOOM"],
    );
    assert.equal(posted[0]!.attachments[0]!.contentType, "image/png");
    // Nothing twice.
    await check();
    assert.equal((await lastMessages(1))[0]!.id, posted.at(-1)!.id);
  });

  it("shares only kid-safe screenshots where a kid can read them", async () => {
    // kiddo becomes a kid account and joins the server.
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(s.ctx.users.byUsername("kiddo")!.id, s.ctx.users.byUsername("admin")!.id, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, can_join_servers) VALUES (?, 1)").run(s.ctx.users.byUsername("kiddo")!.id);
    const inv = (await call(admin, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(kid, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    const before = (await lastMessages(1))[0]!.id;
    shots = [
      { id: 14, imageUrl: "", by: { id: 1, name: "Admin" }, game: { id: "doom", title: "DOOM" }, caption: null },
      { id: 13, imageUrl: "", by: { id: 1, name: "Admin" }, game: { id: "stardew", title: "Stardew Valley" }, caption: null },
      ...shots,
    ];
    await check();
    const posted = (await lastMessages(3)).filter((x) => x.id > before);
    assert.deepEqual(
      posted.map((x) => x.body),
      ["📸 Admin shared a screenshot from Stardew Valley"],
    );
  });

  it("lists LootDen's kid and admin profiles for setting up kid accounts", async () => {
    const st = (await call(admin, "GET", "/api/admin/lootden")).body as LootdenStatus;
    const byName = Object.fromEntries(st.accounts.map((a) => [a.lootden.username, a]));
    assert.equal(byName.admin!.lootden.admin, true);
    assert.equal(byName.kiddo!.lootden.kid, true);
    assert.equal(byName.kiddo!.userIsKid, true);
    assert.equal(byName.bob!.userIsKid, false);
  });
});
