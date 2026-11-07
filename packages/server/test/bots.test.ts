import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { Bot, ChatServer, Message, NewBotToken, ServerEvent, ServerInvite } from "@dendrop/shared";
import { signEvent } from "../src/bots.js";
import { now } from "../src/db.js";
import { ServerRepo } from "../src/servers.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

describe("bots", () => {
  let s: TestServer;
  let owner: string, bob: string, kid: string;
  let bobId: number;
  let serverId: number;
  let general: { id: number; conversationId: number };
  let secret: { id: number; conversationId: number };
  let bot: Bot;
  let token: string;
  /** What the events address got, and what it answers to clicks. */
  const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
  let answer: unknown = undefined;

  const call = async (cookie: string, method: Method, url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const asBot = async (method: Method, url: string, payload?: object, t = token) => {
    const res = await s.app.inject({ method, url: `/api/bot/v1${url}`, headers: { authorization: `Bot ${t}` }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const botGateway = async (t = token) => {
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`${s.url.replace("http", "ws")}/api/bot/v1/gateway`, { headers: { authorization: `Bot ${t}` } });
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (d) => {
        const e = JSON.parse(String(d)) as ServerEvent;
        events.push(e);
        if (e.type === "ready") resolve();
      });
      ws.once("close", () => reject(new Error("closed")));
      ws.once("error", reject);
    });
    const waitFor = async <T extends ServerEvent["type"]>(type: T, timeout = 2000): Promise<Extract<ServerEvent, { type: T }>> => {
      const start = Date.now();
      for (;;) {
        const i = events.findIndex((e) => e.type === type);
        if (i >= 0) return events.splice(i, 1)[0] as Extract<ServerEvent, { type: T }>;
        if (Date.now() - start > timeout) throw new Error(`no ${type} event`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { ws, events, waitFor };
  };

  before(async () => {
    s = await startServer(
      { DENDROP_SIGNUP: "true" },
      {
        botFetch: async (url, init) => {
          posted.push({ url, headers: init.headers, body: init.body ?? "" });
          const event = JSON.parse(init.body ?? "{}") as ServerEvent;
          const json = event.type === "interaction.created" ? answer : undefined;
          return {
            ok: true,
            status: 200,
            json: async () => json,
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: (n: string) => (n === "content-type" && json !== undefined ? "application/json" : null) },
          };
        },
      },
    );
    owner = await account(s, "owner");
    bob = await account(s, "bob");
    kid = await account(s, "kid");
    bobId = s.ctx.users.byUsername("bob")!.id;
    const kidId = s.ctx.users.byUsername("kid")!.id;
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kidId, s.ctx.users.byUsername("owner")!.id, now());

    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    secret = (await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "grown-ups", locked: true })).body;
    const inv = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(bob, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
  });
  after(() => s.close());

  it("lets grown-ups who run a server make bots, and shows the token once", async () => {
    assert.equal((await call(bob, "POST", "/api/bots", { username: "nope" })).status, 403);
    assert.equal((await call(kid, "POST", "/api/bots", { username: "nope" })).status, 403);
    assert.equal((await call(kid, "GET", "/api/bots")).body.canMake, false);
    assert.equal((await call(owner, "POST", "/api/bots", { username: "bob" })).status, 409);

    const r = await call(owner, "POST", "/api/bots", { username: "denduty", displayName: "Den Duty", description: "Chores" });
    assert.equal(r.status, 200);
    ({ bot, token } = r.body as NewBotToken);
    assert.equal(bot.displayName, "Den Duty");
    assert.equal(bot.readsMessages, false);
    assert.ok(bot.signingSecret);
    assert.match(token, new RegExp(`^${bot.id}\\.`));

    // The token works on the bot API only; a session cookie doesn't count there.
    assert.equal((await asBot("GET", "/me")).body.username, "denduty");
    assert.equal((await asBot("GET", "/me", undefined, `${bot.id}.wrongwrongwrongwrongwrong`)).status, 401);
    assert.equal((await call(owner, "GET", "/api/bot/v1/me")).status, 401);
    const asUser = await s.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bot ${token}` } });
    assert.equal(asUser.statusCode, 401);
    // Bots can't sign in or be friends, so they're never in DMs or encrypted chats.
    assert.equal((await call(bob, "POST", "/api/friends", { username: "denduty" })).status, 400);
    const login = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "denduty", password: "" } });
    assert.notEqual(login.statusCode, 200);
    // Other people don't see it.
    assert.deepEqual((await call(bob, "GET", "/api/bots")).body.bots, []);
  });

  it("joins a server when its owner or an admin adds it, as a member", async () => {
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/bots`, { botId: bot.id })).status, 403);
    const r = await call(owner, "GET", `/api/servers/${serverId}/bots`);
    assert.deepEqual(r.body.addable.map((b: Bot) => b.id), [bot.id]);
    const added = await call(owner, "POST", `/api/servers/${serverId}/bots`, { botId: bot.id });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.bots.map((b: Bot) => b.id), [bot.id]);
    const sv = (await call(bob, "GET", `/api/servers/${serverId}`)).body as ChatServer;
    const member = sv.members.find((m) => m.user.id === bot.id)!;
    assert.equal(member.role, "member");
    assert.equal(member.user.isBot, true);
    // Never an admin or owner.
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/members/${bot.id}`, { role: "admin" })).status, 400);
    assert.equal((await call(owner, "POST", `/api/servers/${serverId}/transfer`, { userId: bot.id })).status, 400);
    // It sees open channels, not locked ones it wasn't picked for.
    const seen = (await asBot("GET", "/servers")).body as ChatServer[];
    assert.deepEqual(seen[0]!.channels.map((c) => c.id), [general.id]);
    assert.equal((await asBot("POST", `/channels/${secret.id}/messages`, { content: "hi" })).status, 404);
    // A role can open a locked channel to it, but never gives it moderator permissions.
    const role = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Helpers", permissions: ["kickMembers", "deleteMessages"] })).body as { id: number };
    await call(owner, "PATCH", `/api/servers/${serverId}/channels/${secret.id}`, { roleIds: [role.id] });
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/members/${bot.id}/roles`, { roleIds: [role.id] })).status, 200);
    assert.deepEqual(new ServerRepo(s.ctx.db, s.ctx.users).permissions(serverId, bot.id), []);
    const withRole = (await asBot("GET", "/servers")).body as ChatServer[];
    assert.deepEqual(withRole[0]!.channels.map((c) => c.id).sort(), [general.id, secret.id].sort());
    await call(owner, "PUT", `/api/servers/${serverId}/members/${bot.id}/roles`, { roleIds: [] });
  });

  it("posts messages with buttons, and checks them", async () => {
    const bobLive = await listen(s, bob);
    const r = await asBot("POST", `/channels/${general.id}/messages`, {
      content: "⏳ Kid finished Dishes",
      buttons: [
        { id: "approve:7", label: "Approve", style: "success" },
        { id: "reject:7", label: "Send back", style: "danger" },
        { url: "https://denduty.example/chores/7", label: "Open" },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body as Message;
    assert.equal(m.authorId, bot.id);
    assert.equal(m.buttons?.length, 3);
    assert.equal(m.buttons?.[1]?.style, "danger");
    assert.equal((await bobLive.waitFor("message.created")).message.buttons?.[0]?.id, "approve:7");
    bobLive.ws.close();

    for (const buttons of [
      [{ label: "No id" }],
      [{ id: "a", label: "" }],
      [{ id: "a", label: "x", style: "rainbow" }],
      [{ id: "a b", label: "x" }],
      [{ id: "a", label: "x" }, { id: "a", label: "y" }],
      [{ url: "javascript:alert(1)", label: "x" }],
      Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, label: "x" })),
    ]) {
      assert.equal((await asBot("POST", `/channels/${general.id}/messages`, { content: "x", buttons })).status, 400, JSON.stringify(buttons));
    }
    // Edits change text and buttons; null takes the buttons away.
    const e = await asBot("PATCH", `/messages/${m.id}`, { content: "✅ Approved", buttons: null });
    assert.equal(e.body.body, "✅ Approved");
    assert.equal(e.body.buttons, null);
    // Not someone else's message.
    const bobs = (await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "mine" })).body as Message;
    assert.equal((await asBot("PATCH", `/messages/${bobs.id}`, { content: "hacked" })).status, 404);
    assert.equal((await asBot("DELETE", `/messages/${bobs.id}`)).status, 404);
  });

  it("only reads other people's messages when its owner turns that on", async () => {
    const gw = await botGateway();
    await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "private-ish" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gw.events.filter((e) => e.type === "message.created").length, 0);
    assert.equal((await asBot("GET", `/channels/${general.id}/messages`)).status, 403);

    assert.equal((await call(bob, "PATCH", `/api/bots/${bot.id}`, { readsMessages: true })).status, 404);
    assert.equal((await call(owner, "PATCH", `/api/bots/${bot.id}`, { readsMessages: true })).body.readsMessages, true);
    await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "hello bot" });
    assert.equal((await gw.waitFor("message.created")).message.body, "hello bot");
    const history = (await asBot("GET", `/channels/${general.id}/messages`)).body as Message[];
    assert.equal(history.at(-1)!.body, "hello bot");
    // Typing and presence aren't for bots.
    assert.ok(gw.events.every((e) => ["ready", "message.created", "message.updated", "server.updated", "server.removed", "interaction.created"].includes(e.type)));
    gw.ws.close();
    await call(owner, "PATCH", `/api/bots/${bot.id}`, { readsMessages: false });
  });

  it("tells the bot about clicks over its gateway, and sends its reply to the clicker only", async () => {
    const m = (await asBot("POST", `/channels/${general.id}/messages`, { content: "Pick", buttons: [{ id: "yes", label: "Yes" }, { id: "off", label: "Off", disabled: true }] }))
      .body as Message;
    // Nobody's listening yet (once the last test's connection has closed).
    for (let i = 0; i < 100 && s.ctx.bots.online(bot.id); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await call(bob, "POST", `/api/messages/${m.id}/buttons/yes`)).status, 503);

    const gw = await botGateway();
    const bobLive = await listen(s, bob);
    const ownerLive = await listen(s, owner);
    assert.equal((await call(bob, "POST", `/api/messages/${m.id}/buttons/nope`)).status, 404);
    assert.equal((await call(bob, "POST", `/api/messages/${m.id}/buttons/off`)).status, 409);
    const click = await call(bob, "POST", `/api/messages/${m.id}/buttons/yes`);
    assert.equal(click.status, 200);
    assert.equal(click.body.reply, null);
    const { interaction } = await gw.waitFor("interaction.created");
    assert.equal(interaction.user.id, bobId);
    assert.equal(interaction.role, "member");
    assert.equal(interaction.buttonId, "yes");
    assert.equal(interaction.channelId, general.id);

    assert.equal((await asBot("POST", `/interactions/${interaction.id}/reply`, { content: "Got it, Bob" })).status, 200);
    assert.equal((await bobLive.waitFor("interaction.reply")).content, "Got it, Bob");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!ownerLive.events.some((e) => e.type === "interaction.reply"));
    assert.equal((await asBot("POST", `/interactions/${interaction.id}/reply`, { content: "again" })).status, 409);
    gw.ws.close();
    bobLive.ws.close();
    ownerLive.ws.close();
  });

  it("POSTs signed events to its events address and uses the answer to a click", async () => {
    await call(owner, "PATCH", `/api/bots/${bot.id}`, { eventsUrl: "https://bot.example/events" });
    const secretKey = (await call(owner, "GET", "/api/bots")).body.bots[0].signingSecret as string;
    posted.length = 0;
    const m = (await asBot("POST", `/channels/${general.id}/messages`, { content: "Approve?", buttons: [{ id: "approve", label: "Approve", style: "success" }] }))
      .body as Message;
    await new Promise((r) => setTimeout(r, 50));
    const created = posted.find((p) => p.headers["x-dendrop-event"] === "message.created")!;
    assert.ok(created);
    assert.equal(created.headers["x-dendrop-signature"], signEvent(secretKey, created.headers["x-dendrop-timestamp"]!, created.body));

    answer = { reply: "Approved ✅", update: { content: "✅ Approved by Bob", buttons: [] } };
    const bobLive = await listen(s, bob);
    const click = await call(bob, "POST", `/api/messages/${m.id}/buttons/approve`);
    assert.equal(click.status, 200);
    assert.equal(click.body.reply, "Approved ✅");
    const updated = (await bobLive.waitFor("message.updated")).message;
    assert.equal(updated.body, "✅ Approved by Bob");
    assert.equal(updated.buttons, null);
    bobLive.ws.close();
    await call(owner, "PATCH", `/api/bots/${bot.id}`, { eventsUrl: null });
  });

  it("goes through automod like everyone else", async () => {
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { words: { enabled: true, words: ["pineapple"], actions: ["block"], exemptRoles: [] } });
    assert.equal((await asBot("POST", `/channels/${general.id}/messages`, { content: "pineapple pizza" })).status, 400);
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { words: { enabled: false } });
  });

  it("stops working with an old token, and leaves every server when deleted", async () => {
    const old = token;
    const gw = await botGateway();
    const closed = new Promise<number>((r) => gw.ws.once("close", (code) => r(code)));
    token = ((await call(owner, "POST", `/api/bots/${bot.id}/token`)).body as NewBotToken).token;
    assert.equal(await closed, 4401);
    assert.equal((await asBot("GET", "/me", undefined, old)).status, 401);
    assert.equal((await asBot("GET", "/me")).status, 200);

    const before = (await asBot("POST", `/channels/${general.id}/messages`, { content: "bye" })).body as Message;
    assert.equal((await call(owner, "DELETE", `/api/bots/${bot.id}`)).status, 200);
    assert.equal((await asBot("GET", "/me")).status, 401);
    const sv = (await call(owner, "GET", `/api/servers/${serverId}`)).body as ChatServer;
    assert.ok(!sv.members.some((m) => m.user.id === bot.id));
    // Its messages stay.
    const history = (await call(owner, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[];
    assert.equal(history.find((x) => x.id === before.id)?.body, "bye");
  });
});
