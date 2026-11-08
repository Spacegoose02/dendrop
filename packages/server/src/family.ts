import { randomInt } from "node:crypto";
import type {
  FamilyAlert,
  FamilyAlertType,
  FamilyAuditEntry,
  FamilyInfo,
  FamilyKid,
  FamilyLinkCode,
  KidRules,
  KidStatus,
  LootdenKidLimits,
  PublicUser,
} from "@dendrop/shared";
import { findBlockedWords } from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import { toPublic, type UserRepo } from "./users.js";

/**
 * Kid-safe chat: kid accounts linked to parents, the rules parents set, the alerts parents get,
 * and the copies of deleted messages kept for them.
 *
 * How it fits with end-to-end encryption: parents are "guardians" of every conversation their
 * kid is in. Conversation keys are wrapped for guardians as well as members (the server
 * insists, see ConversationRepo.addKey), and everyone in the conversation is shown who they
 * are. The server only hands a parent the messages and their key copies while an alert about
 * that conversation is open, and logs each look where the kid can see it.
 */

export type WebhookPost = (url: string, body: string) => Promise<number>;

const defaultPost: WebhookPost = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
  return res.status;
};

const DEFAULT_RULES: KidRules = {
  profanityFilter: true,
  blockedWords: [],
  approveFriends: true,
  canJoinServers: false,
  allowedFrom: null,
  allowedUntil: null,
  dailyMinutes: null,
  timezone: "UTC",
  choresFirst: false,
  lootdenBedtime: false,
  lootdenPlayTime: false,
  gifs: false,
  profilePictures: false,
  linkPreviews: false,
};

/**
 * Asked for why Den Duty pauses a kid's chat right now (a time-out, or chores first), in words
 * for the kid; null when it doesn't. Set by the Den Duty link.
 */
export type ChatPause = (kidId: number, choresFirst: boolean, timezone: string) => string | null;

const MAX_PARENTS = 4;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_HOURS = 24;
/** Alerts of the same kind about the same thing aren't repeated while one is open. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The day (YYYY-MM-DD), minute of the day and weekday (0 is Sunday) at `at`, in a time zone. */
export function localTime(tz: string, at: Date): { day: string; minute: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Sun"),
  };
}

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

interface RulesRow {
  kid_id: number;
  profanity_filter: number;
  blocked_words: string;
  approve_friends: number;
  can_join_servers: number;
  allowed_from: string | null;
  allowed_until: string | null;
  daily_minutes: number | null;
  timezone: string;
  chores_first: number;
  lootden_bedtime: number;
  lootden_play_time: number;
  gifs: number;
  profile_pictures: number;
  link_previews: number;
}

interface AlertRow {
  id: number;
  kid_id: number;
  type: FamilyAlertType;
  conversation_id: number | null;
  message_id: number | null;
  other_user_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface KeptFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export interface KeptMessage {
  messageId: number;
  conversationId: number;
  body: string;
  keyVersion: number | null;
  files: KeptFile[];
  deletedAt: string;
}

/** Parents of the kids in a conversation who aren't in it themselves. */
export function guardianIds(db: Db, conversationId: number): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT f.parent_id FROM family_links f JOIN conversation_members m ON m.user_id = f.kid_id
         WHERE m.conversation_id = ? AND f.parent_id NOT IN (SELECT user_id FROM conversation_members WHERE conversation_id = ?)
         ORDER BY f.parent_id`,
      )
      .all(conversationId, conversationId) as { parent_id: number }[]
  ).map((r) => r.parent_id);
}

/** Is a minute of the day inside a span that may run past midnight? */
const inSpan = (from: string, until: string, minute: number): boolean => {
  const a = toMinute(from);
  const b = toMinute(until);
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
};

export class FamilyService {
  /** Whether each online kid could chat at the last tick, to tell them when that changes. */
  private lastAllowed = new Map<number, boolean>();
  /** The day (kid's time zone) each kid's parents were last told the daily time ran out. */
  private limitAlerted = new Map<number, string>();
  /** The kid's LootDen play limits, when LootDen is linked (set by the LootDen link). */
  playLimits: (kidId: number, at: Date) => LootdenKidLimits | null = () => null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chatPause: ChatPause = () => null;
  /** Run when an account becomes a kid account (or gets another parent), before any key is shared. */
  onLinked: ((kidId: number) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly options: { publicUrl: string },
    /** Replaced in tests. */
    private readonly post: WebhookPost = defaultPost,
  ) {}

  /** Counts minutes for kids with the app open, once a minute. */
  start(): void {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ---- Links ------------------------------------------------------------------------

  parentsOf(kidId: number): number[] {
    return (this.db.prepare("SELECT parent_id FROM family_links WHERE kid_id = ? ORDER BY created_at, parent_id").all(kidId) as { parent_id: number }[]).map(
      (r) => r.parent_id,
    );
  }

  kidsOf(parentId: number): number[] {
    return (this.db.prepare("SELECT kid_id FROM family_links WHERE parent_id = ? ORDER BY created_at, kid_id").all(parentId) as { kid_id: number }[]).map(
      (r) => r.kid_id,
    );
  }

  isKid(userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM family_links WHERE kid_id = ?").get(userId);
  }

  isParentOf(parentId: number, kidId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM family_links WHERE kid_id = ? AND parent_id = ?").get(kidId, parentId);
  }

  /** Throws unless `parentId` is one of the kid's parents. */
  requireParent(parentId: number, kidId: number): void {
    if (!this.isParentOf(parentId, kidId)) throw new HttpError(404, "That isn't one of your kids");
  }

  /** A one-time code a kid types to link their account to this parent. */
  createCode(parentId: number): FamilyLinkCode {
    const parent = this.users.byId(parentId)!;
    if (parent.isKid) throw new HttpError(403, "Kid accounts can't link other accounts");
    if (!parent.publicKey) throw new HttpError(409, "Turn on end-to-end encryption first, so your kid's chats can be encrypted to you too");
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const expiresAt = new Date(Date.now() + CODE_HOURS * 3600_000).toISOString();
    this.db.prepare("DELETE FROM family_link_codes WHERE parent_id = ? OR expires_at < ?").run(parentId, now());
    this.db.prepare("INSERT INTO family_link_codes (code, parent_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(code, parentId, expiresAt, now());
    return { code, expiresAt };
  }

  /** The kid's side: links their account to whoever made the code. Returns the parent's id. */
  redeem(kidId: number, code: unknown, timezone: unknown): number {
    const clean = typeof code === "string" ? code.replace(/[\s-]/g, "").toUpperCase() : "";
    const row = this.db.prepare("SELECT parent_id, expires_at FROM family_link_codes WHERE code = ?").get(clean) as
      | { parent_id: number; expires_at: string }
      | undefined;
    if (!row || row.expires_at < now()) throw new HttpError(404, "That code doesn't work. Ask your parent for a new one.");
    this.link(row.parent_id, kidId, timezone);
    this.db.prepare("DELETE FROM family_link_codes WHERE code = ?").run(clean);
    return row.parent_id;
  }

  link(parentId: number, kidId: number, timezone?: unknown): void {
    const parent = this.users.byId(parentId);
    const kid = this.users.byId(kidId);
    if (!parent || !kid) throw new HttpError(404, "No such account");
    if (parentId === kidId) throw new HttpError(400, "You can't be your own parent");
    if (parent.isKid) throw new HttpError(409, `${parent.displayName} is a kid account`);
    if (this.kidsOf(kidId).length) throw new HttpError(409, `${kid.displayName} is a parent, so it can't be a kid account`);
    if (kid.isSuperAdmin) throw new HttpError(409, "A super admin can't be a kid account");
    if (!parent.publicKey) throw new HttpError(409, `${parent.displayName} has to turn on end-to-end encryption first`);
    if (this.isParentOf(parentId, kidId)) return;
    if (this.parentsOf(kidId).length >= MAX_PARENTS) throw new HttpError(409, `A kid can have up to ${MAX_PARENTS} parents linked`);
    tx(this.db, () => {
      this.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kidId, parentId, now());
      this.db
        .prepare("INSERT OR IGNORE INTO kid_rules (kid_id, timezone) VALUES (?, ?)")
        .run(kidId, isTimeZone(timezone) ? timezone : DEFAULT_RULES.timezone);
    });
    for (const fn of this.onLinked) fn(kidId);
  }

  /**
   * Unlinks one parent. When the last one goes the account stops being a kid account: its rules,
   * open alerts and kept copies are removed. Returns kept files to delete from disk.
   */
  unlink(parentId: number, kidId: number): string[] {
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM family_links WHERE kid_id = ? AND parent_id = ?").run(kidId, parentId);
      if (this.parentsOf(kidId).length) return [];
      const files = this.kept(kidId).flatMap((k) => k.files.map((f) => f.id));
      this.db.prepare("DELETE FROM kid_rules WHERE kid_id = ?").run(kidId);
      this.db.prepare("DELETE FROM kid_usage WHERE kid_id = ?").run(kidId);
      this.db.prepare("DELETE FROM kid_deleted_messages WHERE kid_id = ?").run(kidId);
      this.db.prepare("DELETE FROM family_alerts WHERE kid_id = ?").run(kidId);
      this.db.prepare("UPDATE friendships SET held_for_parent = 0 WHERE user_a = ? OR user_b = ?").run(kidId, kidId);
      this.lastAllowed.delete(kidId);
      this.limitAlerted.delete(kidId);
      return files;
    });
  }

  // ---- Rules and time ------------------------------------------------------------------

  /** The Den Duty link plugs in here, so its time-outs and chores can pause a kid's chat. */
  setChatPause(fn: ChatPause): void {
    this.chatPause = fn;
  }

  rules(kidId: number): KidRules {
    const r = this.db.prepare("SELECT * FROM kid_rules WHERE kid_id = ?").get(kidId) as RulesRow | undefined;
    if (!r) return { ...DEFAULT_RULES };
    let words: string[] = [];
    try {
      words = JSON.parse(r.blocked_words) as string[];
    } catch {
      /* keep none */
    }
    return {
      profanityFilter: !!r.profanity_filter,
      blockedWords: words,
      approveFriends: !!r.approve_friends,
      canJoinServers: !!r.can_join_servers,
      allowedFrom: r.allowed_from,
      allowedUntil: r.allowed_until,
      dailyMinutes: r.daily_minutes,
      timezone: r.timezone,
      choresFirst: !!r.chores_first,
      lootdenBedtime: !!r.lootden_bedtime,
      lootdenPlayTime: !!r.lootden_play_time,
      gifs: !!r.gifs,
      profilePictures: !!r.profile_pictures,
      linkPreviews: !!r.link_previews,
    };
  }

  setRules(kidId: number, patch: Partial<Record<keyof KidRules, unknown>>): KidRules {
    const next = { ...this.rules(kidId) };
    const bool = (k: "profanityFilter" | "approveFriends" | "canJoinServers" | "choresFirst" | "lootdenBedtime" | "lootdenPlayTime" | "gifs" | "profilePictures" | "linkPreviews") => {
      if (patch[k] === undefined) return;
      if (typeof patch[k] !== "boolean") throw new HttpError(400, `${k} is true or false`);
      next[k] = patch[k];
    };
    bool("profanityFilter");
    bool("approveFriends");
    bool("canJoinServers");
    bool("choresFirst");
    bool("lootdenBedtime");
    bool("lootdenPlayTime");
    bool("gifs");
    bool("profilePictures");
    bool("linkPreviews");
    if (patch.blockedWords !== undefined) {
      if (!Array.isArray(patch.blockedWords) || patch.blockedWords.length > 200) throw new HttpError(400, "blockedWords is a list of up to 200 words");
      const words = patch.blockedWords.map((w) => (typeof w === "string" ? w.trim().toLowerCase() : ""));
      if (words.some((w) => !w || w.length > 40)) throw new HttpError(400, "Each blocked word is 1 to 40 characters");
      next.blockedWords = [...new Set(words)];
    }
    if (patch.allowedFrom !== undefined || patch.allowedUntil !== undefined) {
      const from = patch.allowedFrom === undefined ? next.allowedFrom : patch.allowedFrom;
      const until = patch.allowedUntil === undefined ? next.allowedUntil : patch.allowedUntil;
      if (from === null && until === null) {
        next.allowedFrom = next.allowedUntil = null;
      } else {
        if (typeof from !== "string" || typeof until !== "string" || !HHMM.test(from) || !HHMM.test(until)) {
          throw new HttpError(400, "Chat hours need a start and an end, like 07:00 and 20:30");
        }
        if (from === until) throw new HttpError(400, "Chat hours can't start and end at the same time");
        next.allowedFrom = from;
        next.allowedUntil = until;
      }
    }
    if (patch.dailyMinutes !== undefined) {
      const n = patch.dailyMinutes;
      if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 5 || n > 1440)) {
        throw new HttpError(400, "A daily limit is 5 to 1440 minutes, or none");
      }
      next.dailyMinutes = n;
    }
    if (patch.timezone !== undefined) {
      if (!isTimeZone(patch.timezone)) throw new HttpError(400, "That isn't a time zone");
      next.timezone = patch.timezone;
    }
    this.db
      .prepare(
        `UPDATE kid_rules SET profanity_filter = ?, blocked_words = ?, approve_friends = ?, can_join_servers = ?,
         allowed_from = ?, allowed_until = ?, daily_minutes = ?, timezone = ?, chores_first = ?, lootden_bedtime = ?, lootden_play_time = ?, gifs = ?, profile_pictures = ?, link_previews = ? WHERE kid_id = ?`,
      )
      .run(
        next.profanityFilter ? 1 : 0,
        JSON.stringify(next.blockedWords),
        next.approveFriends ? 1 : 0,
        next.canJoinServers ? 1 : 0,
        next.allowedFrom,
        next.allowedUntil,
        next.dailyMinutes,
        next.timezone,
        next.choresFirst ? 1 : 0,
        next.lootdenBedtime ? 1 : 0,
        next.lootdenPlayTime ? 1 : 0,
        next.gifs ? 1 : 0,
        next.profilePictures ? 1 : 0,
        next.linkPreviews ? 1 : 0,
        kidId,
      );
    return next;
  }

  /** Whether the kid's family filter blocks some text (always false with the filter off). */
  blocksText(kidId: number, text: string): boolean {
    const rules = this.rules(kidId);
    return rules.profanityFilter && findBlockedWords(text, rules.blockedWords).length > 0;
  }

  status(kidId: number, at = new Date()): KidStatus {
    return this.evaluate(kidId, at).status;
  }

  /** The kid's status, and which rule stops them chatting, if one does. */
  private evaluate(kidId: number, at: Date): { status: KidStatus; stoppedBy: "paused" | "hours" | "bedtime" | "daily" | null } {
    const rules = this.rules(kidId);
    const { day, minute } = localTime(rules.timezone, at);
    const used = this.db.prepare("SELECT minutes FROM kid_usage WHERE kid_id = ? AND day = ?").get(kidId, day) as { minutes: number } | undefined;
    const minutesToday = used?.minutes ?? 0;
    // Den Duty first: a time-out that pauses chat, or chores still to do.
    const paused = this.chatPause(kidId, rules.choresFirst, rules.timezone);
    const lootden = this.playLimits(kidId, at);
    // Chat and games share one budget: the kid's own daily time, else LootDen's.
    const shared = rules.lootdenPlayTime && lootden !== null;
    const gameMinutesToday = shared ? lootden.playedMinutes : 0;
    const limitMinutes = rules.dailyMinutes ?? (shared ? lootden.dailyMinutes : null);
    const base = { minutesToday, gameMinutesToday, limitMinutes, lootden };
    const stop = (stoppedBy: "paused" | "hours" | "bedtime" | "daily", reason: string) => ({ status: { ...base, allowedNow: false, reason }, stoppedBy });
    if (paused) return stop("paused", paused);
    if (rules.allowedFrom && rules.allowedUntil && !inSpan(rules.allowedFrom, rules.allowedUntil, minute)) {
      return stop("hours", `Chat time is ${rules.allowedFrom} to ${rules.allowedUntil}.`);
    }
    const bedtime = rules.lootdenBedtime ? lootden?.bedtime : null;
    if (bedtime && inSpan(bedtime.from, bedtime.to, localTime(lootden!.timezone, at).minute)) {
      return stop("bedtime", `It's bedtime until ${bedtime.to}. Chat's back in the morning!`);
    }
    if (limitMinutes !== null && minutesToday + gameMinutesToday >= limitMinutes) {
      return stop(
        "daily",
        gameMinutesToday ? `You've used today's ${limitMinutes} minutes of chat and games. See you tomorrow!` : `You've used today's ${limitMinutes} minutes. See you tomorrow!`,
      );
    }
    return { status: { ...base, allowedNow: true, reason: null }, stoppedBy: null };
  }

  /** Throws when a kid can't chat right now. Adults always can. */
  assertCanChat(userId: number): void {
    if (!this.isKid(userId)) return;
    const s = this.status(userId);
    if (!s.allowedNow) throw new HttpError(403, s.reason ?? "Chat time is over for now");
  }

  /** Adds a minute for every kid with the app open, and tells kids when they can or can't chat. */
  tick(at = new Date()): void {
    const kids = (this.db.prepare("SELECT kid_id FROM kid_rules").all() as { kid_id: number }[]).map((r) => r.kid_id);
    for (const kid of kids) {
      if (!this.gateway.isOnline(kid)) {
        this.lastAllowed.delete(kid);
        continue;
      }
      const rules = this.rules(kid);
      const { day } = localTime(rules.timezone, at);
      this.db
        .prepare("INSERT INTO kid_usage (kid_id, day, minutes) VALUES (?, ?, 1) ON CONFLICT (kid_id, day) DO UPDATE SET minutes = minutes + 1")
        .run(kid, day);
      const { status: s, stoppedBy } = this.evaluate(kid, at);
      // Once a day, when the daily time (chat, plus games when they share it) runs out.
      if (stoppedBy === "daily" && this.limitAlerted.get(kid) !== day) {
        this.limitAlerted.set(kid, day);
        this.alert(kid, "time_limit", {});
      }
      if (this.lastAllowed.get(kid) !== s.allowedNow) {
        if (this.lastAllowed.has(kid)) this.pushFamily([kid]);
        this.lastAllowed.set(kid, s.allowedNow);
      }
    }
  }

  // ---- Friends ------------------------------------------------------------------------

  /**
   * After two people became friends (or tried to): tells the kids' parents. A held friendship
   * gets a "contact" alert per kid whose parents have to approve it.
   */
  friendsChanged(a: number, b: number): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    const f = this.db.prepare("SELECT accepted_at, held_for_parent FROM friendships WHERE user_a = ? AND user_b = ?").get(x, y) as
      | { accepted_at: string | null; held_for_parent: number }
      | undefined;
    if (!f?.accepted_at) return;
    for (const [kid, other] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!this.isKid(kid) || this.isParentOf(other, kid)) continue;
      const seen = this.db.prepare("SELECT 1 FROM family_alerts WHERE kid_id = ? AND type = 'contact' AND other_user_id = ?").get(kid, other);
      if (!seen) this.alert(kid, "contact", { otherUserId: other });
    }
  }

  /** A parent says yes to a held friendship. It opens once every kid in it has a yes. */
  approveContact(parentId: number, kidId: number, otherId: number): boolean {
    this.requireParent(parentId, kidId);
    const [x, y] = kidId < otherId ? [kidId, otherId] : [otherId, kidId];
    const f = this.db.prepare("SELECT held_for_parent FROM friendships WHERE user_a = ? AND user_b = ? AND accepted_at IS NOT NULL").get(x, y) as
      | { held_for_parent: number }
      | undefined;
    this.resolveWhere(parentId, "kid_id = ? AND type = 'contact' AND other_user_id = ?", kidId, otherId);
    if (!f) throw new HttpError(404, "They aren't waiting to be friends any more");
    const stillWaiting = this.db
      .prepare(
        `SELECT 1 FROM family_alerts WHERE type = 'contact' AND resolved_at IS NULL AND kid_id = ? AND other_user_id = ?
         AND EXISTS (SELECT 1 FROM kid_rules WHERE kid_id = ? AND approve_friends = 1)`,
      )
      .get(otherId, kidId, otherId);
    if (!stillWaiting) this.db.prepare("UPDATE friendships SET held_for_parent = 0 WHERE user_a = ? AND user_b = ?").run(x, y);
    return !stillWaiting;
  }

  /** Closes "contact" alerts about this friend (declined or removed). */
  resolveContact(parentId: number, kidId: number, otherId: number): void {
    this.resolveWhere(parentId, "kid_id = ? AND type = 'contact' AND other_user_id = ?", kidId, otherId);
  }

  // ---- Alerts ---------------------------------------------------------------------------

  private alertRow(id: number): AlertRow | undefined {
    return this.db.prepare("SELECT * FROM family_alerts WHERE id = ?").get(id) as AlertRow | undefined;
  }

  private toAlert(r: AlertRow): FamilyAlert {
    const user = (id: number | null): PublicUser | null => {
      const u = id === null ? undefined : this.users.byId(id);
      return u ? toPublic(u) : null;
    };
    return {
      id: r.id,
      kid: user(r.kid_id)!,
      type: r.type,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      other: user(r.other_user_id),
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    };
  }

  /**
   * Raises an alert and tells the kid's parents (in the app, and on their webhooks). An open
   * alert of the same kind about the same thing isn't repeated. Returns the alert.
   */
  alert(kidId: number, type: FamilyAlertType, about: { conversationId?: number; messageId?: number; otherUserId?: number }): FamilyAlert | null {
    const parents = this.parentsOf(kidId);
    if (!parents.length) return null;
    if (type !== "deleted") {
      const open = this.db
        .prepare(
          `SELECT id FROM family_alerts WHERE kid_id = ? AND type = ? AND resolved_at IS NULL
           AND conversation_id IS ? AND other_user_id IS ?`,
        )
        .get(kidId, type, about.conversationId ?? null, about.otherUserId ?? null) as { id: number } | undefined;
      if (open) return this.toAlert(this.alertRow(open.id)!);
    }
    const res = this.db
      .prepare("INSERT INTO family_alerts (kid_id, type, conversation_id, message_id, other_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kidId, type, about.conversationId ?? null, about.messageId ?? null, about.otherUserId ?? null, now());
    const alert = this.toAlert(this.alertRow(Number(res.lastInsertRowid))!);
    this.gateway.send(parents, { type: "family.alert", alert });
    void this.sendWebhooks(parents, alert);
    return alert;
  }

  /** What an alert says, without any message content. */
  describe(a: FamilyAlert): string {
    const kid = a.kid.displayName;
    switch (a.type) {
      case "deleted":
        return `${kid} deleted a message. A copy is kept for you.`;
      case "profanity":
        return `${kid}'s app caught a filtered word in a chat.`;
      case "contact":
        return this.isHeld(a.kid.id, a.other?.id) ? `${kid} and ${a.other?.displayName ?? "someone"} want to be friends.` : `${kid} has a new friend: ${a.other?.displayName ?? "someone"}.`;
      case "time_limit":
        return `${kid} used today's chat time.`;
      case "help":
        return `${kid} asked you to look at a chat.`;
      case "profile":
        return `${kid} changed their profile.`;
    }
  }

  private isHeld(a: number, b: number | undefined): boolean {
    if (b === undefined) return false;
    const [x, y] = a < b ? [a, b] : [b, a];
    return !!this.db.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ? AND held_for_parent = 1").get(x, y);
  }

  private async sendWebhooks(parents: number[], alert: FamilyAlert): Promise<void> {
    const text = this.describe(alert);
    for (const p of parents) {
      const url = this.webhook(p);
      if (!url) continue;
      // Shaped so ntfy (JSON publishing), Apprise and Home Assistant can all take it as is.
      const body = JSON.stringify({
        app: "dendrop",
        event: "family.alert",
        type: alert.type,
        kid: alert.kid.username,
        title: "Dendrop family alert",
        message: text,
        body: text,
        at: alert.createdAt,
        url: this.options.publicUrl || undefined,
      });
      try {
        await this.post(url, body);
      } catch {
        /* a webhook that's down shouldn't stop anything */
      }
    }
  }

  webhook(parentId: number): string | null {
    return (this.db.prepare("SELECT family_webhook FROM users WHERE id = ?").get(parentId) as { family_webhook: string | null } | undefined)?.family_webhook ?? null;
  }

  setWebhook(parentId: number, url: unknown): string | null {
    if (url === null || url === "") {
      this.db.prepare("UPDATE users SET family_webhook = NULL WHERE id = ?").run(parentId);
      return null;
    }
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      throw new HttpError(400, "That isn't a web address");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || String(url).length > 500) throw new HttpError(400, "Webhooks are http or https addresses");
    this.db.prepare("UPDATE users SET family_webhook = ? WHERE id = ?").run(u.toString(), parentId);
    return u.toString();
  }

  /** Alerts about a parent's kids, open ones first, newest first. */
  alertsFor(parentId: number): FamilyAlert[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM family_alerts a JOIN family_links f ON f.kid_id = a.kid_id AND f.parent_id = ?
         ORDER BY a.resolved_at IS NOT NULL, a.id DESC LIMIT 200`,
      )
      .all(parentId) as unknown as AlertRow[];
    return rows.map((r) => this.toAlert(r));
  }

  /** The alert, if `parentId` is a parent of its kid. */
  alertFor(parentId: number, alertId: number): FamilyAlert {
    const r = this.alertRow(alertId);
    if (!r || !this.isParentOf(parentId, r.kid_id)) throw new HttpError(404, "No such alert");
    return this.toAlert(r);
  }

  /**
   * The conversation a parent may read through this alert. Only while it's open: marking it
   * done ends the access.
   */
  viewable(parentId: number, alertId: number): { alert: FamilyAlert; conversationId: number } {
    const alert = this.alertFor(parentId, alertId);
    if (alert.resolvedAt) throw new HttpError(410, "This alert is done, so the chat is closed again");
    if (alert.conversationId === null) throw new HttpError(404, "This alert isn't about a chat");
    return { alert, conversationId: alert.conversationId };
  }

  /** Writes down that a parent looked, at most once every ten minutes per alert. */
  audit(parentId: number, alert: FamilyAlert): void {
    const recent = this.db
      .prepare("SELECT 1 FROM family_audit WHERE parent_id = ? AND alert_id = ? AND created_at > ?")
      .get(parentId, alert.id, new Date(Date.now() - 10 * 60_000).toISOString());
    if (recent) return;
    this.db
      .prepare("INSERT INTO family_audit (kid_id, parent_id, conversation_id, alert_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(alert.kid.id, parentId, alert.conversationId, alert.id, now());
    this.pushFamily([alert.kid.id]);
  }

  /** Marks an alert done. A deleted message's kept copy goes with it. Returns files to delete. */
  resolve(parentId: number, alertId: number): string[] {
    const alert = this.alertFor(parentId, alertId);
    if (alert.resolvedAt) return [];
    if (alert.type === "contact" && this.isHeld(alert.kid.id, alert.other?.id)) throw new HttpError(409, "Approve or decline this friend instead");
    return this.resolveWhere(parentId, "id = ?", alertId);
  }

  private resolveWhere(parentId: number, where: string, ...args: (number | string)[]): string[] {
    return tx(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM family_alerts WHERE resolved_at IS NULL AND ${where}`).all(...args) as unknown as AlertRow[];
      const files: string[] = [];
      for (const r of rows) {
        this.db.prepare("UPDATE family_alerts SET resolved_at = ?, resolved_by = ? WHERE id = ?").run(now(), parentId, r.id);
        if (r.type === "deleted" && r.message_id !== null) {
          const k = this.keptMessage(r.message_id);
          if (k) files.push(...k.files.map((f) => f.id));
          this.db.prepare("DELETE FROM kid_deleted_messages WHERE message_id = ?").run(r.message_id);
        }
      }
      return files;
    });
  }

  // ---- Deleted messages -------------------------------------------------------------------

  /**
   * Before a kid deletes their own message: keeps a copy for their parents (the body as it is,
   * ciphertext included, and its files). Returns the ids of files that must stay on disk.
   */
  keepBeforeDelete(userId: number, messageId: number): Set<string> {
    if (!this.isKid(userId)) return new Set();
    const m = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
      | { id: number; conversation_id: number; author_id: number; body: string; key_version: number | null; deleted_at: string | null; created_at: string }
      | undefined;
    if (!m || m.author_id !== userId || m.deleted_at) return new Set();
    const files = this.db.prepare("SELECT id, name, size, content_type FROM attachments WHERE message_id = ? ORDER BY rowid").all(messageId) as {
      id: string;
      name: string;
      size: number;
      content_type: string;
    }[];
    const kept: KeptFile[] = files.map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.content_type }));
    this.db
      .prepare(
        `INSERT OR REPLACE INTO kid_deleted_messages (message_id, kid_id, conversation_id, body, key_version, files, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, userId, m.conversation_id, m.body, m.key_version, JSON.stringify(kept), m.created_at, now());
    return new Set(kept.map((f) => f.id));
  }

  /** After the delete went through: tells the parents. If it failed, drops the copy. */
  afterDelete(userId: number, messageId: number, ok: boolean): void {
    const k = this.keptMessage(messageId);
    if (!k) return;
    if (!ok) {
      this.db.prepare("DELETE FROM kid_deleted_messages WHERE message_id = ?").run(messageId);
      return;
    }
    this.alert(userId, "deleted", { conversationId: k.conversationId, messageId });
  }

  keptMessage(messageId: number): KeptMessage | undefined {
    const r = this.db.prepare("SELECT * FROM kid_deleted_messages WHERE message_id = ?").get(messageId) as
      | { message_id: number; conversation_id: number; body: string; key_version: number | null; files: string; deleted_at: string }
      | undefined;
    return r && { messageId: r.message_id, conversationId: r.conversation_id, body: r.body, keyVersion: r.key_version, files: JSON.parse(r.files) as KeptFile[], deletedAt: r.deleted_at };
  }

  kept(kidId: number, conversationId?: number): KeptMessage[] {
    const rows = (
      conversationId === undefined
        ? this.db.prepare("SELECT message_id FROM kid_deleted_messages WHERE kid_id = ?").all(kidId)
        : this.db.prepare("SELECT message_id FROM kid_deleted_messages WHERE kid_id = ? AND conversation_id = ?").all(kidId, conversationId)
    ) as { message_id: number }[];
    return rows.map((r) => this.keptMessage(r.message_id)!);
  }

  // ---- What each person sees ---------------------------------------------------------------

  kidView(kidId: number): FamilyKid {
    const link = this.db.prepare("SELECT MIN(created_at) AS t FROM family_links WHERE kid_id = ?").get(kidId) as { t: string };
    return {
      user: toPublic(this.users.byId(kidId)!),
      parents: this.parentsOf(kidId).map((p) => toPublic(this.users.byId(p)!)),
      rules: this.rules(kidId),
      status: this.status(kidId),
      linkedAt: link.t,
      managed: this.users.byId(kidId)!.managedBy !== null,
    };
  }

  info(userId: number): FamilyInfo {
    const kid = this.isKid(userId);
    const audit: FamilyAuditEntry[] = kid
      ? (
          this.db.prepare("SELECT * FROM family_audit WHERE kid_id = ? ORDER BY id DESC LIMIT 50").all(userId) as {
            parent_id: number;
            kid_id: number;
            conversation_id: number | null;
            created_at: string;
          }[]
        ).flatMap((r) => {
          const p = this.users.byId(r.parent_id);
          return p ? [{ parent: toPublic(p), kidId: r.kid_id, conversationId: r.conversation_id, createdAt: r.created_at }] : [];
        })
      : [];
    return {
      parents: this.parentsOf(userId).map((p) => toPublic(this.users.byId(p)!)),
      rules: kid ? this.rules(userId) : null,
      status: kid ? this.status(userId) : null,
      audit,
      kids: this.kidsOf(userId).map((k) => this.kidView(k)),
      webhookUrl: this.webhook(userId),
    };
  }

  /** Sends each person (and, for kids, their parents) their own view of the family. */
  pushFamily(userIds: number[]): void {
    const everyone = new Set(userIds);
    for (const u of userIds) for (const p of this.parentsOf(u)) everyone.add(p);
    for (const u of everyone) this.gateway.send([u], { type: "family.updated", family: this.info(u) });
  }
}
