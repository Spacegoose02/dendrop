import type { Activity, ChannelRef, LootdenKidLimits, LootdenSettings, LootdenStatus } from "@dendrop/shared";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";
import { isTimeZone, localTime } from "./family.js";
import type { Gateway } from "./gateway.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

/** Just enough of fetch for LootDen's API; swapped out in tests. */
export type LootdenFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>;

/** What's saved for the link. */
interface Stored {
  url: string;
  token: string;
  gameNights: ChannelRef | null;
  screenshots: ChannelRef | null;
}

/** A LootDen profile, as GET /api/users (admins) gives it. */
interface LootdenUser {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  kidMode: boolean;
  role?: string;
  /** Not sent by LootDen today; used when it is, as the surest match. */
  oidcSubject?: string | null;
}

/** One game running on a PC, as GET /api/family/now-playing gives it. */
interface NowPlaying {
  userId: number;
  device: string;
  title: string;
  href: string | null;
  startedAt: string;
}

/** A profile's play limits and today's allowance, as GET /api/users/:id/limits (admins) gives them. */
interface LootdenLimits {
  limits: { weekdayMinutes: number | null; weekendMinutes: number | null; bedtime: { from: string; to: string } | null };
  allowance: { date: string; timeZone: string; usedSeconds: number; bonusSeconds: number };
}

/** What's kept of a kid's LootDen limits from the last check that got them. */
interface KidPlay {
  weekdayMinutes: number | null;
  weekendMinutes: number | null;
  bedtime: { from: string; to: string } | null;
  timezone: string;
  /** The day (LootDen's time zone) usedSeconds and bonusSeconds are for. */
  date: string;
  usedSeconds: number;
  bonusSeconds: number;
}

interface Playing {
  activity: Activity;
  /** The LootDen profile is a kid profile (so its games are kid-safe ones). */
  kidProfile: boolean;
}

/** LootDen checks in every 30 seconds; PCs not heard from in 90 have stopped playing. */
export const LOOTDEN_POLL_MS = 30_000;
const STALE_MS = 90_000;
const SETTINGS_KEY = "lootden";

const defaultFetch: LootdenFetch = (url, init) => fetch(url, init);

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1440) : null);
const seconds = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** LootDen's answer for one profile's limits, with anything odd dropped; null when it isn't one. */
function readLimits(x: unknown): KidPlay | null {
  const r = x as Partial<LootdenLimits> | null;
  if (!r || typeof r !== "object" || !r.limits || !r.allowance) return null;
  const b = r.limits.bedtime;
  const date = str(r.allowance.date, 10);
  return {
    weekdayMinutes: minutesOrNull(r.limits.weekdayMinutes),
    weekendMinutes: minutesOrNull(r.limits.weekendMinutes),
    bedtime: b && HHMM.test(String(b.from)) && HHMM.test(String(b.to)) && b.from !== b.to ? { from: b.from, to: b.to } : null,
    timezone: isTimeZone(r.allowance.timeZone) ? r.allowance.timeZone : "UTC",
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    usedSeconds: seconds(r.allowance.usedSeconds),
    bonusSeconds: seconds(r.allowance.bonusSeconds),
  };
}

/**
 * The link to LootDen, the family's game library. Both sign in through the same TinyAuth, so
 * a LootDen profile lines up with a Dendrop account by sign-in subject, email or username.
 * Every half minute Dendrop asks LootDen (with an admin's API token) who's playing what, and
 * shows it as their activity to their friends and the people they share a server with, unless
 * they've turned that off. Kids only see the names of games that kid profiles are playing.
 */
export class LootdenLink {
  private playing = new Map<number, Playing>();
  /** Kid accounts' LootDen play limits, by Dendrop user id. */
  private kidPlay = new Map<number, KidPlay>();
  private accounts: LootdenStatus["accounts"] = [];
  private lastOk = 0;
  private error: string | null = null;
  private timer?: NodeJS.Timeout;
  private polling: Promise<void> | null = null;
  /** Run after each good check: game nights and screenshots (see lootden-extras.ts). */
  afterPoll: (() => Promise<void>)[] = [];
  /** Run whenever who's playing what changes, or someone turns sharing it on or off (see play-together.ts). */
  onPlayingChanged: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly fetchImpl: LootdenFetch = defaultFetch,
    private readonly clock: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), LOOTDEN_POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  stored(): Stored {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    try {
      const v = r ? (JSON.parse(r.value) as Partial<Stored>) : {};
      return { url: v.url ?? "", token: v.token ?? "", gameNights: v.gameNights ?? null, screenshots: v.screenshots ?? null };
    } catch {
      return { url: "", token: "", gameNights: null, screenshots: null };
    }
  }

  private write(s: Stored): void {
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(s));
  }

  settings(): LootdenSettings {
    const s = this.stored();
    return { url: s.url, hasToken: !!s.token, gameNights: s.gameNights, screenshots: s.screenshots };
  }

  /**
   * Where game nights and screenshots go: a channel in a server the super admin moderates, or
   * null to stop. Checked by `check` (which throws when it isn't allowed).
   */
  setChannels(input: { gameNights?: unknown; screenshots?: unknown }, check: (ref: ChannelRef) => ChannelRef): void {
    const s = this.stored();
    const clean = (v: unknown): ChannelRef | null => {
      if (v === null) return null;
      const r = v as Partial<ChannelRef>;
      return check({ serverId: Number(r?.serverId), channelId: Number(r?.channelId) });
    };
    if (input.gameNights !== undefined) s.gameNights = clean(input.gameNights);
    if (input.screenshots !== undefined) s.screenshots = clean(input.screenshots);
    this.write(s);
  }

  /** The LootDen profile and admin flag of a Dendrop account, from the last check. */
  profileOf(userId: number): { id: number; displayName: string; kid: boolean; admin: boolean } | undefined {
    return this.accounts.find((a) => a.user?.id === userId)?.lootden;
  }

  /** A request to LootDen's API with the saved token. */
  async request(path: string, init: { method?: string; body?: unknown } = {}) {
    const { url, token } = this.stored();
    if (!url || !token) throw new HttpError(404, "LootDen isn't linked");
    let res;
    try {
      res = await this.fetchImpl(`${url}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Couldn't reach LootDen at ${url}: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new Error("LootDen didn't accept the API token");
    if (res.status === 403) throw new Error("The API token has to be a LootDen admin's");
    return res;
  }

  /**
   * Links (or, with an empty url, unlinks) LootDen. The token is a LootDen admin's API token
   * (LootDen, Profile, API tokens); leave it out to keep the one saved.
   */
  async save(input: { url?: unknown; token?: unknown }): Promise<LootdenStatus> {
    const raw = str(input.url, 300).replace(/\/+$/, "");
    if (!raw) {
      this.db.prepare("DELETE FROM server_settings WHERE key = ?").run(SETTINGS_KEY);
      this.accounts = [];
      await this.poll();
      return this.status();
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, "LootDen's address should look like https://games.example.com");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "LootDen's address should start with https:// or http://");
    const token = input.token === undefined || input.token === "" ? this.stored().token : str(input.token, 500);
    if (!token) throw new HttpError(400, "Paste an API token from a LootDen admin (LootDen, Profile, Devices and tokens)");
    this.write({ ...this.stored(), url: raw, token });
    this.lastOk = 0;
    await this.poll();
    return this.status();
  }

  status(): LootdenStatus {
    return {
      settings: this.settings(),
      lastOkAt: this.lastOk ? new Date(this.lastOk).toISOString() : null,
      error: this.error,
      accounts: this.accounts.map((a) => ({ ...a, userIsKid: a.user ? !!this.users.byId(a.user.id)?.isKid : false })),
      playing: this.playing.size,
    };
  }

  /** Asks LootDen who's playing what, and tells people what changed. One at a time. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => (this.polling = null));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const { url, token } = this.stored();
    if (!url || !token) {
      this.accounts = [];
      this.error = null;
      this.lastOk = 0;
      this.kidPlay.clear();
      this.replace(new Map());
      return;
    }
    try {
      const [profiles, nowPlaying] = await Promise.all([
        this.get<LootdenUser[]>("/api/users"),
        this.get<NowPlaying[]>("/api/family/now-playing"),
      ]);
      if (!Array.isArray(profiles) || !Array.isArray(nowPlaying)) throw new Error("LootDen answered with something unexpected; is that LootDen's address?");
      const matched = new Map<number, { user: UserRecord; kid: boolean }>();
      this.accounts = profiles.map((p) => {
        const lootden = {
          id: Number(p.id),
          username: str(p.username, 64),
          displayName: str(p.displayName, 64) || str(p.username, 64),
          kid: p.kidMode === true,
          admin: p.role === "admin",
        };
        const { user, matchedBy } = this.match(p);
        if (user) matched.set(lootden.id, { user, kid: lootden.kid });
        return { lootden, user: user ? toPublic(user) : null, matchedBy, userIsKid: !!user?.isKid };
      });
      const next = new Map<number, Playing>();
      for (const np of nowPlaying) {
        const who = matched.get(Number(np.userId));
        if (!who) continue;
        const startedAt = Number.isFinite(Date.parse(np.startedAt)) ? new Date(np.startedAt).toISOString() : new Date(this.clock()).toISOString();
        const prev = next.get(who.user.id);
        // Two games at once: show the one started last.
        if (prev && prev.activity.startedAt >= startedAt) continue;
        const href = typeof np.href === "string" && np.href.startsWith("/") ? `${url}${np.href}` : null;
        next.set(who.user.id, {
          kidProfile: who.kid,
          activity: { kind: "playing", title: str(np.title, 200) || "a game", device: str(np.device, 100), startedAt, url: href },
        });
      }
      await this.readKidLimits(matched);
      this.lastOk = this.clock();
      this.error = null;
      this.replace(next);
      for (const fn of this.afterPoll) await fn().catch((err: Error) => (this.error = err.message));
    } catch (err) {
      this.error = (err as Error).message;
      // LootDen being down for a while means we don't know who's still playing.
      if (this.clock() - this.lastOk > STALE_MS) this.replace(new Map());
    }
  }

  /**
   * Play limits for the matched profiles that are Dendrop kid accounts. A kid whose limits
   * can't be read this time keeps the last ones (they rarely change); one no longer matched
   * is dropped.
   */
  private async readKidLimits(matched: Map<number, { user: UserRecord; kid: boolean }>): Promise<void> {
    const kids = [...matched].filter(([, m]) => m.user.isKid);
    const next = new Map<number, KidPlay>();
    await Promise.all(
      kids.map(async ([lootdenId, { user }]) => {
        const read = await this.get<unknown>(`/api/users/${lootdenId}/limits`).then(readLimits, () => null);
        const play = read ?? this.kidPlay.get(user.id);
        if (play) next.set(user.id, play);
      }),
    );
    this.kidPlay = next;
  }

  /** A kid account's LootDen play limits for today, or null when there are none to go by. */
  kidLimits(userId: number, at: Date = new Date(this.clock())): LootdenKidLimits | null {
    const k = this.kidPlay.get(userId);
    if (!k) return null;
    const { day, minute, weekday } = localTime(k.timezone, at);
    const sameDay = k.date === day;
    const daily = weekday === 0 || weekday === 6 ? k.weekendMinutes : k.weekdayMinutes;
    let played = sameDay ? k.usedSeconds : 0;
    // LootDen counts a game once it ends; add the one running now, from today's part of it.
    const running = this.playing.get(userId);
    if (running) {
      const since = (at.getTime() - Date.parse(running.activity.startedAt)) / 1000;
      if (since > 0) played += Math.min(since, minute * 60 + 59);
    }
    return {
      bedtime: k.bedtime,
      dailyMinutes: daily === null ? null : daily + (sameDay ? Math.floor(k.bonusSeconds / 60) : 0),
      playedMinutes: Math.floor(played / 60),
      timezone: k.timezone,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new Error(`LootDen answered ${res.status} for ${path}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("LootDen answered with something that isn't JSON; is that LootDen's address?");
    }
  }

  /** The Dendrop account a LootDen profile belongs to: same TinyAuth sign-in, then email, then username. */
  private match(p: LootdenUser): { user: UserRecord | null; matchedBy: LootdenStatus["accounts"][number]["matchedBy"] } {
    const sub = str(p.oidcSubject, 300);
    const bySub = sub ? this.users.byOidcSubject(sub) : undefined;
    if (bySub) return { user: bySub, matchedBy: "sign-in" };
    const email = str(p.email, 300);
    const byEmail = email ? this.users.byEmail(email) : undefined;
    if (byEmail) return { user: byEmail, matchedBy: "email" };
    const name = str(p.username, 64);
    const byName = name ? this.users.byUsername(name) : undefined;
    if (byName) return { user: byName, matchedBy: "username" };
    return { user: null, matchedBy: null };
  }

  private replace(next: Map<number, Playing>): void {
    const changed = new Set<number>();
    for (const [id, p] of next) if (JSON.stringify(this.playing.get(id)) !== JSON.stringify(p)) changed.add(id);
    for (const id of this.playing.keys()) if (!next.has(id)) changed.add(id);
    this.playing = next;
    for (const id of changed) this.announce(id);
    if (changed.size) this.playingChanged();
  }

  private playingChanged(): void {
    for (const fn of this.onPlayingChanged) {
      try {
        fn();
      } catch (err) {
        this.error = (err as Error).message;
      }
    }
  }

  /** Everyone playing something now, sharing it or not: callers check `shareActivity`. */
  nowPlaying(): { userId: number; title: string; kidProfile: boolean }[] {
    return [...this.playing].map(([userId, p]) => ({ userId, title: p.activity.title, kidProfile: p.kidProfile }));
  }

  /** People who can see what `userId` is doing: friends and people in a server with them. */
  private audience(userId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END AS id FROM friendships
           WHERE (user_a = ?1 OR user_b = ?1) AND accepted_at IS NOT NULL AND held_for_parent = 0
         UNION
         SELECT b.user_id FROM server_members a JOIN server_members b ON b.server_id = a.server_id
           WHERE a.user_id = ?1 AND b.user_id != ?1`,
      )
      .all(userId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** What `viewer` is shown of `userId`'s activity, or null for nothing. */
  private view(userId: number, viewer: UserRecord, sharing: boolean): Activity | null {
    const p = this.playing.get(userId);
    if (!p) return null;
    if (viewer.id === userId) return p.activity;
    if (!sharing) return null;
    // Kid accounts don't see the names of grown-ups' games (LootDen does the same).
    if (viewer.isKid && !p.kidProfile) return { ...p.activity, title: "a game", url: null };
    return p.activity;
  }

  /** Tells `userId` and everyone who can see them what they're doing now. */
  private announce(userId: number): void {
    const user = this.users.byId(userId);
    if (!user) return;
    for (const id of [userId, ...this.audience(userId)]) {
      const viewer = id === userId ? user : this.users.byId(id);
      if (!viewer || !this.gateway.isOnline(id)) continue;
      this.gateway.send([id], { type: "activity", userId, activity: this.view(userId, viewer, user.shareActivity) });
    }
  }

  /** Someone turned sharing what they play on or off. */
  shareChanged(userId: number): void {
    if (!this.playing.has(userId)) return;
    this.announce(userId);
    this.playingChanged();
  }

  /** Everything `viewer` can see right now, by user id. */
  visibleTo(viewer: UserRecord): Record<number, Activity> {
    const out: Record<number, Activity> = {};
    for (const userId of this.playing.keys()) {
      const user = userId === viewer.id ? viewer : this.users.byId(userId);
      if (!user) continue;
      if (userId !== viewer.id && !this.audience(userId).includes(viewer.id)) continue;
      const a = this.view(userId, viewer, user.shareActivity);
      if (a) out[userId] = a;
    }
    return out;
  }
}
