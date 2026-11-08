import {
  AUTOMOD_LIMITS,
  findBlockedWords,
  type AutomodAction,
  type AutomodEvent,
  type AutomodRuleBase,
  type AutomodRuleKind,
  type AutomodSettings,
  type ServerRole,
  type ServerTimeout,
} from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import { isModerator, ServerRepo } from "./servers.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

const ROLES: ServerRole[] = ["owner", "admin", "member"];
const ACTIONS: AutomodAction[] = ["block", "alert", "timeout"];
export const RULES: AutomodRuleKind[] = ["words", "spam", "links", "newAccounts"];
/** The same message more than maxDuplicates times in this window counts as spam. */
const DUPLICATE_WINDOW_MS = 5 * 60_000;

const base = (actions: AutomodAction[]): AutomodRuleBase => ({
  enabled: false,
  actions,
  timeoutMinutes: 10,
  exemptRoles: ["owner", "admin"],
  exemptRoleIds: [],
  exemptChannelIds: [],
});

/** Every rule starts off, so a server only gets automod when a moderator turns it on. */
export function defaultAutomod(): AutomodSettings {
  return {
    words: { ...base(["block"]), useBuiltinList: true, words: [] },
    spam: { ...base(["block", "alert"]), maxMessages: 5, perSeconds: 5, maxDuplicates: 3, maxMentions: 5 },
    links: { ...base(["block"]), allowedDomains: [] },
    newAccounts: { ...base(["block"]), minAccountAgeHours: 24, minMemberMinutes: 10 },
  };
}

// ---- Links --------------------------------------------------------------------------

/** Common top-level domains, so "example.com" counts as a link without https://, but "notes.txt" doesn't. */
const TLDS =
  "com|net|org|gg|io|co|me|ly|xyz|ru|tk|ml|ga|cf|gq|app|dev|tv|info|biz|link|site|online|club|shop|store|top|live|fun|us|uk|de|fr|nl|ca|au|in|cn|br|pl|it|es|be|ch|se|no|eu|cc|to|sh|so|gl|gift|click";
const LINK_RE = new RegExp(`(?:\\bhttps?:\\/\\/|\\bwww\\.)[^\\s<>"']+|\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:[/?#][^\\s<>"']*)?`, "gi");
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hostOf = (link: string): string =>
  link
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#:]/)[0]!
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");

/** The hosts of the links in some text ("Check https://x.com/a and y.gg" → ["x.com", "y.gg"]). Email addresses aren't links. */
export function linkHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index && text[m.index - 1] === "@") continue;
    // Sentence punctuation after a link isn't part of it: "see foo.org, then".
    const host = hostOf(m[0].replace(/[.,;:!?)\]}'"]+$/, ""));
    if (host) out.push(host);
  }
  return out;
}

/** "10 minutes", "2 hours", "1 day": roughly how long until a time. */
export function minutesLeft(until: string): string {
  const m = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
  const [n, unit] = m < 120 ? [m, "minute"] : m < 48 * 60 ? [Math.round(m / 60), "hour"] : [Math.round(m / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const allowedHost = (host: string, allowed: string[]): boolean => allowed.some((d) => host === d || host.endsWith(`.${d}`));

// ---- Checking settings sent by a moderator ----------------------------------------------

function int(v: unknown, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} has to be a whole number from ${min} to ${max}`);
  return n;
}

function list<T>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${what} has to be a list`);
  return v as T[];
}

export function cleanWord(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "Blocked words have to be text");
  const w = raw.trim().toLowerCase();
  if (!w) return "";
  if (w.length > AUTOMOD_LIMITS.wordLength) throw new HttpError(400, `Blocked words can be up to ${AUTOMOD_LIMITS.wordLength} characters`);
  if (!/^[\p{L}\p{N}@$!|+.'-]+\*?$/u.test(w)) throw new HttpError(400, `"${raw.trim()}" isn't one word. Add words one at a time (a * at the end matches anything starting with it)`);
  return w;
}

export function cleanDomain(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "Allowed sites have to be text");
  const d = hostOf(raw.trim());
  if (!d) return "";
  if (!DOMAIN_RE.test(d)) throw new HttpError(400, `"${raw.trim()}" isn't a web address like example.com`);
  return d;
}

interface EventRow {
  id: number;
  server_id: number;
  user_id: number | null;
  channel_id: number | null;
  rule: AutomodRuleKind;
  actions: string;
  reason: string;
  excerpt: string;
  created_at: string;
}

/** A rule that a message broke, and why. */
interface Hit {
  rule: AutomodRuleKind;
  reason: string;
}

/**
 * Automod for chat servers. Channels aren't end-to-end encrypted, so the server can read what
 * is posted and check it before it's saved: blocked words (the kid-safe filter's engine),
 * flooding and mention spam, links, and brand new accounts. Each rule has its own actions and
 * exemptions. Timeouts stop someone posting in, or joining the voice of, one server for a while.
 *
 * Encrypted DMs and group chats are never touched: the server can't read them.
 */
export class AutomodService {
  private readonly servers: ServerRepo;
  /** Called when someone is timed out, so voice can drop them. */
  readonly onTimeout: ((serverId: number, userId: number) => void)[] = [];

  /** Hosts the link rule always lets through (GIF links while GIFs are on). */
  extraAllowedHosts: () => string[] = () => [];

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly options: { publicUrl: string },
  ) {
    this.servers = new ServerRepo(db, users);
  }

  // ---- Settings ------------------------------------------------------------------

  private channelIds(serverId: number): Set<number> {
    return new Set((this.db.prepare("SELECT id FROM server_channels WHERE server_id = ?").all(serverId) as { id: number }[]).map((r) => r.id));
  }

  private roleIds(serverId: number): Set<number> {
    return new Set((this.db.prepare("SELECT id FROM server_roles WHERE server_id = ?").all(serverId) as { id: number }[]).map((r) => r.id));
  }

  /** A server's rules. Channels and custom roles deleted since they were saved are left out. */
  settings(serverId: number): AutomodSettings {
    const row = this.db.prepare("SELECT settings FROM server_automod WHERE server_id = ?").get(serverId) as { settings: string } | undefined;
    const saved = row ? (JSON.parse(row.settings) as Partial<AutomodSettings>) : {};
    const out = defaultAutomod();
    const channels = this.channelIds(serverId);
    const roles = this.roleIds(serverId);
    for (const k of RULES) {
      const rule = { ...out[k], ...(saved[k] ?? {}) } as AutomodRuleBase;
      rule.exemptChannelIds = rule.exemptChannelIds.filter((id) => channels.has(id));
      rule.exemptRoleIds = (rule.exemptRoleIds ?? []).filter((id) => roles.has(id));
      (out as unknown as Record<string, AutomodRuleBase>)[k] = rule;
    }
    return out;
  }

  /** Changes some rules: { words?: {...}, spam?: {...} }. Fields left out stay as they are. */
  update(serverId: number, input: unknown): AutomodSettings {
    if (!input || typeof input !== "object") throw new HttpError(400, "Send the automod rules to change");
    const patch = input as Record<string, unknown>;
    const current = this.settings(serverId);
    const channels = this.channelIds(serverId);
    const roleIds = this.roleIds(serverId);
    for (const key of Object.keys(patch)) if (!RULES.includes(key as AutomodRuleKind)) throw new HttpError(400, `There's no automod rule called ${key}`);

    for (const k of RULES) {
      const p = patch[k] as Record<string, unknown> | undefined;
      if (p === undefined) continue;
      if (!p || typeof p !== "object") throw new HttpError(400, `${k} has to be an object`);
      const r = current[k] as unknown as Record<string, unknown> & AutomodRuleBase;
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== "boolean") throw new HttpError(400, "enabled is true or false");
        r.enabled = p.enabled;
      }
      if (p.actions !== undefined) {
        const a = [...new Set(list<AutomodAction>(p.actions, "actions"))];
        if (!a.every((x) => ACTIONS.includes(x))) throw new HttpError(400, "Actions are block, alert and timeout");
        r.actions = ACTIONS.filter((x) => a.includes(x));
      }
      if (p.timeoutMinutes !== undefined) r.timeoutMinutes = int(p.timeoutMinutes, 1, AUTOMOD_LIMITS.timeoutMinutes, "The timeout");
      if (p.exemptRoles !== undefined) {
        const roles = list<ServerRole>(p.exemptRoles, "exemptRoles");
        if (!roles.every((x) => ROLES.includes(x))) throw new HttpError(400, "Roles are owner, admin and member");
        r.exemptRoles = ROLES.filter((x) => roles.includes(x));
      }
      if (p.exemptRoleIds !== undefined) {
        const ids = [...new Set(list<unknown>(p.exemptRoleIds, "exemptRoleIds").map(Number))];
        if (!ids.every((id) => roleIds.has(id))) throw new HttpError(400, "Only this server's roles can be exempt");
        r.exemptRoleIds = ids;
      }
      if (p.exemptChannelIds !== undefined) {
        const ids = [...new Set(list<unknown>(p.exemptChannelIds, "exemptChannelIds").map(Number))];
        if (!ids.every((id) => channels.has(id))) throw new HttpError(400, "Only this server's channels can be exempt");
        r.exemptChannelIds = ids;
      }

      if (k === "words") {
        if (p.useBuiltinList !== undefined) {
          if (typeof p.useBuiltinList !== "boolean") throw new HttpError(400, "useBuiltinList is true or false");
          r.useBuiltinList = p.useBuiltinList;
        }
        if (p.words !== undefined) {
          const words = [...new Set(list<unknown>(p.words, "words").map(cleanWord).filter(Boolean))];
          if (words.length > AUTOMOD_LIMITS.words) throw new HttpError(400, `Up to ${AUTOMOD_LIMITS.words} blocked words`);
          r.words = words;
        }
      }
      if (k === "spam") {
        if (p.maxMessages !== undefined) r.maxMessages = int(p.maxMessages, 0, 100, "Messages in a row");
        if (p.perSeconds !== undefined) r.perSeconds = int(p.perSeconds, 1, 600, "The seconds");
        if (p.maxDuplicates !== undefined) r.maxDuplicates = int(p.maxDuplicates, 0, 50, "Repeats");
        if (p.maxMentions !== undefined) r.maxMentions = int(p.maxMentions, 0, 100, "Mentions");
      }
      if (k === "links" && p.allowedDomains !== undefined) {
        const domains = [...new Set(list<unknown>(p.allowedDomains, "allowedDomains").map(cleanDomain).filter(Boolean))];
        if (domains.length > AUTOMOD_LIMITS.domains) throw new HttpError(400, `Up to ${AUTOMOD_LIMITS.domains} allowed sites`);
        r.allowedDomains = domains;
      }
      if (k === "newAccounts") {
        if (p.minAccountAgeHours !== undefined) r.minAccountAgeHours = int(p.minAccountAgeHours, 0, 24 * 365, "Account age");
        if (p.minMemberMinutes !== undefined) r.minMemberMinutes = int(p.minMemberMinutes, 0, 60 * 24 * 30, "Time in the server");
      }
    }
    this.db
      .prepare("INSERT INTO server_automod (server_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at")
      .run(serverId, JSON.stringify(current), now());
    return current;
  }

  // ---- The log -------------------------------------------------------------------

  private toEvent(r: EventRow): AutomodEvent {
    const u = r.user_id === null ? undefined : this.users.byId(r.user_id);
    return {
      id: r.id,
      serverId: r.server_id,
      user: u ? toPublic(u) : null,
      channelId: r.channel_id,
      rule: r.rule,
      actions: JSON.parse(r.actions) as AutomodAction[],
      reason: r.reason,
      excerpt: r.excerpt,
      createdAt: r.created_at,
    };
  }

  /** Newest first, 50 at a time; pass the oldest id you have as `before` for more. */
  events(serverId: number, before?: number): AutomodEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM automod_events WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT 50")
      .all(serverId, before ?? Number.MAX_SAFE_INTEGER) as unknown as EventRow[];
    return rows.map((r) => this.toEvent(r));
  }

  private log(serverId: number, userId: number, channelId: number, hit: Hit, actions: AutomodAction[], body: string): AutomodEvent {
    const excerpt = body.length > 200 ? `${body.slice(0, 199)}…` : body;
    const res = this.db
      .prepare("INSERT INTO automod_events (server_id, user_id, channel_id, rule, actions, reason, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(serverId, userId, channelId, hit.rule, JSON.stringify(actions), hit.reason, excerpt, now());
    const id = Number(res.lastInsertRowid);
    // Keep the newest entries only.
    this.db.prepare("DELETE FROM automod_events WHERE server_id = ? AND id <= ?").run(serverId, id - AUTOMOD_LIMITS.logSize);
    return this.toEvent(this.db.prepare("SELECT * FROM automod_events WHERE id = ?").get(id) as unknown as EventRow);
  }

  // ---- Timeouts ------------------------------------------------------------------

  /** When someone's timeout in a server ends, or null if they aren't timed out. */
  timedOutUntil(serverId: number, userId: number): string | null {
    return this.servers.timedOutUntil(serverId, userId);
  }

  timeouts(serverId: number): ServerTimeout[] {
    const rows = this.db
      .prepare("SELECT user_id, until, reason, set_by FROM server_timeouts WHERE server_id = ? AND until > ? ORDER BY until")
      .all(serverId, now()) as { user_id: number; until: string; reason: string; set_by: number | null }[];
    return rows.flatMap((r) => {
      const u = this.users.byId(r.user_id);
      const by = r.set_by === null ? undefined : this.users.byId(r.set_by);
      return u ? [{ user: toPublic(u), until: r.until, reason: r.reason, by: by ? toPublic(by) : null }] : [];
    });
  }

  /**
   * Times someone out. `by` is null for automod, which only ever makes a timeout longer; a
   * moderator sets it to exactly what they pick. The owner can't be timed out.
   */
  timeout(serverId: number, userId: number, minutes: number, reason: string, by: number | null): string {
    const role = this.servers.role(serverId, userId);
    if (!role) throw new HttpError(404, "They aren't in this server");
    if (role === "owner") throw new HttpError(403, "The owner can't be timed out");
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO server_timeouts (server_id, user_id, until, reason, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, user_id) DO UPDATE SET
           until = CASE WHEN excluded.set_by IS NULL AND until > excluded.until THEN until ELSE excluded.until END,
           reason = excluded.reason, set_by = excluded.set_by`,
      )
      .run(serverId, userId, until, reason.slice(0, 200), by, now());
    this.pushView(serverId, userId);
    for (const fn of this.onTimeout) fn(serverId, userId);
    return this.timedOutUntil(serverId, userId)!;
  }

  clearTimeout(serverId: number, userId: number): boolean {
    const gone = Number(this.db.prepare("DELETE FROM server_timeouts WHERE server_id = ? AND user_id = ?").run(serverId, userId).changes) > 0;
    if (gone) this.pushView(serverId, userId);
    return gone;
  }

  private pushView(serverId: number, userId: number): void {
    const view = this.servers.view(serverId, userId);
    if (view) this.gateway.send([userId], { type: "server.updated", server: view });
  }

  /** Stops someone who is timed out in this server. */
  assertNotTimedOut(serverId: number, userId: number): void {
    const until = this.timedOutUntil(serverId, userId);
    if (until) throw new HttpError(403, `You're timed out in this server for ${minutesLeft(until)}. You can still read.`);
  }

  // ---- Checking messages ---------------------------------------------------------

  private channelOf(conversationId: number): { id: number; server_id: number } | undefined {
    // Threads count as their channel.
    return this.db.prepare("SELECT channel_id AS id, server_id FROM channel_conversations WHERE conversation_id = ?").get(conversationId) as
      | { id: number; server_id: number }
      | undefined;
  }

  /** Checks an edit the same way, except for flooding and new-account rules. */
  checkEdit(messageId: number, user: UserRecord, body: unknown): void {
    const m = this.db.prepare("SELECT conversation_id, author_id FROM messages WHERE id = ?").get(messageId) as
      | { conversation_id: number; author_id: number }
      | undefined;
    // Someone else's message: the edit is refused anyway.
    if (!m || m.author_id !== user.id) return;
    this.checkMessage(m.conversation_id, user, body, true);
  }

  /**
   * Checks a message before it's posted to a conversation. Does nothing outside server channels.
   * Every rule hit is logged; alerts go to the owner and admins; a block or timeout throws, so
   * the message is never saved.
   */
  checkMessage(conversationId: number, user: UserRecord, body: unknown, edit = false): void {
    const channel = this.channelOf(conversationId);
    if (!channel) return;
    const serverId = channel.server_id;
    const role = this.servers.role(serverId, user.id);
    if (!role) return;
    this.assertNotTimedOut(serverId, user.id);

    const text = typeof body === "string" ? body : "";
    const settings = this.settings(serverId);
    const mine = new Set(
      (this.db.prepare("SELECT role_id FROM server_member_roles WHERE server_id = ? AND user_id = ?").all(serverId, user.id) as { role_id: number }[]).map((r) => r.role_id),
    );
    const applies = (r: AutomodRuleBase) =>
      r.enabled && !r.exemptRoles.includes(role) && !r.exemptRoleIds.some((id) => mine.has(id)) && !r.exemptChannelIds.includes(channel.id);

    const hits: Hit[] = [];
    if (applies(settings.newAccounts) && !edit) {
      const hit = this.newAccountHit(serverId, user, settings.newAccounts);
      if (hit) hits.push(hit);
    }
    if (applies(settings.words) && text) {
      const found = findBlockedWords(text, settings.words.words, { builtin: settings.words.useBuiltinList });
      if (found.length) hits.push({ rule: "words", reason: `Blocked word${found.length > 1 ? "s" : ""}: ${[...new Set(found)].join(", ")}` });
    }
    if (applies(settings.spam)) {
      const hit = this.spamHit(serverId, user.id, text, settings.spam, edit);
      if (hit) hits.push(hit);
    }
    if (applies(settings.links) && text) {
      const own = [...(this.options.publicUrl ? [hostOf(this.options.publicUrl)] : []), ...this.extraAllowedHosts()];
      const bad = [...new Set(linkHosts(text).filter((h) => !allowedHost(h, [...settings.links.allowedDomains, ...own])))];
      if (bad.length) hits.push({ rule: "links", reason: `Link${bad.length > 1 ? "s" : ""} to ${bad.join(", ")}` });
    }
    if (!hits.length) return;

    let stop: string | null = null;
    let timedOut = false;
    // Alerts go to everyone who can manage automod: the owner, admins, and custom roles with it.
    const mods = this.servers.memberIds(serverId).filter((id) => this.servers.can(serverId, id, "manageAutomod"));
    for (const hit of hits) {
      const rule = settings[hit.rule];
      // Automod never times out the owner or admins, even when they aren't exempt.
      const actions = rule.actions.filter((a) => a !== "timeout" || !isModerator(role));
      const event = this.log(serverId, user.id, channel.id, hit, actions, text);
      if (actions.includes("alert")) this.gateway.send(mods, { type: "automod.alert", event });
      if (actions.includes("timeout") && !timedOut) {
        const until = this.timeout(serverId, user.id, rule.timeoutMinutes, `Automod: ${hit.reason}`, null);
        timedOut = true;
        stop = `Automod timed you out for ${minutesLeft(until)} because ${this.publicReason(hit)}`;
      }
      if (actions.includes("block") && !stop) stop = `Automod blocked that message because ${this.publicReason(hit)}`;
    }
    if (stop) throw new HttpError(timedOut ? 403 : 400, stop);
  }

  /** What the sender is told. Moderators see the details in the log. */
  private publicReason(hit: Hit): string {
    if (hit.rule === "words") return "it has a word this server blocks";
    if (hit.rule === "links") return "links to that site aren't allowed here";
    if (hit.rule === "newAccounts") return hit.reason.startsWith("New") ? "your account is too new to post here yet" : "you only just joined; try again in a few minutes";
    return `of spam (${hit.reason.charAt(0).toLowerCase()}${hit.reason.slice(1)})`;
  }

  private newAccountHit(serverId: number, user: UserRecord, rule: AutomodSettings["newAccounts"]): Hit | undefined {
    const ageHours = (Date.now() - Date.parse(user.createdAt)) / 3_600_000;
    if (rule.minAccountAgeHours > 0 && ageHours < rule.minAccountAgeHours) {
      return { rule: "newAccounts", reason: `New account: posting opens once it's ${rule.minAccountAgeHours} hours old` };
    }
    const joined = this.db.prepare("SELECT joined_at FROM server_members WHERE server_id = ? AND user_id = ?").get(serverId, user.id) as
      | { joined_at: string }
      | undefined;
    const minutes = joined ? (Date.now() - Date.parse(joined.joined_at)) / 60_000 : Infinity;
    if (rule.minMemberMinutes > 0 && minutes < rule.minMemberMinutes) {
      return { rule: "newAccounts", reason: `Just joined: posting opens ${rule.minMemberMinutes} minutes after joining` };
    }
    return undefined;
  }

  private spamHit(serverId: number, userId: number, text: string, rule: AutomodSettings["spam"], edit: boolean): Hit | undefined {
    if (rule.maxMentions > 0 && text) {
      const names = new Set(this.servers.members(serverId).map((m) => m.user.username.toLowerCase()));
      const mentions = [...text.matchAll(/(?:^|[^\w@])@([\w.-]+)/g)].filter((m) => {
        const n = m[1]!.toLowerCase().replace(/[.-]+$/, "");
        return n === "everyone" || n === "here" || names.has(n);
      }).length;
      if (mentions > rule.maxMentions) return { rule: "spam", reason: `${mentions} mentions in one message` };
    }
    if (edit) return undefined;
    const recent = `SELECT COUNT(*) AS n FROM messages m JOIN channel_conversations c ON c.conversation_id = m.conversation_id
                    WHERE c.server_id = ? AND m.author_id = ? AND m.webhook_name IS NULL AND m.created_at > ?`;
    if (rule.maxMessages > 0) {
      const since = new Date(Date.now() - rule.perSeconds * 1000).toISOString();
      const n = Number((this.db.prepare(recent).get(serverId, userId, since) as { n: number }).n) + 1;
      if (n > rule.maxMessages) return { rule: "spam", reason: `${n} messages in ${rule.perSeconds} seconds` };
    }
    if (rule.maxDuplicates > 0 && text) {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
      const n = Number((this.db.prepare(`${recent} AND lower(m.body) = lower(?)`).get(serverId, userId, since, text.trim()) as { n: number }).n) + 1;
      if (n > rule.maxDuplicates) return { rule: "spam", reason: `The same message ${n} times in 5 minutes` };
    }
    return undefined;
  }
}
