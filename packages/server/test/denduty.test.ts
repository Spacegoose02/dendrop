import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ChatServer, DendutyStatus, Message, ServerInvite } from "@dendrop/shared";
import { chatPauseText, eventText, type DendutyEvent, type DendutyFetch } from "../src/denduty.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

type Call = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) => Promise<{ status: number; body: any }>;

const words = { icon: "✨", name: "Shinies", timezone: "America/New_York" };
const ev = (event: string, fields: Record<string, unknown> = {}): DendutyEvent => ({ id: 1, event, kid: "Ava", kid_id: "k1", at: "2026-11-07T12:00:00Z", ...fields });

describe("Den Duty event wording", () => {
  it("puts cheerful things in the family channel", () => {
    assert.deepEqual(eventText(ev("chore_approved", { chore: "Make bed", icon: "🛏️", points: 2 }), words), { to: "family", text: "✅ Ava finished 🛏️ Make bed (+2 ✨)" });
    assert.deepEqual(eventText(ev("chore_approved", { chore: "Brush teeth", points: 0 }), words), { to: "family", text: "✅ Ava finished Brush teeth" });
    assert.equal(eventText(ev("team_goal_reached", { kid: null, goal: "Zoo trip", reward: "🦁 Zoo" }), words)!.text, "🏆 Family goal reached: Zoo trip!\nReward: 🦁 Zoo");
    assert.deepEqual(eventText(ev("points_changed", { amount: 3, kind: "bonus", reason: "Helped someone" }), words), { to: "family", text: "🌟 Ava got +3 ✨: Helped someone" });
  });

  it("keeps grown-up things for the parents channel, and leaves Doctors out", () => {
    assert.deepEqual(eventText(ev("chore_submitted", { chore: "Dishes", late: true }), words), { to: "parents", text: "⏳ Ava finished Dishes (late), waiting for a grown-up to check" });
    assert.deepEqual(eventText(ev("points_changed", { amount: -5, kind: "adjust", reason: "Hitting" }), words), { to: "parents", text: "➖ Ava: −5 ✨ (Hitting)" });
    assert.equal(eventText(ev("helpdesk_requested", { request: "Homework: math", due_date: "2026-11-09" }), words)!.to, "parents");
    assert.match(eventText(ev("timeout_started", { what: "No Roblox", ends_at: "2026-11-08T23:00:00Z" }), words)!.text, /^⏸️ Time-out for Ava: No Roblox until Sun 6:00 PM$/);
    for (const quiet of ["practice_waiting", "med_refill_due", "reward_refunded", "reminder_done", "helpdesk_answered", "something_new"]) assert.equal(eventText(ev(quiet), words), null);
    assert.equal(eventText(ev("points_changed", { amount: -2, kind: "reversal" }), words), null);
  });
});

describe("Den Duty chat pauses", () => {
  const at = Date.parse("2026-11-07T12:00:00Z");
  const soon = "2026-11-07T23:00:00Z";
  const chores = { due: 4, done: 1, left: 3 };
  it("pauses chat the whole time-out, kindly, with when it's back", () => {
    assert.equal(
      chatPauseText([{ what: "No chatting", chat: "all", endsAt: soon }], chores, false, "America/New_York", at),
      "Chat is taking a break for your Den Duty time-out (No chatting) until Sat 6:00 PM. You've got this! 💛",
    );
    // Over between checks: chat opens again.
    assert.equal(chatPauseText([{ what: "x", chat: "all", endsAt: "2026-11-07T11:59:00Z" }], null, false, "UTC", at), null);
  });
  it("holds chat until today's chores are done, from a time-out or the chores-first rule", () => {
    const left = "Chat opens once today's chores are done: 3 to go in Den Duty. You can do it! 🧹";
    assert.equal(chatPauseText([{ what: "Chores first", chat: "chores", endsAt: soon }], chores, false, "UTC", at), left);
    assert.equal(chatPauseText([], chores, true, "UTC", at), left);
    assert.equal(chatPauseText([], chores, false, "UTC", at), null);
    assert.equal(chatPauseText([], { due: 4, done: 4, left: 0 }, true, "UTC", at), null);
    // No chores today, or Den Duty out of touch: nothing to wait for.
    assert.equal(chatPauseText([{ what: "Chores first", chat: "chores", endsAt: soon }], null, true, "UTC", at), null);
  });
});

describe("Den Duty link", () => {
  let s: TestServer;
  let call: Call;
  let admin: string, mom: string, ava: string, stranger: string;
  let avaId: number;
  let family: { id: number; conversationId: number };
  let parents: { id: number; conversationId: number };
  let serverId: number;
  let kids: object[] = [];
  let events: DendutyEvent[] = [];
  let answer = 200;
  const asked: { url: string; auth: string }[] = [];
  const posted: { url: string; body: unknown }[] = [];

  const fetchImpl: DendutyFetch = async (url, init) => {
    if (init.method === "POST") {
      posted.push({ url, body: JSON.parse(init.body ?? "null") });
      return { ok: answer < 300, status: answer, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
    }
    asked.push({ url, auth: init.headers.authorization! });
    const u = new URL(url);
    const body = u.pathname.endsWith("/gaming")
      ? { today: "2026-11-07", timezone: "America/New_York", pointsName: "Shinies", pointsIcon: "✨", kids, familyGoalsReached: [] }
      : events.filter((e) => e.id > Number(u.searchParams.get("after") ?? 0)).sort((a, b) => b.id - a.id);
    return { ok: answer < 300, status: answer, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
  };

  const caller =
    (t: TestServer): Call =>
    async (cookie, method, url, payload) => {
      const res = await t.app.inject({ method, url, headers: { cookie }, payload });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    };

  const messages = async (conversationId: number) => ((await call(admin, "GET", `/api/conversations/${conversationId}/messages`)).body as Message[]).filter((m) => m.webhook?.name === "Den Duty");

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { dendutyFetch: fetchImpl });
    call = caller(s);
    admin = await account(s, "admin");
    mom = await account(s, "mom");
    ava = await account(s, "ava");
    stranger = await account(s, "stranger");
    avaId = s.ctx.users.byUsername("ava")!.id;
    const momId = s.ctx.users.byUsername("mom")!.id;
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(avaId, momId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, can_join_servers) VALUES (?, 1)").run(avaId);
    const sv = (await call(admin, "POST", "/api/servers", { name: "Family" })).body as ChatServer;
    serverId = sv.id;
    family = sv.channels[0]!;
    for (const who of [mom, ava]) {
      const inv = (await call(admin, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
      assert.equal((await call(who, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    }
    // A locked channel only the grown-ups are in.
    const made = await call(admin, "POST", `/api/servers/${serverId}/channels`, { name: "parents", locked: true, memberIds: [momId] });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    parents = made.body;
    kids = [
      { id: "k1", name: "Ava", chores: { due: 5, done: 3, left: 2 }, locks: [], gameTime: [] },
      { id: "k2", name: "Max", chores: null, locks: [], gameTime: [] },
    ];
    events = [{ id: 10, event: "chore_approved", kid: "Ava", kid_id: "k1", chore: "Old news", points: 1, at: "2026-11-06T12:00:00Z" }];
  });
  after(() => s.close());

  it("only a super admin can link it, and the token is never sent back", async () => {
    assert.equal((await call(mom, "GET", "/api/admin/denduty")).status, 403);
    assert.equal((await call(mom, "PUT", "/api/admin/denduty", { url: "https://x" })).status, 403);
    assert.equal((await call(admin, "PUT", "/api/admin/denduty", { url: "nope", homeId: "h1", token: "t" })).status, 400);
    assert.equal((await call(admin, "PUT", "/api/admin/denduty", { url: "https://chores.example.net", token: "t" })).status, 400);
    assert.equal((await call(admin, "PUT", "/api/admin/denduty", { url: "https://chores.example.net", homeId: "h1" })).status, 400);
    const res = await call(admin, "PUT", "/api/admin/denduty", { url: "https://chores.example.net/", homeId: "h1", token: "dnk_secret" });
    assert.equal(res.status, 200);
    const st = res.body as DendutyStatus;
    assert.deepEqual(st.settings, { url: "https://chores.example.net", homeId: "h1", hasToken: true, family: null, parents: null });
    assert.equal(JSON.stringify(st).includes("dnk_secret"), false);
    assert.equal(st.error, null);
    assert.deepEqual(asked.at(-1), { url: "https://chores.example.net/api/v1/homes/h1/events?after=0", auth: "Bearer dnk_secret" });
  });

  it("matches Den Duty kids to kid accounts by name, or as picked", async () => {
    let st = (await call(admin, "GET", "/api/admin/denduty")).body as DendutyStatus;
    assert.deepEqual(st.kids.map((k) => [k.denduty.name, k.user?.username ?? null, k.matchedBy]), [["Ava", "ava", "name"], ["Max", null, null]]);
    assert.deepEqual(st.kidAccounts.map((u) => u.username), ["ava"]);
    // Only kid accounts can be picked.
    assert.equal((await call(admin, "PUT", "/api/admin/denduty/kids", { kidId: "k2", userId: s.ctx.users.byUsername("stranger")!.id })).status, 400);
    st = (await call(admin, "PUT", "/api/admin/denduty/kids", { kidId: "k1", userId: null })).body as DendutyStatus;
    assert.deepEqual([st.kids[0]!.user, st.kids[0]!.matchedBy], [null, "picked"]);
    st = (await call(admin, "PUT", "/api/admin/denduty/kids", { kidId: "k1", userId: avaId })).body as DendutyStatus;
    assert.equal(st.kids[0]!.matchedBy, "picked");
  });

  it("shows a kid's chores to the kid and their parents only", async () => {
    const chores = { due: 5, done: 3, left: 2 };
    assert.deepEqual((await call(ava, "GET", "/api/chores")).body, { [avaId]: chores });
    assert.deepEqual((await call(mom, "GET", "/api/chores")).body, { [avaId]: chores });
    assert.deepEqual((await call(stranger, "GET", "/api/chores")).body, {});
    assert.deepEqual((await call(admin, "GET", "/api/chores")).body, {});
    const gw = await listen(s, mom);
    kids = [{ id: "k1", name: "Ava", chores: { due: 5, done: 5, left: 0 } }];
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.deepEqual(await gw.waitFor("chores"), { type: "chores", userId: avaId, chores: { due: 5, done: 5, left: 0 } });
    gw.ws.close();
  });

  it("only lets the parents channel be one no kid can read", async () => {
    assert.equal((await call(admin, "PUT", "/api/admin/denduty/channels", { parents: { serverId, channelId: family.id } })).status, 400);
    assert.equal((await call(mom, "PUT", "/api/admin/denduty/channels", { family: { serverId, channelId: family.id } })).status, 403);
    const st = (await call(admin, "PUT", "/api/admin/denduty/channels", { family: { serverId, channelId: family.id }, parents: { serverId, channelId: parents.id } })).body as DendutyStatus;
    assert.deepEqual(st.settings.parents, { serverId, channelId: parents.id });
  });

  it("posts new events as Den Duty, not the ones from before linking", async () => {
    assert.deepEqual(await messages(family.conversationId), []);
    events.push(
      { id: 11, event: "chore_submitted", kid: "Ava", kid_id: "k1", chore: "Dishes", at: "2026-11-07T12:00:00Z" },
      { id: 12, event: "chore_approved", kid: "Ava", kid_id: "k1", chore: "Dishes", points: 2, at: "2026-11-07T12:01:00Z" },
      { id: 13, event: "med_refill_due", kid: "Ava", kid_id: "k1", doses_left: 3, at: "2026-11-07T12:02:00Z" },
    );
    const gw = await listen(s, ava);
    await call(admin, "POST", "/api/admin/denduty/check");
    const { message } = await gw.waitFor("message.created");
    gw.ws.close();
    assert.equal(message.body, "✅ Ava finished Dishes (+2 ✨)");
    assert.deepEqual((await messages(family.conversationId)).map((m) => m.body), ["✅ Ava finished Dishes (+2 ✨)"]);
    assert.deepEqual((await messages(parents.conversationId)).map((m) => m.body), ["⏳ Ava finished Dishes, waiting for a grown-up to check"]);
    // Nothing twice.
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.equal((await messages(family.conversationId)).length, 1);
    assert.equal((await messages(parents.conversationId)).length, 1);
  });

  it("lets grown-ups approve or send back a chore from the parents channel", async () => {
    events.push(
      { id: 14, event: "chore_submitted", kid: "Ava", kid_id: "k1", chore: "Bed", instance_id: "inst-1", at: "2026-11-07T12:05:00Z" },
      { id: 15, event: "chore_submitted", kid: "Ava", kid_id: "k1", chore: "Bins", instance_id: "inst-2", at: "2026-11-07T12:06:00Z" },
    );
    await call(admin, "POST", "/api/admin/denduty/check");
    const [, bed, bins] = await messages(parents.conversationId);
    assert.deepEqual(bed!.buttons, [
      { id: "dd.approve.inst-1", label: "Approve", style: "success" },
      { id: "dd.reject.inst-1", label: "Send back", style: "danger" },
    ]);
    // Not in the channel: nothing to click.
    assert.equal((await call(ava, "POST", `/api/messages/${bed!.id}/buttons/dd.approve.inst-1`, {})).status, 404);
    // A read-only token says so.
    answer = 403;
    const ro = await call(mom, "POST", `/api/messages/${bed!.id}/buttons/dd.approve.inst-1`, {});
    assert.equal(ro.status, 403);
    assert.match(ro.body.error, /control token/);
    answer = 200;
    const gw = await listen(s, mom);
    assert.deepEqual((await call(mom, "POST", `/api/messages/${bed!.id}/buttons/dd.approve.inst-1`, {})).body, { reply: null });
    assert.deepEqual(posted.at(-1), { url: "https://chores.example.net/api/v1/homes/h1/instances/inst-1/approve", body: {} });
    const { message } = await gw.waitFor("message.updated");
    gw.ws.close();
    assert.deepEqual(message.buttons, [{ id: "dd.done", label: "Approved by mom", style: "success", disabled: true }]);
    assert.equal((await call(mom, "POST", `/api/messages/${bed!.id}/buttons/dd.done`, {})).status, 409);
    // Sending back carries a note; someone beating you to it in Den Duty just clears the buttons.
    answer = 409;
    assert.deepEqual((await call(mom, "POST", `/api/messages/${bins!.id}/buttons/dd.reject.inst-2`, {})).body, { reply: "Someone already checked that chore in Den Duty." });
    assert.deepEqual(posted.at(-1), { url: "https://chores.example.net/api/v1/homes/h1/instances/inst-2/reject", body: { note: "Sent back by mom from Dendrop" } });
    assert.equal((await messages(parents.conversationId)).at(-1)!.buttons![0]!.label, "Already checked in Den Duty");
    answer = 200;
  });

  it("stops posting grown-up things once a kid can read the parents channel", async () => {
    const PATCH = (await s.app.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}/channels/${parents.id}`,
      headers: { cookie: admin },
      payload: { memberIds: [s.ctx.users.byUsername("mom")!.id, avaId] },
    })).statusCode;
    assert.equal(PATCH, 200);
    events.push({ id: 16, event: "helpdesk_requested", kid: "Ava", kid_id: "k1", request: "A ride", at: "2026-11-07T12:03:00Z" });
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.equal((await messages(parents.conversationId)).length, 3);
  });

  it("pauses a kid's chat for a time-out or chores first, and opens it again", async () => {
    const send = () => call(ava, "POST", `/api/conversations/${family.conversationId}/messages`, { body: "hi" });
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    kids = [{ id: "k1", name: "Ava", chores: { due: 5, done: 3, left: 2 }, chatLocks: [{ id: "t1", what: "No chatting", chat: "all", endsAt }] }];
    const gw = await listen(s, ava);
    await call(admin, "POST", "/api/admin/denduty/check");
    const { family: pushed } = await gw.waitFor("family.updated");
    assert.equal(pushed.status!.allowedNow, false);
    assert.match(pushed.status!.reason!, /^Chat is taking a break for your Den Duty time-out \(No chatting\) until .+\. You've got this! 💛$/);
    const blocked = await send();
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /Den Duty time-out/);
    // The admin page says why too; grown-ups aren't held back.
    const st = (await call(admin, "GET", "/api/admin/denduty")).body as DendutyStatus;
    assert.match(st.kids[0]!.chatPaused!, /No chatting/);
    assert.equal((await call(mom, "POST", `/api/conversations/${family.conversationId}/messages`, { body: "hi" })).status, 200);

    // A "chores first" time-out: chat waits for the last two chores.
    kids = [{ id: "k1", name: "Ava", chores: { due: 5, done: 3, left: 2 }, chatLocks: [{ id: "t2", what: "Chores first", chat: "chores", endsAt }] }];
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.match((await send()).body.error, /2 to go/);
    kids = [{ id: "k1", name: "Ava", chores: { due: 5, done: 5, left: 0 }, chatLocks: [{ id: "t2", what: "Chores first", chat: "chores", endsAt }] }];
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.equal((await send()).status, 200);

    // The everyday rule a parent sets in Family: no chat until chores are done.
    kids = [{ id: "k1", name: "Ava", chores: { due: 2, done: 0, left: 2 } }];
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.equal((await send()).status, 200, "off by default");
    assert.equal((await call(mom, "PATCH", `/api/family/kids/${avaId}`, { choresFirst: true })).status, 200);
    const info = (await call(ava, "GET", "/api/family")).body;
    assert.equal(info.rules.choresFirst, true);
    assert.match(info.status.reason, /2 to go/);
    assert.equal((await send()).status, 403);
    // Ended early in Den Duty, or chores done: chat's back.
    kids = [{ id: "k1", name: "Ava", chores: { due: 2, done: 2, left: 0 } }];
    await call(admin, "POST", "/api/admin/denduty/check");
    assert.equal((await send()).status, 200);
    await call(mom, "PATCH", `/api/family/kids/${avaId}`, { choresFirst: false });
    gw.ws.close();
  });

  it("reports Den Duty errors, and unlinks", async () => {
    answer = 401;
    let st = (await call(admin, "POST", "/api/admin/denduty/check")).body as DendutyStatus;
    assert.match(st.error!, /token/);
    answer = 200;
    st = (await call(admin, "PUT", "/api/admin/denduty", { url: "" })).body as DendutyStatus;
    assert.deepEqual(st.settings, { url: "", homeId: "", hasToken: false, family: null, parents: null });
    assert.deepEqual(st.kids, []);
    assert.deepEqual((await call(mom, "GET", "/api/chores")).body, {});
  });
});
