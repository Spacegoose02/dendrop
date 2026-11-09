import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChannelRef, EventRsvp, LootdenGame, LootdenPc } from "@dendrop/shared";
import type { Context } from "./app.js";
import { ConversationRepo, type NewAttachment } from "./conversations.js";
import { now } from "./db.js";
import { HttpError } from "./errors.js";
import { FriendRepo } from "./friends.js";
import { cleanChannelName, ServerRepo } from "./servers.js";
import { removeVoiceWhenEmpty } from "./temp-voice.js";
import type { UserRecord } from "./users.js";

/** A LootDen game as GET /api/games/:id gives it (only what Dendrop uses). */
interface LootdenGameRow {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseYear: number | null;
  genres: string[];
  platform: string;
  sizeBytes: number;
  kidSafe: boolean | null;
  kind: string;
}

/** A planned game night, as GET /api/game-nights gives it. */
interface GameNightRow {
  id: number;
  title: string;
  date: string;
  time: string;
  players: { id: number; name: string }[];
  game: { id: string; title: string } | null;
  note: string | null;
}

/** A screenshot on LootDen's family wall, as GET /api/screenshots gives it. */
interface ScreenshotRow {
  id: number;
  imageUrl: string;
  by: { id: number; name: string };
  game: { id: string | null; title: string } | null;
  caption: string | null;
}

const LAST_SHOT_KEY = "lootden.lastScreenshot";
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** Game nights are checked every this many link checks (30 s each): every 5 minutes. */
const NIGHT_EVERY = 10;

/** The moment a wall-clock day and time happen in a time zone ("2026-11-13", "19:00", "America/Chicago"). */
export function zonedTime(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = (time || "19:00").split(":").map(Number);
  const wall = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, h ?? 19, min ?? 0);
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
  };
  // Twice, so a night on the day the clocks change lands right.
  let t = wall - offset(wall);
  t = wall - offset(t);
  return t;
}

/** "Fri, Nov 13 at 7:00 PM" from LootDen's day and time (already in the household's time zone). */
export function nightWhen(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = (time || "19:00").split(":").map(Number);
  const t = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, h ?? 19, min ?? 0));
  if (Number.isNaN(t.getTime())) return `${date} ${time}`;
  const day = t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const clock = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day} at ${clock}`;
}

/** A voice channel name for a game night: "game-night-mario-party". */
export function nightChannelName(title: string): string {
  try {
    return cleanChannelName(`game-night-${title}`.slice(0, 32));
  } catch {
    return "game-night";
  }
}

/**
 * The rest of the LootDen link: cards for links to its games (with Send to PC), planned game
 * nights announced in a channel with their own voice channel, and new family wall screenshots
 * shared to a channel, kid-safe ones only where kids can read it.
 */
export class LootdenExtras {
  private readonly servers: ServerRepo;
  private readonly convos: ConversationRepo;
  private readonly uploads: string;
  private checks = 0;

  constructor(private readonly ctx: Context) {
    this.servers = new ServerRepo(ctx.db, ctx.users);
    this.convos = new ConversationRepo(ctx.db, ctx.users, new FriendRepo(ctx.db, ctx.users));
    this.uploads = path.join(ctx.config.dataDir, "uploads");
    mkdirSync(this.uploads, { recursive: true });
    ctx.events.onRsvp.push((eventId, userId, status) => void this.rsvpToLootden(eventId, userId, status));
    ctx.lootden.afterPoll.push(async () => {
      // Game nights change rarely: every fifth minute, or right away after a setting changes.
      if (this.checks++ % NIGHT_EVERY === 0) await this.syncGameNights();
      await this.syncScreenshots();
    });
  }

  private async json<T>(p: string): Promise<T> {
    const res = await this.ctx.lootden.request(p);
    if (res.status === 404) throw new HttpError(404, "LootDen doesn't have that");
    if (!res.ok) throw new Error(`LootDen answered ${res.status} for ${p}`);
    return (await res.json()) as T;
  }

  /** Kid accounts, and people whose LootDen profile is a kid profile, only see kid-safe games. */
  private kidView(viewer: UserRecord): boolean {
    return viewer.isKid || !!this.ctx.lootden.profileOf(viewer.id)?.kid;
  }

  // ---- Game links ------------------------------------------------------------------

  async game(id: string, viewer: UserRecord): Promise<LootdenGame> {
    const g = await this.json<LootdenGameRow>(`/api/games/${encodeURIComponent(id)}`);
    if (this.kidView(viewer) && g.kidSafe !== true) throw new HttpError(404, "That game isn't one for kids");
    const base = this.ctx.lootden.settings().url;
    return {
      id: g.id,
      title: String(g.title ?? "A game"),
      coverUrl: g.coverUrl ? `/api/lootden/games/${encodeURIComponent(g.id)}/cover` : null,
      releaseYear: typeof g.releaseYear === "number" ? g.releaseYear : null,
      genres: Array.isArray(g.genres) ? g.genres.slice(0, 4).map(String) : [],
      platform: String(g.platform ?? "pc"),
      sizeBytes: Number(g.sizeBytes) || 0,
      url: `${base}/games/${encodeURIComponent(g.id)}`,
      canSend: !!this.ctx.lootden.profileOf(viewer.id) && g.kind === "game",
    };
  }

  async cover(id: string, viewer: UserRecord): Promise<{ type: string; bytes: Buffer }> {
    await this.game(id, viewer);
    const res = await this.ctx.lootden.request(`/api/games/${encodeURIComponent(id)}/cover`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!res.ok || !type.startsWith("image/")) throw new HttpError(404, "No cover");
    return { type, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /** PCs you can send games to: every PC for LootDen admins, otherwise the ones you use. */
  async pcs(viewer: UserRecord): Promise<LootdenPc[]> {
    const profile = this.ctx.lootden.profileOf(viewer.id);
    if (!profile) throw new HttpError(403, "Your account isn't matched with a LootDen profile");
    const all = await this.json<LootdenPc[]>("/api/pcs/targets");
    return all
      .filter((pc) => profile.admin || pc.lastUser === profile.displayName)
      .map((pc) => ({ name: String(pc.name), online: !!pc.online, lastUser: pc.lastUser ?? null }));
  }

  /** Send to PC: the game downloads and installs there with LootDen's app. */
  async send(id: string, device: unknown, viewer: UserRecord): Promise<void> {
    const game = await this.game(id, viewer);
    if (!game.canSend) throw new HttpError(403, "Only full games can be sent to a PC, by people with a LootDen profile");
    const name = typeof device === "string" ? device : "";
    if (!(await this.pcs(viewer)).some((pc) => pc.name === name)) throw new HttpError(403, "You can send games to PCs you use");
    const res = await this.ctx.lootden.request(`/api/pcs/${encodeURIComponent(name)}/install`, { method: "POST", body: { gameId: game.id } });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new HttpError(400, msg || `LootDen answered ${res.status}`);
    }
  }

  // ---- Posting -------------------------------------------------------------------

  /** Where a ref points, if it's still a channel of that server. */
  private channel(ref: ChannelRef | null) {
    if (!ref) return undefined;
    const c = this.servers.channelById(ref.channelId);
    return c && c.serverId === ref.serverId ? c : undefined;
  }

  private owner(serverId: number): number | undefined {
    return (this.ctx.db.prepare("SELECT owner_id FROM servers WHERE id = ?").get(serverId) as { owner_id: number } | undefined)?.owner_id;
  }

  /** Posts as "LootDen" (with the server's owner on record as the author). */
  private post(conversationId: number, serverId: number, text: string, files: NewAttachment[] = []) {
    const author = this.owner(serverId);
    if (!author) return undefined;
    const m = this.convos.send(conversationId, author, text, files, null, { id: null, name: "LootDen" });
    const members = this.convos.memberIds(conversationId);
    this.ctx.gateway.send(members, { type: "message.created", message: m });
    void this.ctx.push.notify(
      members.filter((u) => !this.ctx.gateway.isActive(u)),
      "message",
    );
    return m;
  }

  // ---- Game nights ----------------------------------------------------------------

  private nightText(n: GameNightRow, voiceName: string | null): string {
    const lines = [`🎲 Game night: ${n.title}`, nightWhen(n.date, n.time)];
    if (n.game) lines.push(`Playing ${n.game.title}`);
    if (n.players?.length) lines.push(`With ${n.players.map((p) => p.name).join(", ")}`);
    if (n.note) lines.push(n.note);
    if (voiceName) lines.push(`Voice: 🔊 ${voiceName}`);
    return lines.join("\n");
  }

  /**
   * Each upcoming game night gets an announcement in the chosen channel and its own voice
   * channel in that server. Changes in LootDen update the announcement; once a night is over
   * (or deleted) its voice channel goes, as soon as nobody's in it.
   */
  async syncGameNights(): Promise<void> {
    const ref = this.ctx.lootden.stored().gameNights;
    const target = this.channel(ref);
    const { db } = this.ctx;
    const known = db.prepare("SELECT * FROM lootden_game_nights").all() as {
      lootden_id: number;
      server_id: number;
      voice_channel_id: number | null;
      message_id: number | null;
      event_id: number | null;
      players: string;
      signature: string;
    }[];
    const list = target ? await this.json<{ upcoming: GameNightRow[]; timeZone?: string }>("/api/game-nights") : null;
    const upcoming = list?.upcoming ?? [];
    const timeZone = typeof list?.timeZone === "string" ? list.timeZone : "UTC";
    const live = new Set(upcoming.map((n) => Number(n.id)));

    // Over, deleted, or game nights turned off: take their voice channels away when empty.
    for (const k of known) {
      if (live.has(k.lootden_id) && k.server_id === ref?.serverId) continue;
      if (k.event_id !== null) {
        this.ctx.events.removeLinked(k.event_id);
        db.prepare("UPDATE lootden_game_nights SET event_id = NULL WHERE lootden_id = ?").run(k.lootden_id);
      }
      if (!removeVoiceWhenEmpty(this.ctx, this.servers, this.uploads, k.voice_channel_id)) continue;
      db.prepare("DELETE FROM lootden_game_nights WHERE lootden_id = ?").run(k.lootden_id);
    }
    if (!target || !ref) return;

    for (const n of upcoming) {
      const id = Number(n.id);
      const signature = JSON.stringify([n.title, n.date, n.time, n.game?.title ?? null, n.players?.map((p) => p.name) ?? [], n.note]);
      const row = known.find((k) => k.lootden_id === id && k.server_id === ref.serverId);
      if (row?.signature === signature && row.event_id !== null && this.ctx.events.exists(row.event_id)) continue;
      let voice = row?.voice_channel_id ? this.servers.channelById(row.voice_channel_id) : undefined;
      if (!voice) {
        try {
          voice = this.servers.createChannel(ref.serverId, { name: nightChannelName(n.title), kind: "voice", topic: nightWhen(n.date, n.time) });
          this.ctx.serverChanged?.(ref.serverId);
        } catch {
          voice = undefined; // Channel limit reached: announce it anyway.
        }
      } else if (row) {
        this.servers.updateChannel(ref.serverId, voice.id, { name: nightChannelName(n.title), topic: nightWhen(n.date, n.time) });
        this.ctx.serverChanged?.(ref.serverId);
      }
      const text = this.nightText(n, voice?.name ?? null);
      const old = row?.message_id ? this.convos.message(row.message_id) : undefined;
      let messageId = row?.message_id ?? null;
      if (old && !old.deleted && old.conversationId === target.conversationId) {
        db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(text, now(), old.id);
        const m = this.convos.message(old.id)!;
        this.ctx.gateway.send(this.convos.memberIds(m.conversationId), { type: "message.updated", message: m });
      } else {
        messageId = this.post(target.conversationId, ref.serverId, text)?.id ?? null;
      }
      // A server event too, so people RSVP, get reminded and join its voice channel from it.
      const description = [n.game ? `Playing ${n.game.title}` : null, n.players?.length ? `With ${n.players.map((p) => p.name).join(", ")}` : null, n.note, "Planned in LootDen"]
        .filter(Boolean)
        .join("\n");
      let eventId: number | null = row?.event_id ?? null;
      try {
        eventId = this.ctx.events.upsertLinked(eventId, ref.serverId, {
          name: `🎲 ${n.title}`,
          description,
          channelId: voice?.id ?? null,
          location: voice ? "" : "Game night",
          startsAt: zonedTime(n.date, n.time, timeZone),
        });
      } catch {
        eventId = null; // Too many events in the server: the announcement still goes out.
      }
      // LootDen's players are going; anyone LootDen took off since last time isn't.
      const players = (n.players ?? []).map((p) => this.ctx.lootden.userOf(Number(p.id))).filter((u): u is number => u !== undefined);
      const before = JSON.parse(row?.players ?? "[]") as number[];
      if (eventId !== null) this.ctx.events.setRsvps(eventId, players, before.filter((u) => !players.includes(u)));
      db.prepare(
        `INSERT INTO lootden_game_nights (lootden_id, server_id, voice_channel_id, message_id, event_id, players, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lootden_id) DO UPDATE SET server_id = excluded.server_id, voice_channel_id = excluded.voice_channel_id,
           message_id = excluded.message_id, event_id = excluded.event_id, players = excluded.players, signature = excluded.signature`,
      ).run(id, ref.serverId, voice?.id ?? null, messageId, eventId, JSON.stringify(players), signature, now());
    }
  }

  /**
   * Someone said Going (or took it back) on a game night's event: LootDen puts them on the night
   * (or takes them off), when their account is matched with a LootDen profile.
   */
  async rsvpToLootden(eventId: number, userId: number, status: EventRsvp | null): Promise<void> {
    const row = this.ctx.db.prepare("SELECT lootden_id, players FROM lootden_game_nights WHERE event_id = ?").get(eventId) as { lootden_id: number; players: string } | undefined;
    const profile = row ? this.ctx.lootden.profileOf(userId) : undefined;
    if (!row || !profile) return;
    const going = status === "going";
    const players = new Set(JSON.parse(row.players) as number[]);
    if (going === players.has(userId)) return;
    try {
      const res = await this.ctx.lootden.request(`/api/game-nights/${row.lootden_id}/players/${profile.id}`, { method: "PUT", body: { going } });
      if (!res.ok) return; // e.g. the last player can't leave; the next sync puts things right.
      if (going) players.add(userId);
      else players.delete(userId);
      this.ctx.db.prepare("UPDATE lootden_game_nights SET players = ?, signature = '' WHERE lootden_id = ?").run(JSON.stringify([...players]), row.lootden_id);
      this.soon();
    } catch {
      // LootDen is down: it keeps its own list, and the next sync shows it.
    }
  }

  /** Check game nights on the next link check, after a setting changed. */
  soon(): void {
    this.checks = 0;
  }

  // ---- Screenshots -----------------------------------------------------------------

  private lastShot(): number | null {
    const r = this.ctx.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(LAST_SHOT_KEY) as { value: string } | undefined;
    return r ? Number(r.value) : null;
  }

  private setLastShot(id: number): void {
    this.ctx.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(LAST_SHOT_KEY, String(id));
  }

  /** Forget where sharing got to, so turning it on doesn't post the whole wall. */
  resetScreenshots(): void {
    this.ctx.db.prepare("DELETE FROM server_settings WHERE key = ?").run(LAST_SHOT_KEY);
  }

  /**
   * New screenshots on LootDen's family wall go to the chosen channel, with the picture. When
   * a kid account can read that channel, only screenshots of kid-safe games are shared.
   */
  async syncScreenshots(): Promise<void> {
    const ref = this.ctx.lootden.stored().screenshots;
    const target = this.channel(ref);
    if (!target || !ref) return;
    const shots = await this.json<ScreenshotRow[]>("/api/screenshots?limit=20");
    if (!Array.isArray(shots) || !shots.length) return;
    const last = this.lastShot();
    const newest = Math.max(...shots.map((s) => Number(s.id)));
    // Just turned on: start from here rather than posting what's already on the wall.
    if (last === null) return this.setLastShot(newest);
    const kids = this.convos.memberIds(target.conversationId).some((id) => this.ctx.users.byId(id)?.isKid);
    for (const s of shots.filter((x) => Number(x.id) > last).sort((a, b) => a.id - b.id)) {
      this.setLastShot(Number(s.id));
      if (kids) {
        const safe = s.game?.id ? await this.json<LootdenGameRow>(`/api/games/${encodeURIComponent(s.game.id)}`).then((g) => g.kidSafe === true, () => false) : false;
        if (!safe) continue;
      }
      const file = await this.download(Number(s.id));
      const what = s.game?.title ? ` from ${s.game.title}` : "";
      const text = [`📸 ${s.by?.name ?? "Someone"} shared a screenshot${what}`, s.caption ?? ""].filter(Boolean).join("\n");
      try {
        this.post(target.conversationId, ref.serverId, text, file ? [file] : []);
      } catch (err) {
        if (file) rmSync(path.join(this.uploads, file.id), { force: true });
        throw err;
      }
    }
  }

  private async download(id: number): Promise<NewAttachment | null> {
    const res = await this.ctx.lootden.request(`/api/screenshots/${id}/image`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const ext = IMAGE_TYPES[type];
    if (!res.ok || !ext) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const fileId = randomBytes(16).toString("hex");
    writeFileSync(path.join(this.uploads, fileId), bytes);
    return { id: fileId, name: `screenshot-${id}.${ext}`, size: bytes.length, contentType: type };
  }
}
