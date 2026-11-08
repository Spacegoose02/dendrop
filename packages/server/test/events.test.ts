import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { EVENT_LIMITS, type Channel, type ChatServer, type CustomRole, type ScheduledEvent } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("scheduled events", () => {
  let s: TestServer;
  let owner: string, ann: string, bob: string, out: string;
  let ownerId: number, annId: number, bobId: number;
  let sid: number;
  let lounge: Channel, stage: Channel, general: Channel, secret: Channel;
  /** The server's clock, moved by the tests. */
  let at = Date.parse("2026-11-08T18:00:00.000Z");
  const pushes: string[] = [];
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const iso = (t: number) => new Date(t).toISOString();
  const tickAt = (t: number) => {
    at = t;
    s.ctx.events.tick();
  };
  const make = async (cookie: string, body: object) => call(cookie, "POST", `/api/servers/${sid}/events`, body);

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { pushPost: async (url) => (pushes.push(url), 201) });
    s.ctx.events.stop();
    s.ctx.events.clock = () => at;
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
    stage = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "movie-night", kind: "stage" })).body;
    secret = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "parents", kind: "voice", locked: true, memberIds: [annId] })).body;
    // Bob gets a phone, so reminders reach him while he's away.
    await call(bob, "POST", "/api/push/subscriptions", { endpoint: "https://ntfy.example/upBob" });
  });
  after(() => s.close());

  it("makes stage channels", async () => {
    assert.equal(stage.kind, "stage");
    assert.equal((await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "x", kind: "video" })).status, 400);
  });

  it("lets only people with Manage events make events, and checks what they say", async () => {
    const body = { name: "Movie night", channelId: stage.id, startsAt: iso(at + 2 * HOUR), endsAt: iso(at + 4 * HOUR) };
    assert.equal((await make(ann, body)).status, 403);
    assert.equal((await make(out, body)).status, 404);
    // A role with Manage events is enough.
    const role = (await call(owner, "POST", `/api/servers/${sid}/roles`, { name: "Hosts", permissions: ["manageEvents"] })).body as CustomRole;
    assert.equal((await call(owner, "PUT", `/api/servers/${sid}/members/${annId}/roles`, { roleIds: [role.id] })).status, 200);

    assert.equal((await make(ann, { ...body, name: "" })).status, 400);
    assert.equal((await make(ann, { ...body, channelId: general.id })).status, 400, "text channels aren't places");
    assert.equal((await make(ann, { ...body, channelId: undefined })).status, 400, "somewhere is needed");
    assert.equal((await make(ann, { ...body, startsAt: iso(at - HOUR) })).status, 400, "not in the past");
    assert.equal((await make(ann, { ...body, endsAt: iso(at + HOUR) })).status, 400, "ends after it starts");
    assert.equal((await make(ann, { ...body, endsAt: iso(at + 100 * HOUR) })).status, 400, "not too long");
    assert.equal((await make(ann, { ...body, repeat: "daily" })).status, 400);

    const r = await make(ann, { ...body, description: "Popcorn provided" });
    assert.equal(r.status, 200);
    const e = r.body as ScheduledEvent;
    assert.equal(e.status, "scheduled");
    assert.equal(e.channelId, stage.id);
    assert.equal(e.createdBy?.id, annId);
    assert.deepEqual(e.goingIds, [annId], "whoever makes it is going");
    assert.equal(e.myRsvp, "going");
    assert.equal(e.canManage, true);
  });

  it("shows events to the people who can see where they are", async () => {
    const r = await make(owner, { name: "Parents' chat", channelId: secret.id, startsAt: iso(at + 3 * HOUR) });
    assert.equal(r.status, 200);
    const names = async (cookie: string) => ((await call(cookie, "GET", `/api/servers/${sid}/events`)).body as ScheduledEvent[]).map((e) => e.name);
    assert.deepEqual(await names(ann), ["Movie night", "Parents' chat"]);
    assert.deepEqual(await names(bob), ["Movie night"]);
    assert.equal((await call(out, "GET", `/api/servers/${sid}/events`)).status, 404);
    assert.equal((await call(bob, "GET", `/api/events/${r.body.id}`)).status, 404);
    assert.deepEqual(((await call(bob, "GET", "/api/events")).body as ScheduledEvent[]).map((e) => e.name), ["Movie night"]);
    assert.equal((await call(owner, "DELETE", `/api/events/${r.body.id}`)).status, 200);
  });

  it("takes RSVPs, and tells everyone the new counts", async () => {
    const [movie] = (await call(bob, "GET", `/api/servers/${sid}/events`)).body as ScheduledEvent[];
    assert.equal(movie!.canManage, false);
    const annLive = await listen(s, ann);
    let e = (await call(bob, "PUT", `/api/events/${movie!.id}/rsvp`, { status: "interested" })).body as ScheduledEvent;
    assert.deepEqual([e.myRsvp, e.interestedIds], ["interested", [bobId]]);
    const seen = await annLive.waitFor("event.updated");
    assert.deepEqual([seen.event.myRsvp, seen.event.interestedIds], ["going", [bobId]], "each person gets their own view");
    e = (await call(bob, "PUT", `/api/events/${movie!.id}/rsvp`, { status: "going" })).body;
    assert.deepEqual(e.goingIds, [annId, bobId]);
    assert.equal((await call(bob, "PUT", `/api/events/${movie!.id}/rsvp`, { status: "maybe" })).status, 400);
    assert.equal((await call(out, "PUT", `/api/events/${movie!.id}/rsvp`, { status: "going" })).status, 404);
    annLive.ws.close();
  });

  it("only lets the host or Manage events change it", async () => {
    const [movie] = (await call(bob, "GET", `/api/servers/${sid}/events`)).body as ScheduledEvent[];
    assert.equal((await call(bob, "PATCH", `/api/events/${movie!.id}`, { name: "Bob's night" })).status, 403);
    assert.equal((await call(bob, "POST", `/api/events/${movie!.id}/start`)).status, 403);
    assert.equal((await call(bob, "DELETE", `/api/events/${movie!.id}`)).status, 403);
    const r = await call(owner, "PATCH", `/api/events/${movie!.id}`, { name: "Friday movie night" });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "Friday movie night");
    assert.equal(r.body.description, "Popcorn provided", "what isn't sent stays");
  });

  it("reminds people who RSVP'd before it starts, then when it goes live, and ends it on time", async () => {
    const [movie] = (await call(bob, "GET", `/api/servers/${sid}/events`)).body as ScheduledEvent[];
    const start = Date.parse(movie!.startsAt);
    const annLive = await listen(s, ann);

    tickAt(start - 30 * MIN);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(annLive.events.some((e) => e.type === "event.reminder"), false, "not yet");

    pushes.length = 0;
    tickAt(start - EVENT_LIMITS.reminderMinutes * MIN + 1000);
    const soon = await annLive.waitFor("event.reminder");
    assert.equal(soon.minutes, EVENT_LIMITS.reminderMinutes);
    assert.equal(soon.event.id, movie!.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(pushes, ["https://ntfy.example/upBob"], "bob isn't in the app, so his phone is woken");

    // Only once.
    tickAt(start - 5 * MIN);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(annLive.events.some((e) => e.type === "event.reminder"), false);

    tickAt(start);
    const live = await annLive.waitFor("event.reminder");
    assert.deepEqual([live.minutes, live.event.status], [0, "live"]);

    tickAt(Date.parse(movie!.endsAt!) + 1000);
    const gone = await annLive.waitFor("event.removed");
    assert.equal(gone.eventId, movie!.id);
    assert.deepEqual((await call(ann, "GET", `/api/servers/${sid}/events`)).body, []);
    annLive.ws.close();
  });

  it("moves a weekly event on a week when it ends, keeping its RSVPs", async () => {
    const start = at + HOUR;
    const e = (await make(owner, { name: "Game night", channelId: lounge.id, startsAt: iso(start), repeat: "weekly" })).body as ScheduledEvent;
    await call(bob, "PUT", `/api/events/${e.id}/rsvp`, { status: "going" });
    // Hosts can start early.
    const live = (await call(owner, "POST", `/api/events/${e.id}/start`)).body as ScheduledEvent;
    assert.equal(live.status, "live");
    assert.equal((await call(owner, "POST", `/api/events/${e.id}/start`)).status, 400);
    const ended = (await call(owner, "POST", `/api/events/${e.id}/end`)).body.event as ScheduledEvent;
    assert.equal(ended.status, "scheduled");
    assert.equal(ended.startsAt, iso(start + 7 * 24 * HOUR));
    assert.deepEqual(ended.goingIds, [ownerId, bobId]);

    // With no end time, it ends by itself after a while.
    tickAt(Date.parse(ended.startsAt));
    assert.equal(((await call(owner, "GET", `/api/events/${e.id}`)).body as ScheduledEvent).status, "live");
    tickAt(Date.parse(ended.startsAt) + EVENT_LIMITS.openEndedHours * HOUR + 1000);
    const next = (await call(owner, "GET", `/api/events/${e.id}`)).body as ScheduledEvent;
    assert.deepEqual([next.status, next.startsAt], ["scheduled", iso(start + 14 * 24 * HOUR)]);
    assert.equal((await call(owner, "DELETE", `/api/events/${e.id}`)).status, 200);
  });

  it("takes places outside the server, and goes away with the server", async () => {
    const e = (await make(owner, { name: "Picnic", location: "Grandma's house", startsAt: iso(at + HOUR) })).body as ScheduledEvent;
    assert.deepEqual([e.channelId, e.location], [null, "Grandma's house"]);
    assert.equal((await call(owner, "DELETE", `/api/servers/${sid}`)).status, 200);
    assert.deepEqual((await call(owner, "GET", "/api/events")).body, []);
  });
});
