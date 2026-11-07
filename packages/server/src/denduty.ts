import type { ChannelRef, ChoresToday, DendutySettings, DendutyStatus } from "@dendrop/shared";
import type { Db } from "./db.js";
import { ConversationRepo } from "./conversations.js";
import { HttpError } from "./errors.js";
import type { FamilyService } from "./family.js";
import { FriendRepo } from "./friends.js";
import type { Gateway } from "./gateway.js";
import type { LootdenFetch } from "./lootden.js";
import type { PushService } from "./push.js";
import { ServerRepo } from "./servers.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

/** Same shape as LootDen's: just enough of fetch, swapped out in tests. */
export type DendutyFetch = LootdenFetch;

/** What's saved for the link. */
interface Stored {
  url: string;
  homeId: string;
  token: string;
  family: ChannelRef | null;
  parents: ChannelRef | null;
  /** Den Duty kid id → Dendrop account picked by the admin (null: not this kid). Kids left out match by name. */
  kids: Record<string, number | null>;
  /** The newest Den Duty event already seen; null until the first check after linking. */
  lastEvent: number | null;
}

/** One kid, as GET /api/v1/homes/:homeId/gaming gives it (only what Dendrop uses). */
interface GamingKid {
  id: string;
  name: string;
  chores: ChoresToday | null;
  /** Time-outs on now that pause chat: "all" the whole time, "chores" until today's chores are done. Older Den Duty leaves it out. */
  chatLocks?: ChatLock[];
}

/** A Den Duty time-out that pauses a kid's chat. */
export interface ChatLock {
  what: string;
  chat: "all" | "chores";
  endsAt: string;
}

interface Gaming {
  timezone?: string;
  pointsName?: string;
  pointsIcon?: string;
  kids: GamingKid[];
}

/** A Den Duty event, as GET /api/v1/homes/:homeId/events gives it: the type, the kid, and the event's own fields. */
export interface DendutyEvent {
  id: number;
  event: string;
  kid: string | null;
  kid_id: string | null;
  at: string;
  [field: string]: unknown;
}

/** How a home words its points: "✨" and "Shinies". */
export interface PointsWords {
  icon: string;
  name: string;
  timezone: string;
}

/** Den Duty is asked every half minute, like LootDen. */
export const DENDUTY_POLL_MS = 30_000;
/** Den Duty being down this long clears the chores lines, since they may be out of date. */
const STALE_MS = 10 * 60_000;
const SETTINGS_KEY = "denduty";
const EMPTY: Stored = { url: "", homeId: "", token: "", family: null, parents: null, kids: {}, lastEvent: null };

const defaultFetch: DendutyFetch = (url, init) => fetch(url, init);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "Sat 6:00 PM" in the home's time zone. */
function when(iso: unknown, timezone: string): string {
  const t = typeof iso === "string" ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  try {
    return t.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: timezone || undefined });
  } catch {
    return t.toISOString();
  }
}

/**
 * What a Den Duty event says in chat, and where: "family" things are fine for kids to read,
 * "parents" things are only for grown-ups. Doctors events and the quiet ones (refunds,
 * reminders ticked off, help asks closed) aren't posted at all.
 */
export function eventText(e: DendutyEvent, words: PointsWords): { to: "family" | "parents"; text: string } | null {
  const kid = str(e.kid, 64) || "Someone";
  const pts = (n: unknown) => `${num(n) ?? 0} ${words.icon || words.name || "points"}`.trim();
  const icon = (v: unknown) => (str(v, 16) ? `${str(v, 16)} ` : "");
  const chore = `${icon(e.icon)}${str(e.chore, 120) || "a chore"}`;
  switch (e.event) {
    case "chore_approved": {
      const points = num(e.points) ?? 0;
      return { to: "family", text: `✅ ${kid} finished ${chore}${points > 0 ? ` (+${pts(points)})` : ""}` };
    }
    case "goal_reached":
      return { to: "family", text: `🎯 ${kid} reached their goal: ${str(e.goal, 120) || "a goal"}!` };
    case "goal_redeemed":
      return { to: "family", text: `🎁 ${kid} cashed in their goal: ${str(e.reward, 120) || str(e.goal, 120) || "a reward"}` };
    case "team_goal_reached": {
      const reward = str(e.reward, 120);
      return { to: "family", text: `🏆 Family goal reached: ${str(e.goal, 120) || "our goal"}!${reward ? `\nReward: ${reward}` : ""}` };
    }
    case "reward_given":
      return { to: "family", text: `🎁 ${kid} got ${icon(e.icon)}${str(e.reward, 120) || "a reward"} from the shop` };
    case "points_changed": {
      const amount = num(e.amount) ?? 0;
      const reason = str(e.reason, 200);
      if (e.kind === "reversal" || amount === 0) return null;
      if (amount > 0) return { to: "family", text: `🌟 ${kid} got +${pts(amount)}${reason ? `: ${reason}` : ""}` };
      return { to: "parents", text: `➖ ${kid}: −${pts(-amount)}${reason ? ` (${reason})` : ""}` };
    }
    case "chore_submitted":
      return { to: "parents", text: `⏳ ${kid} finished ${chore}${e.late ? " (late)" : ""}, waiting for a grown-up to check` };
    case "reward_bought":
      return { to: "parents", text: `🛍️ ${kid} bought ${icon(e.icon)}${str(e.reward, 120) || "a reward"} for ${pts(e.price)}. Hand it over in Den Duty.` };
    case "timeout_started": {
      const until = when(e.ends_at, words.timezone);
      const reason = str(e.reason, 200);
      return { to: "parents", text: `⏸️ Time-out for ${kid}: ${str(e.what, 120) || "something"}${until ? ` until ${until}` : ""}${reason ? `\nWhy: ${reason}` : ""}` };
    }
    case "timeout_ended":
      return { to: "parents", text: `▶️ ${kid}'s time-out ended early: ${str(e.what, 120) || "something"}` };
    case "timeout_buy_requested": {
      const units = num(e.units) ?? 1;
      const unit = str(e.unit, 10) || "hour";
      return { to: "parents", text: `⏱️ ${kid} wants to buy back ${units} ${unit}${units === 1 ? "" : "s"} of “${str(e.what, 120)}” for ${pts(e.points)}` };
    }
    case "timeout_time_bought":
      return { to: "parents", text: `⏱️ ${kid} bought back ${num(e.minutes) ?? 0} minutes of “${str(e.what, 120)}”${e.ended ? ", so it's over" : ""}` };
    case "helpdesk_requested": {
      const due = str(e.due_date, 10);
      return { to: "parents", text: `🙋 ${kid} asks for help: ${str(e.request, 300) || "something"}${due ? ` (by ${due})` : ""}` };
    }
    case "reminder_due":
      return { to: "parents", text: `⏰ Reminder: ${str(e.reminder, 200) || "something"}` };
    default:
      return null;
  }
}

/**
 * Why Den Duty pauses a kid's chat right now, in kind words for the kid, or null when it doesn't.
 * A time-out that pauses chat wins; then a time-out or the kid's "chores first" rule with chores
 * still to do. Without chores today (or with Den Duty out of touch) a chores pause lets them chat.
 */
export function chatPauseText(locks: ChatLock[], chores: ChoresToday | null, choresFirst: boolean, timezone: string, at: number): string | null {
  const live = locks.filter((l) => Date.parse(l.endsAt) > at);
  const all = live.filter((l) => l.chat === "all").sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt))[0];
  if (all) {
    const until = when(all.endsAt, timezone);
    return `Chat is taking a break for your Den Duty time-out (${all.what || "time-out"})${until ? ` until ${until}` : ""}. You've got this! 💛`;
  }
  if ((choresFirst || live.some((l) => l.chat === "chores")) && chores && chores.left > 0) {
    return `Chat opens once today's chores are done: ${chores.left} to go in Den Duty. You can do it! 🧹`;
  }
  return null;
}

/**
 * The link to Den Duty, the family's chore tracker. With its address, home id and a read
 * token, Dendrop asks Den Duty every half minute for each kid's chores today and anything
 * new that happened. Chores show under the kid's name for the kid and their parents, and
 * events are posted as "Den Duty": the cheerful ones in a family channel, the grown-up ones
 * in a parents channel that no kid account can read. Time-outs that pause chat, and a kid's
 * "chores first" rule, keep that kid from chatting until they're over (see chatPauseText).
 */
export class DendutyLink {
  private chores = new Map<number, ChoresToday>();
  /** Time-outs that pause chat, by Dendrop kid account. */
  private chatLocks = new Map<number, ChatLock[]>();
  /** The Den Duty home's time zone, for "until Sat 6:00 PM". */
  private timezone = "";
  private kids: DendutyStatus["kids"] = [];
  private lastOk = 0;
  private error: string | null = null;
  private timer?: NodeJS.Timeout;
  private polling: Promise<void> | null = null;
  private readonly servers: ServerRepo;
  private readonly convos: ConversationRepo;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly family: FamilyService,
    private readonly push: PushService,
    private readonly fetchImpl: DendutyFetch = defaultFetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.servers = new ServerRepo(db, users);
    this.convos = new ConversationRepo(db, users, new FriendRepo(db, users));
    family.setChatPause((kidId, choresFirst, timezone) => this.chatPaused(kidId, choresFirst, timezone));
  }

  /** Why Den Duty pauses this kid's chat now, or null. */
  chatPaused(kidId: number, choresFirst: boolean, timezone?: string): string | null {
    return chatPauseText(this.chatLocks.get(kidId) ?? [], this.chores.get(kidId) ?? null, choresFirst, this.timezone || timezone || "UTC", this.clock());
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), DENDUTY_POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  stored(): Stored {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    try {
      return { ...EMPTY, ...(r ? (JSON.parse(r.value) as Partial<Stored>) : {}) };
    } catch {
      return { ...EMPTY };
    }
  }

  private write(s: Stored): void {
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(s));
  }

  settings(): DendutySettings {
    const s = this.stored();
    return { url: s.url, homeId: s.homeId, hasToken: !!s.token, family: s.family, parents: s.parents };
  }

  status(): DendutyStatus {
    return {
      settings: this.settings(),
      lastOkAt: this.lastOk ? new Date(this.lastOk).toISOString() : null,
      error: this.error,
      kids: this.kids,
      kidAccounts: this.kidAccounts().map(toPublic),
    };
  }

  private kidAccounts(): UserRecord[] {
    const ids = this.db.prepare("SELECT DISTINCT kid_id FROM family_links ORDER BY kid_id").all() as { kid_id: number }[];
    return ids.map((r) => this.users.byId(r.kid_id)).filter((u): u is UserRecord => !!u);
  }

  /**
   * Links (or, with an empty url, unlinks) Den Duty. The token is one made in Den Duty's
   * Settings, Home Assistant and the API; a read token is enough. Leave it out to keep the saved one.
   */
  async save(input: { url?: unknown; homeId?: unknown; token?: unknown }): Promise<DendutyStatus> {
    const raw = str(input.url, 300).replace(/\/+$/, "");
    if (!raw) {
      this.db.prepare("DELETE FROM server_settings WHERE key = ?").run(SETTINGS_KEY);
      await this.poll();
      return this.status();
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, "Den Duty's address should look like https://chores.example.com");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Den Duty's address should start with https:// or http://");
    const before = this.stored();
    const homeId = str(input.homeId, 100) || before.homeId;
    if (!/^[\w-]+$/.test(homeId)) throw new HttpError(400, "Paste your home id from Den Duty (Settings, Home Assistant and the API)");
    const token = input.token === undefined || input.token === "" ? before.token : str(input.token, 500);
    if (!token) throw new HttpError(400, "Paste an API token from Den Duty (Settings, Home Assistant and the API)");
    // A different home starts over: its events and kids aren't the old one's.
    const sameHome = before.url === raw && before.homeId === homeId;
    this.write({ ...before, url: raw, homeId, token, ...(sameHome ? {} : { kids: {}, lastEvent: null }) });
    this.lastOk = 0;
    await this.poll();
    return this.status();
  }

  /**
   * Where events go: { family, parents }, a { serverId, channelId } text channel each, or null
   * to stop. `check` throws unless the channel is one the super admin may pick.
   */
  setChannels(input: { family?: unknown; parents?: unknown }, check: (ref: ChannelRef) => ChannelRef): void {
    const s = this.stored();
    const clean = (v: unknown): ChannelRef | null => {
      if (v === null) return null;
      const r = v as Partial<ChannelRef>;
      return check({ serverId: Number(r?.serverId), channelId: Number(r?.channelId) });
    };
    if (input.family !== undefined) s.family = clean(input.family);
    if (input.parents !== undefined) {
      s.parents = clean(input.parents);
      if (s.parents && this.kidsCanRead(s.parents)) throw new HttpError(400, "A kid account can read that channel; pick one only grown-ups are in");
    }
    this.write(s);
  }

  /** { kidId, userId }: which Dendrop kid account a Den Duty kid is (userId null: none; "auto": by name again). */
  pick(input: { kidId?: unknown; userId?: unknown }): void {
    const kidId = str(input.kidId, 100);
    if (!kidId) throw new HttpError(400, "Which Den Duty kid?");
    const s = this.stored();
    if (input.userId === "auto") delete s.kids[kidId];
    else if (input.userId === null) s.kids[kidId] = null;
    else {
      const user = this.users.byId(Number(input.userId));
      if (!user || !user.isKid) throw new HttpError(400, "Pick a Dendrop kid account");
      s.kids[kidId] = user.id;
    }
    this.write(s);
  }

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => (this.polling = null));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const s = this.stored();
    if (!s.url || !s.token || !s.homeId) {
      this.kids = [];
      this.error = null;
      this.lastOk = 0;
      this.replace(new Map(), new Map());
      return;
    }
    try {
      const home = `/api/v1/homes/${encodeURIComponent(s.homeId)}`;
      const gaming = await this.get<Gaming>(`${home}/gaming`);
      if (!gaming || !Array.isArray(gaming.kids)) throw new Error("Den Duty answered with something unexpected; is that Den Duty's address?");
      const kidAccounts = this.kidAccounts();
      const next = new Map<number, ChoresToday>();
      const locks = new Map<number, ChatLock[]>();
      this.kids = gaming.kids.map((k) => {
        const id = str(k.id, 100);
        const name = str(k.name, 64);
        const { user, matchedBy } = this.match(id, name, s.kids, kidAccounts);
        const chores = k.chores && typeof k.chores === "object" ? { due: num(k.chores.due) ?? 0, done: num(k.chores.done) ?? 0, left: num(k.chores.left) ?? 0 } : null;
        if (user && chores && chores.due > 0) next.set(user.id, chores);
        const chatLocks = (Array.isArray(k.chatLocks) ? k.chatLocks : [])
          .filter((l) => l && (l.chat === "all" || l.chat === "chores") && !Number.isNaN(Date.parse(l.endsAt)))
          .map((l) => ({ what: str(l.what, 80), chat: l.chat, endsAt: l.endsAt }));
        if (user && chatLocks.length) locks.set(user.id, chatLocks);
        return { denduty: { id, name }, user: user ? toPublic(user) : null, matchedBy, chores, chatPaused: null };
      });
      const words: PointsWords = { icon: str(gaming.pointsIcon, 16), name: str(gaming.pointsName, 32), timezone: str(gaming.timezone, 64) };
      const events = await this.get<DendutyEvent[]>(`${home}/events?after=${s.lastEvent ?? 0}`);
      if (!Array.isArray(events)) throw new Error("Den Duty answered with something unexpected for events");
      this.postEvents(events, words);
      this.timezone = words.timezone;
      this.lastOk = this.clock();
      this.error = null;
      this.replace(next, locks);
    } catch (err) {
      this.error = (err as Error).message;
      // Out of date: chores lines go, and chat isn't held back on old news.
      if (this.clock() - this.lastOk > STALE_MS) this.replace(new Map(), new Map());
    }
  }

  private async get<T>(path: string): Promise<T> {
    const { url, token } = this.stored();
    let res;
    try {
      res = await this.fetchImpl(`${url}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Den Duty at ${url}: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new Error("Den Duty didn't accept the API token");
    if (res.status === 403 || res.status === 404) throw new Error("Den Duty says that token can't see that home; check the home id");
    if (!res.ok) throw new Error(`Den Duty answered ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("Den Duty answered with something that isn't JSON; is that Den Duty's address?");
    }
  }

  /** The Dendrop kid account for a Den Duty kid: the admin's pick, or a kid account with the same name. */
  private match(id: string, name: string, picked: Stored["kids"], kidAccounts: UserRecord[]): { user: UserRecord | null; matchedBy: DendutyStatus["kids"][number]["matchedBy"] } {
    if (id in picked) {
      const u = picked[id] === null ? undefined : this.users.byId(picked[id]!);
      return { user: u?.isKid ? u : null, matchedBy: "picked" };
    }
    const n = name.toLowerCase();
    const same = kidAccounts.filter((u) => u.displayName.toLowerCase() === n || u.username.toLowerCase() === n);
    return same.length === 1 ? { user: same[0]!, matchedBy: "name" } : { user: null, matchedBy: null };
  }

  /** Posts what's new, oldest first. Right after linking, starts from here rather than posting the past. */
  private postEvents(events: DendutyEvent[], words: PointsWords): void {
    const s = this.stored();
    const fresh = events.filter((e) => Number.isInteger(e.id) && e.id > (s.lastEvent ?? 0)).sort((a, b) => a.id - b.id);
    if (!fresh.length) {
      if (s.lastEvent === null) this.write({ ...s, lastEvent: 0 });
      return;
    }
    const newest = fresh.at(-1)!.id;
    if (s.lastEvent !== null) {
      for (const e of fresh) {
        const said = eventText(e, words);
        if (!said) continue;
        const ref = said.to === "family" ? s.family : s.parents;
        this.post(ref, said.text, said.to === "parents");
      }
    }
    this.write({ ...this.stored(), lastEvent: newest });
  }

  private kidsCanRead(ref: ChannelRef): boolean {
    const c = this.servers.channelById(ref.channelId);
    if (!c) return false;
    return this.convos.memberIds(c.conversationId).some((id) => this.users.byId(id)?.isKid);
  }

  /** Posts as "Den Duty" (with the server's owner on record as the author). Grown-up things never go where a kid can read them. */
  private post(ref: ChannelRef | null, text: string, grownUps: boolean): void {
    if (!ref) return;
    const c = this.servers.channelById(ref.channelId);
    if (!c || c.serverId !== ref.serverId || c.kind !== "text") return;
    if (grownUps && this.kidsCanRead(ref)) return;
    const owner = (this.db.prepare("SELECT owner_id FROM servers WHERE id = ?").get(ref.serverId) as { owner_id: number } | undefined)?.owner_id;
    if (!owner) return;
    const m = this.convos.send(c.conversationId, owner, text, [], null, { id: null, name: "Den Duty" });
    const members = this.convos.memberIds(c.conversationId);
    this.gateway.send(members, { type: "message.created", message: m });
    void this.push.notify(
      members.filter((u) => !this.gateway.isOnline(u)),
      "message",
    );
  }

  /** Who sees a kid's chores line: the kid and their parents. */
  private audience(userId: number): number[] {
    return [userId, ...this.family.parentsOf(userId)];
  }

  private replace(next: Map<number, ChoresToday>, locks: Map<number, ChatLock[]>): void {
    const kids = new Set([...this.chores.keys(), ...next.keys(), ...this.chatLocks.keys(), ...locks.keys()]);
    const before = new Map([...kids].map((id) => [id, this.pauseFor(id)]));
    const changed = new Set<number>();
    for (const [id, c] of next) if (JSON.stringify(this.chores.get(id)) !== JSON.stringify(c)) changed.add(id);
    for (const id of this.chores.keys()) if (!next.has(id)) changed.add(id);
    this.chores = next;
    this.chatLocks = locks;
    for (const id of changed) {
      const to = this.audience(id).filter((u) => this.gateway.isOnline(u));
      if (to.length) this.gateway.send(to, { type: "chores", userId: id, chores: next.get(id) ?? null });
    }
    // Chat paused or opened again: the kid's app (and their parents') hear it now, not at the next minute.
    const flipped = [...kids].filter((id) => before.get(id) !== this.pauseFor(id));
    if (flipped.length) this.family.pushFamily(flipped);
    for (const k of this.kids) k.chatPaused = k.user ? this.pauseFor(k.user.id) : null;
  }

  /** The pause as the kid sees it, with their own rules. */
  private pauseFor(kidId: number): string | null {
    if (!this.users.byId(kidId)?.isKid) return null;
    return this.chatPaused(kidId, this.family.rules(kidId).choresFirst, this.family.rules(kidId).timezone);
  }

  /** The chores lines `viewer` can see, by user id: their own, and their kids'. */
  visibleTo(viewer: UserRecord): Record<number, ChoresToday> {
    const out: Record<number, ChoresToday> = {};
    for (const [id, c] of this.chores) if (id === viewer.id || this.family.isParentOf(viewer.id, id)) out[id] = c;
    return out;
  }
}
