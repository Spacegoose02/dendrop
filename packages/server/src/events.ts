import { EVENT_LIMITS, isVoiceKind, type EventRsvp, type ScheduledEvent } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import type { PushService } from "./push.js";
import { ServerRepo } from "./servers.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

interface EventRow {
  id: number;
  server_id: number;
  channel_id: number | null;
  name: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string | null;
  repeats: "none" | "weekly";
  status: "scheduled" | "live";
  started_at: string | null;
  reminded: number;
  created_by: number | null;
  created_at: string;
}

export interface EventInput {
  name?: unknown;
  description?: unknown;
  channelId?: unknown;
  location?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  repeat?: unknown;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;

function cleanText(v: unknown, max: number, what: string, allowEmpty: boolean): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} needs to be text`);
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!s && !allowEmpty) throw new HttpError(400, `${what} can't be empty`);
  if (s.length > max) throw new HttpError(400, `${what} can be up to ${max} characters`);
  return s;
}

function cleanTime(v: unknown, what: string): number {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new HttpError(400, `${what} needs to be a date and time`);
  return t;
}

const iso = (t: number) => new Date(t).toISOString();

/**
 * Scheduled events in servers: making and changing them, RSVPs, and the clock that reminds
 * people, starts events and ends them (see ScheduledEvent for the rules).
 *
 * Who sees an event: everyone in the server, or for one in a channel, the people who can see
 * that channel (its conversation's members, like voice). Changing one needs Manage events, or
 * being the person who made it.
 */
export class EventService {
  /** The time now, in ms. Replaced in tests. */
  clock: () => number = Date.now;
  private timer?: NodeJS.Timeout;
  private readonly servers: ServerRepo;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly push: PushService,
  ) {
    this.servers = new ServerRepo(db, users);
  }

  /** Checks for reminders, starts and ends every so often. */
  start(everyMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---- Reading ------------------------------------------------------------------

  private row(eventId: number): EventRow | undefined {
    return this.db.prepare("SELECT * FROM server_events WHERE id = ?").get(eventId) as EventRow | undefined;
  }

  private conversationOf(channelId: number): number | undefined {
    const r = this.db.prepare("SELECT conversation_id FROM server_channels WHERE id = ?").get(channelId) as { conversation_id: number } | undefined;
    return r?.conversation_id;
  }

  /** Who can see an event right now. */
  private viewers(r: EventRow): number[] {
    const members = this.servers.memberIds(r.server_id);
    const cid = r.channel_id === null ? undefined : this.conversationOf(r.channel_id);
    if (cid === undefined) return members;
    const can = new Set(
      (this.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(cid) as { user_id: number }[]).map((x) => x.user_id),
    );
    return members.filter((u) => can.has(u));
  }

  private canSee(r: EventRow, userId: number): boolean {
    return this.viewers(r).includes(userId);
  }

  private canManage(r: EventRow, userId: number): boolean {
    if (!this.servers.role(r.server_id, userId)) return false;
    return r.created_by === userId || this.servers.can(r.server_id, userId, "manageEvents");
  }

  private rsvps(eventId: number, serverId: number): { user_id: number; status: EventRsvp }[] {
    return this.db
      .prepare(
        `SELECT r.user_id, r.status FROM server_event_rsvps r JOIN server_members m ON m.server_id = ? AND m.user_id = r.user_id
         WHERE r.event_id = ? ORDER BY r.created_at, r.user_id`,
      )
      .all(serverId, eventId) as { user_id: number; status: EventRsvp }[];
  }

  private toEvent(r: EventRow, viewerId: number): ScheduledEvent {
    const rsvps = this.rsvps(r.id, r.server_id);
    const creator = r.created_by === null || !this.servers.role(r.server_id, r.created_by) ? undefined : this.users.byId(r.created_by);
    return {
      id: r.id,
      serverId: r.server_id,
      name: r.name,
      description: r.description,
      channelId: r.channel_id,
      location: r.location,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      repeat: r.repeats === "weekly" ? "weekly" : "none",
      status: r.status,
      createdBy: creator ? toPublic(creator) : null,
      goingIds: rsvps.filter((x) => x.status === "going").map((x) => x.user_id),
      interestedIds: rsvps.filter((x) => x.status === "interested").map((x) => x.user_id),
      myRsvp: rsvps.find((x) => x.user_id === viewerId)?.status ?? null,
      canManage: this.canManage(r, viewerId),
      createdAt: r.created_at,
    };
  }

  /** One event as this person sees it, or a 404 if they can't. */
  get(eventId: number, userId: number): ScheduledEvent {
    return this.toEvent(this.visible(eventId, userId), userId);
  }

  private visible(eventId: number, userId: number): EventRow {
    const r = this.row(eventId);
    if (!r || !this.canSee(r, userId)) throw new HttpError(404, "No such event");
    return r;
  }

  private managed(eventId: number, user: UserRecord): EventRow {
    const r = this.visible(eventId, user.id);
    if (!this.canManage(r, user.id)) throw new HttpError(403, "You need Manage events to change someone else's event");
    return r;
  }

  /** A server's events that this person can see, soonest first. */
  forServer(serverId: number, userId: number): ScheduledEvent[] {
    if (!this.servers.role(serverId, userId)) throw new HttpError(404, "No such server");
    const rows = this.db.prepare("SELECT * FROM server_events WHERE server_id = ? ORDER BY starts_at, id").all(serverId) as unknown as EventRow[];
    return rows.filter((r) => this.canSee(r, userId)).map((r) => this.toEvent(r, userId));
  }

  /** Events in every server this person is in, soonest first. */
  forUser(userId: number): ScheduledEvent[] {
    const rows = this.db
      .prepare("SELECT e.* FROM server_events e JOIN server_members m ON m.server_id = e.server_id AND m.user_id = ? ORDER BY e.starts_at, e.id")
      .all(userId) as unknown as EventRow[];
    return rows.filter((r) => this.canSee(r, userId)).map((r) => this.toEvent(r, userId));
  }

  // ---- Changing -----------------------------------------------------------------

  /** Where an event happens: a voice or stage channel the person can see, or somewhere else. */
  private place(serverId: number, userId: number, channelId: unknown, location: unknown): { channelId: number | null; location: string } {
    if (channelId !== undefined && channelId !== null) {
      const c = this.servers.channelById(Number(channelId));
      if (!c || c.serverId !== serverId || !this.servers.view(serverId, userId)?.channels.some((x) => x.id === c.id)) throw new HttpError(404, "No such channel");
      if (!isVoiceKind(c.kind)) throw new HttpError(400, "Pick a voice or stage channel, or say where it is");
      return { channelId: c.id, location: "" };
    }
    const where = location === undefined ? "" : cleanText(location, EVENT_LIMITS.location, "Where it is", true);
    if (!where) throw new HttpError(400, "Pick a voice or stage channel, or say where it is");
    return { channelId: null, location: where };
  }

  private times(startsAt: number, endsAt: unknown): number | null {
    if (endsAt === undefined || endsAt === null || endsAt === "") return null;
    const end = cleanTime(endsAt, "The end");
    if (end <= startsAt) throw new HttpError(400, "An event has to end after it starts");
    if (end - startsAt > EVENT_LIMITS.maxHours * HOUR) throw new HttpError(400, `Events can last up to ${EVENT_LIMITS.maxHours} hours`);
    return end;
  }

  private checkStart(t: number): void {
    const at = this.clock();
    // A minute of slack for a form sent right at the time it names.
    if (t < at - MINUTE) throw new HttpError(400, "Pick a time that hasn't passed yet");
    if (t > at + EVENT_LIMITS.maxDaysAhead * 24 * HOUR) throw new HttpError(400, "Events can be up to a year ahead");
  }

  /** Whether the heads-up is already due (or past) for an event starting then. */
  private reminderDue(startsAt: number): boolean {
    return startsAt - this.clock() <= EVENT_LIMITS.reminderMinutes * MINUTE;
  }

  create(serverId: number, user: UserRecord, input: EventInput): ScheduledEvent {
    if (!this.servers.role(serverId, user.id)) throw new HttpError(404, "No such server");
    if (!this.servers.can(serverId, user.id, "manageEvents")) throw new HttpError(403, "You need Manage events to make events");
    const name = cleanText(input.name, EVENT_LIMITS.name, "The event name", false);
    const description = input.description === undefined ? "" : cleanText(input.description, EVENT_LIMITS.description, "The description", true);
    const { channelId, location } = this.place(serverId, user.id, input.channelId, input.location);
    const start = cleanTime(input.startsAt, "The start");
    this.checkStart(start);
    const end = this.times(start, input.endsAt);
    if (input.repeat !== undefined && input.repeat !== "none" && input.repeat !== "weekly") throw new HttpError(400, "An event repeats weekly or not at all");
    const n = Number((this.db.prepare("SELECT COUNT(*) AS n FROM server_events WHERE server_id = ?").get(serverId) as { n: number }).n);
    if (n >= EVENT_LIMITS.perServer) throw new HttpError(400, `A server can have up to ${EVENT_LIMITS.perServer} events coming up`);
    const res = this.db
      .prepare(
        `INSERT INTO server_events (server_id, channel_id, name, description, location, starts_at, ends_at, repeats, reminded, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(serverId, channelId, name, description, location, iso(start), end === null ? null : iso(end), input.repeat === "weekly" ? "weekly" : "none", this.reminderDue(start) ? 1 : 0, user.id, now());
    const id = Number(res.lastInsertRowid);
    // Whoever makes it is going.
    this.db.prepare("INSERT INTO server_event_rsvps (event_id, user_id, status, created_at) VALUES (?, ?, 'going', ?)").run(id, user.id, now());
    this.broadcast(id);
    this.tick();
    return this.get(id, user.id);
  }

  update(eventId: number, user: UserRecord, patch: EventInput): ScheduledEvent {
    const r = this.managed(eventId, user);
    const name = patch.name === undefined ? r.name : cleanText(patch.name, EVENT_LIMITS.name, "The event name", false);
    const description = patch.description === undefined ? r.description : cleanText(patch.description, EVENT_LIMITS.description, "The description", true);
    const place =
      patch.channelId === undefined && patch.location === undefined
        ? { channelId: r.channel_id, location: r.location }
        : this.place(r.server_id, user.id, patch.channelId, patch.location);
    let start = Date.parse(r.starts_at);
    let reminded = r.reminded;
    if (patch.startsAt !== undefined) {
      const t = cleanTime(patch.startsAt, "The start");
      if (t !== start) {
        if (r.status === "live") throw new HttpError(400, "It has already started");
        this.checkStart(t);
        start = t;
        reminded = this.reminderDue(t) ? 1 : 0;
      }
    }
    const endInput = patch.endsAt === undefined ? r.ends_at : patch.endsAt;
    const end = this.times(start, endInput);
    if (r.status === "live" && end !== null && end <= this.clock()) throw new HttpError(400, "Pick an end time that hasn't passed, or end it now");
    if (patch.repeat !== undefined && patch.repeat !== "none" && patch.repeat !== "weekly") throw new HttpError(400, "An event repeats weekly or not at all");
    const repeats = patch.repeat === undefined ? r.repeats : patch.repeat;
    this.db
      .prepare(
        `UPDATE server_events SET name = ?, description = ?, channel_id = ?, location = ?, starts_at = ?, ends_at = ?, repeats = ?, reminded = ?
         WHERE id = ?`,
      )
      .run(name, description, place.channelId, place.location, iso(start), end === null ? null : iso(end), repeats, reminded, eventId);
    this.broadcast(eventId);
    this.tick();
    return this.get(eventId, user.id);
  }

  /** Going, interested, or null to take an RSVP back. */
  rsvp(eventId: number, user: UserRecord, status: unknown): ScheduledEvent {
    this.visible(eventId, user.id);
    if (status === null) {
      this.db.prepare("DELETE FROM server_event_rsvps WHERE event_id = ? AND user_id = ?").run(eventId, user.id);
    } else if (status === "going" || status === "interested") {
      this.db
        .prepare(
          `INSERT INTO server_event_rsvps (event_id, user_id, status, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status`,
        )
        .run(eventId, user.id, status, now());
    } else {
      throw new HttpError(400, "RSVP going, interested, or null");
    }
    this.broadcast(eventId);
    return this.get(eventId, user.id);
  }

  /** A host starts it now, early or on time. */
  startNow(eventId: number, user: UserRecord): ScheduledEvent {
    const r = this.managed(eventId, user);
    if (r.status === "live") throw new HttpError(400, "It has already started");
    this.goLive(r);
    return this.get(eventId, user.id);
  }

  /** A host ends it: a weekly one moves on to next week, anything else is gone. */
  endNow(eventId: number, user: UserRecord): ScheduledEvent | null {
    const r = this.managed(eventId, user);
    if (r.status !== "live") throw new HttpError(400, "It hasn't started yet");
    this.finish(r);
    const next = this.row(eventId);
    return next ? this.toEvent(next, user.id) : null;
  }

  /** Cancels it (every week of a weekly one). */
  cancel(eventId: number, user: UserRecord): void {
    const r = this.managed(eventId, user);
    this.remove(r);
  }

  // ---- The clock ----------------------------------------------------------------

  /** Sends reminders that are due, starts events whose time has come, and ends ones that are over. */
  tick(): void {
    const at = this.clock();
    const soon = iso(at + EVENT_LIMITS.reminderMinutes * MINUTE);
    const rows = this.db
      .prepare("SELECT * FROM server_events WHERE status = 'live' OR starts_at <= ? ORDER BY starts_at, id")
      .all(soon) as unknown as EventRow[];
    for (const r of rows) {
      try {
        const start = Date.parse(r.starts_at);
        if (r.status === "live") {
          if (this.endsAt(r) <= at) this.finish(r);
        } else if (this.endsAt(r) <= at) {
          // Missed altogether (the server was off): no reminders, straight on.
          this.finish(r);
        } else if (start <= at) {
          this.goLive(r);
        } else if (!r.reminded) {
          this.db.prepare("UPDATE server_events SET reminded = 1 WHERE id = ?").run(r.id);
          this.remind(r.id, Math.max(1, Math.round((start - at) / MINUTE)));
        }
      } catch {
        // One bad row shouldn't stop the others.
      }
    }
  }

  private endsAt(r: EventRow): number {
    if (r.ends_at) return Date.parse(r.ends_at);
    return Date.parse(r.started_at ?? r.starts_at) + EVENT_LIMITS.openEndedHours * HOUR;
  }

  private goLive(r: EventRow): void {
    this.db.prepare("UPDATE server_events SET status = 'live', started_at = ?, reminded = 1 WHERE id = ?").run(iso(this.clock()), r.id);
    this.broadcast(r.id);
    this.remind(r.id, 0);
  }

  private finish(r: EventRow): void {
    if (r.repeats !== "weekly") {
      this.remove(r);
      return;
    }
    // On to the next week that hasn't started yet (at least a week on, for one started early),
    // keeping the RSVPs.
    const at = this.clock();
    let start = Date.parse(r.starts_at);
    let end = r.ends_at ? Date.parse(r.ends_at) : null;
    do {
      start += WEEK;
      if (end !== null) end += WEEK;
    } while (start <= at);
    this.db
      .prepare("UPDATE server_events SET status = 'scheduled', started_at = NULL, starts_at = ?, ends_at = ?, reminded = ? WHERE id = ?")
      .run(iso(start), end === null ? null : iso(end), this.reminderDue(start) ? 1 : 0, r.id);
    this.broadcast(r.id);
  }

  private remove(r: EventRow): void {
    this.db.prepare("DELETE FROM server_events WHERE id = ?").run(r.id);
    this.gateway.send(this.servers.memberIds(r.server_id), { type: "event.removed", serverId: r.server_id, eventId: r.id });
  }

  /** Tells everyone who RSVP'd (and can still see it), with a push for anyone not in the app. */
  private remind(eventId: number, minutes: number): void {
    const r = this.row(eventId);
    if (!r) return;
    const viewers = new Set(this.viewers(r));
    const who = this.rsvps(r.id, r.server_id)
      .map((x) => x.user_id)
      .filter((u) => viewers.has(u));
    for (const u of who) this.gateway.send([u], { type: "event.reminder", event: this.toEvent(r, u), minutes });
    void this.push.notify(
      who.filter((u) => !this.gateway.isOnline(u)),
      "event",
    );
  }

  /**
   * Sends each server member their view of an event, or that it's gone for them (a channel
   * they can't see).
   */
  private broadcast(eventId: number): void {
    const r = this.row(eventId);
    if (!r) return;
    const viewers = new Set(this.viewers(r));
    for (const u of this.servers.memberIds(r.server_id)) {
      if (viewers.has(u)) this.gateway.send([u], { type: "event.updated", event: this.toEvent(r, u) });
      else this.gateway.send([u], { type: "event.removed", serverId: r.server_id, eventId: r.id });
    }
  }
}
