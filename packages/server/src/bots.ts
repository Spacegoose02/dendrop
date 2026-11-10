import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BOT_EVENT_TYPES,
  BOT_LIMITS,
  findBlockedWords,
  isUsername,
  LIMITS,
  type Bot,
  type BotInteraction,
  type InteractionResponse,
  type Message,
  type MessageButton,
  type NewBotToken,
  type ServerEvent,
} from "@dendrop/shared";
import type { AutomodService } from "./automod.js";
import { ConversationRepo, cleanBody } from "./conversations.js";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { FamilyService } from "./family.js";
import { FriendRepo } from "./friends.js";
import type { Gateway } from "./gateway.js";
import type { LootdenFetch } from "./lootden.js";
import type { PushService } from "./push.js";
import { ServerRepo } from "./servers.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

/** Same shape as LootDen's: just enough of fetch, swapped out in tests. */
export type BotFetch = LootdenFetch;

interface BotRow {
  user_id: number;
  owner_id: number;
  description: string;
  token_hash: string;
  signing_secret: string;
  events_url: string | null;
  is_public: number;
  reads_messages: number;
  created_at: string;
  last_seen_at: string | null;
}

interface InteractionRow {
  id: number;
  bot_id: number;
  message_id: number;
  user_id: number;
  button_id: string;
  created_at: string;
  replied_at: string | null;
}

const BOT_EVENTS = new Set<string>(BOT_EVENT_TYPES);
const STYLES = new Set(["primary", "secondary", "success", "danger"]);
const BUTTON_ID = /^[\w.:-]+$/;

const defaultFetch: BotFetch = (url, init) => fetch(url, init);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "");

/** Signs an event POSTed to a bot: HMAC-SHA256 of "<timestamp>.<body>" with its signing secret. */
export function signEvent(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** An http(s) address, or null to clear it. */
function cleanUrl(v: unknown, what: string): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 500) throw new HttpError(400, `${what} has to be an http:// or https:// address`);
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new HttpError(400, `${what} has to be an http:// or https:// address`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `${what} has to be an http:// or https:// address`);
  return u.toString();
}

/** Checks the buttons a bot sends with a message. undefined: leave them; null or []: none. */
export function cleanButtons(v: unknown): MessageButton[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) throw new HttpError(400, "buttons is a list of { id, label, style } or { url, label }");
  if (v.length > BOT_LIMITS.buttons) throw new HttpError(400, `Up to ${BOT_LIMITS.buttons} buttons per message`);
  const seen = new Set<string>();
  return v.map((raw): MessageButton => {
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = clean(b.label);
    if (!label || label.length > BOT_LIMITS.buttonLabel) throw new HttpError(400, `Each button needs a label of up to ${BOT_LIMITS.buttonLabel} characters`);
    const style = b.style === undefined ? "secondary" : b.style;
    if (typeof style !== "string" || !STYLES.has(style)) throw new HttpError(400, "A button's style is primary, secondary, success or danger");
    const out: MessageButton = { label, style: style as MessageButton["style"] };
    if (b.url !== undefined) {
      if (b.id !== undefined) throw new HttpError(400, "A button has an id or a url, not both");
      out.url = cleanUrl(b.url, "A button's url") ?? undefined;
      if (!out.url) throw new HttpError(400, "A button's url has to be an http:// or https:// address");
    } else {
      if (typeof b.id !== "string" || !b.id || b.id.length > BOT_LIMITS.buttonId || !BUTTON_ID.test(b.id)) {
        throw new HttpError(400, `A button's id is up to ${BOT_LIMITS.buttonId} letters, numbers, dots, colons, dashes or underscores`);
      }
      if (seen.has(b.id)) throw new HttpError(400, "Two buttons have the same id");
      seen.add(b.id);
      out.id = b.id;
    }
    if (b.disabled === true) out.disabled = true;
    return out;
  });
}

/**
 * Bots: accounts with no password, made by grown-ups who can run servers, that post into
 * server channels through the bot API with a secret token. A server's owner or admins add a bot
 * the way they'd add a member, and kick it the same way.
 *
 * Bots never get into DMs, group chats or calls (they can't be friends), so nothing end-to-end
 * encrypted ever reaches one. A bot only gets the text of other people's messages when its owner
 * turns on "reads messages"; otherwise it hears only clicks on its own buttons.
 *
 * Events go to the bot's gateway connection (/api/bot/v1/gateway) and, when it has one, are
 * POSTed to its events address, signed with its signing secret.
 */
export class BotService {
  private readonly servers: ServerRepo;
  private readonly convos: ConversationRepo;
  /** Recent posts per bot, for the per-minute limit. */
  private readonly posts = new Map<number, number[]>();
  /** Recent clicks per person. */
  private readonly clicks = new Map<number, number[]>();
  /** Stops each bot's events-address listener. */
  private readonly httpSinks = new Map<number, () => void>();
  /** Open bot gateway connections, per bot. */
  private readonly connections = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly automod: AutomodService,
    private readonly family: FamilyService,
    private readonly push: PushService,
    private readonly fetchImpl: BotFetch = defaultFetch,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {
    this.servers = new ServerRepo(db, users);
    this.convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  }

  /** Starts sending events to bots that have an events address. */
  start(): void {
    for (const r of this.db.prepare("SELECT * FROM bots WHERE events_url IS NOT NULL").all() as unknown as BotRow[]) this.listen(r);
  }

  stop(): void {
    for (const off of this.httpSinks.values()) off();
    this.httpSinks.clear();
  }

  // ---- Bots ---------------------------------------------------------------------------

  private row(botId: number): BotRow | undefined {
    return this.db.prepare("SELECT * FROM bots WHERE user_id = ?").get(botId) as BotRow | undefined;
  }

  /** A live bot (not deleted), or a 404. */
  private must(botId: number): BotRow {
    const r = this.row(botId);
    if (!r) throw new HttpError(404, "No such bot");
    return r;
  }

  isBot(userId: number): boolean {
    return !!this.row(userId);
  }

  online(botId: number): boolean {
    return (this.connections.get(botId) ?? 0) > 0 || !!this.row(botId)?.events_url;
  }

  view(r: BotRow, withSecret: boolean): Bot {
    const u = this.users.byId(r.user_id)!;
    const owner = this.users.byId(r.owner_id);
    const serverCount = Number((this.db.prepare("SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?").get(r.user_id) as { n: number }).n);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      description: r.description,
      owner: owner ? toPublic(owner) : null,
      isPublic: !!r.is_public,
      readsMessages: !!r.reads_messages,
      eventsUrl: r.events_url,
      ...(withSecret ? { signingSecret: r.signing_secret } : {}),
      online: (this.connections.get(r.user_id) ?? 0) > 0 || !!r.events_url,
      serverCount,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  /** The bot as it sees itself (without its signing secret). */
  me(botId: number): Bot {
    return this.view(this.must(botId), false);
  }

  /** Who may make bots: grown-ups who can make servers or already run one. */
  canMake(user: UserRecord): boolean {
    if (user.isKid || user.isBot) return false;
    if (user.isSuperAdmin || user.canCreateServers) return true;
    return !!this.db.prepare("SELECT 1 FROM server_members WHERE user_id = ? AND role IN ('owner', 'admin')").get(user.id);
  }

  /** The bot, if `user` owns it or is a super admin. */
  owned(user: UserRecord, botId: number): BotRow {
    const r = this.must(botId);
    if (r.owner_id !== user.id && !user.isSuperAdmin) throw new HttpError(404, "No such bot");
    return r;
  }

  /** Bots `user` owns (every bot, for a super admin). */
  list(user: UserRecord): Bot[] {
    const rows = (
      user.isSuperAdmin
        ? this.db.prepare("SELECT * FROM bots ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at").all(user.id)
    ) as unknown as BotRow[];
    return rows.map((r) => this.view(r, true));
  }

  /** Bots a server's owner or admin can add: their own, and public ones (all, for a super admin). */
  addable(user: UserRecord, serverId: number): Bot[] {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM bots b WHERE (b.owner_id = ? OR b.is_public = 1 OR ?) AND NOT EXISTS
         (SELECT 1 FROM server_members m WHERE m.server_id = ? AND m.user_id = b.user_id) ORDER BY b.created_at`,
      )
      .all(user.id, user.isSuperAdmin ? 1 : 0, serverId) as unknown as BotRow[];
    return rows.map((r) => this.view(r, false));
  }

  /** The bots in a server. */
  inServer(serverId: number, viewer: UserRecord): Bot[] {
    const rows = this.db
      .prepare("SELECT b.* FROM bots b JOIN server_members m ON m.user_id = b.user_id WHERE m.server_id = ? ORDER BY m.joined_at")
      .all(serverId) as unknown as BotRow[];
    return rows.map((r) => this.view(r, r.owner_id === viewer.id || viewer.isSuperAdmin));
  }

  create(owner: UserRecord, input: { username?: unknown; displayName?: unknown; description?: unknown }): NewBotToken {
    if (!this.canMake(owner)) throw new HttpError(403, "Only grown-ups who run a server can make bots");
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?").get(owner.id) as { n: number }).n);
    if (count >= BOT_LIMITS.botsPerOwner) throw new HttpError(400, `You can have up to ${BOT_LIMITS.botsPerOwner} bots`);
    const username = input.username;
    if (!isUsername(username)) throw new HttpError(400, "A bot's username is 2 to 32 letters, numbers, dots, dashes or underscores");
    if (this.users.byUsername(username)) throw new HttpError(409, "That username is taken");
    const displayName = clean(input.displayName).slice(0, LIMITS.displayNameLength) || username;
    const description = clean(input.description).slice(0, BOT_LIMITS.description);
    const id = tx(this.db, () => {
      const u = this.users.create({ username, displayName, isBot: true });
      this.db
        .prepare("INSERT INTO bots (user_id, owner_id, description, token_hash, signing_secret, created_at) VALUES (?, ?, ?, '', ?, ?)")
        .run(u.id, owner.id, description, randomBytes(24).toString("base64url"), now());
      return u.id;
    });
    const token = this.issue(id);
    return { bot: this.view(this.row(id)!, true), token };
  }

  update(user: UserRecord, botId: number, patch: { displayName?: unknown; description?: unknown; eventsUrl?: unknown; isPublic?: unknown; readsMessages?: unknown }): Bot {
    const r = this.owned(user, botId);
    if (patch.displayName !== undefined) {
      const name = clean(patch.displayName).slice(0, LIMITS.displayNameLength);
      if (!name) throw new HttpError(400, "Give the bot a name");
      this.users.update(botId, { displayName: name });
    }
    if (patch.description !== undefined) this.db.prepare("UPDATE bots SET description = ? WHERE user_id = ?").run(clean(patch.description).slice(0, BOT_LIMITS.description), botId);
    if (patch.eventsUrl !== undefined) this.db.prepare("UPDATE bots SET events_url = ? WHERE user_id = ?").run(cleanUrl(patch.eventsUrl, "The events address"), botId);
    if (patch.isPublic !== undefined) this.db.prepare("UPDATE bots SET is_public = ? WHERE user_id = ?").run(patch.isPublic ? 1 : 0, botId);
    if (patch.readsMessages !== undefined) this.db.prepare("UPDATE bots SET reads_messages = ? WHERE user_id = ?").run(patch.readsMessages ? 1 : 0, botId);
    const fresh = this.row(r.user_id)!;
    this.listen(fresh);
    return this.view(fresh, true);
  }

  /** A new token; the old one stops working (and its gateway connections are closed by the caller). */
  resetToken(user: UserRecord, botId: number): NewBotToken {
    this.owned(user, botId);
    const token = this.issue(botId);
    return { bot: this.view(this.row(botId)!, true), token };
  }

  /** Deletes a bot: it leaves every server and its token stops working. Its messages stay. Returns the servers it left. */
  delete(user: UserRecord, botId: number): number[] {
    this.owned(user, botId);
    const serverIds = (this.db.prepare("SELECT server_id FROM server_members WHERE user_id = ?").all(botId) as { server_id: number }[]).map((r) => r.server_id);
    for (const sid of serverIds) this.servers.removeMember(sid, botId);
    this.db.prepare("DELETE FROM bots WHERE user_id = ?").run(botId);
    this.httpSinks.get(botId)?.();
    this.httpSinks.delete(botId);
    this.posts.delete(botId);
    return serverIds;
  }

  /** Adds a bot to a server. The caller checks `user` is its owner or an admin. */
  addToServer(user: UserRecord, serverId: number, botId: number): void {
    const r = this.must(botId);
    if (r.owner_id !== user.id && !r.is_public && !user.isSuperAdmin) throw new HttpError(404, "No such bot");
    this.servers.addMember(serverId, botId);
  }

  private issue(botId: number): string {
    const token = `${botId}.${randomBytes(32).toString("base64url")}`;
    this.db.prepare("UPDATE bots SET token_hash = ? WHERE user_id = ?").run(hash(token), botId);
    return token;
  }

  /** The bot a token belongs to ("Bot <token>" or "Bearer <token>"), or undefined. */
  resolve(header: string | undefined): UserRecord | undefined {
    const m = /^(?:Bot|Bearer) (\d+)\.([A-Za-z0-9_-]{20,})$/.exec(header?.trim() ?? "");
    if (!m) return undefined;
    const r = this.row(Number(m[1]));
    if (!r) return undefined;
    const given = Buffer.from(hash(`${m[1]}.${m[2]}`));
    const stored = Buffer.from(r.token_hash);
    if (stored.length !== given.length || !timingSafeEqual(given, stored)) return undefined;
    this.db.prepare("UPDATE bots SET last_seen_at = ? WHERE user_id = ?").run(now(), r.user_id);
    return this.users.byId(r.user_id);
  }

  // ---- Events -------------------------------------------------------------------------

  /** Whether a bot should get this event: its kinds only, and other people's messages only when it reads messages. */
  private wants(botId: number, event: ServerEvent): boolean {
    if (!BOT_EVENTS.has(event.type)) return false;
    if (event.type === "message.created" || event.type === "message.updated") {
      return event.message.authorId === botId || !!this.row(botId)?.reads_messages;
    }
    return true;
  }

  /** Sends a bot's events to a gateway connection. Returns a function that stops it. */
  connect(botId: number, send: (event: ServerEvent) => void): () => void {
    this.connections.set(botId, (this.connections.get(botId) ?? 0) + 1);
    const off = this.gateway.addSink(botId, (e) => {
      if (this.wants(botId, e)) send(e);
    });
    return () => {
      off();
      const n = (this.connections.get(botId) ?? 1) - 1;
      if (n > 0) this.connections.set(botId, n);
      else this.connections.delete(botId);
    };
  }

  /** (Re)starts POSTing a bot's events to its events address. Clicks are POSTed by click(), which waits for the answer. */
  private listen(r: BotRow): void {
    this.httpSinks.get(r.user_id)?.();
    this.httpSinks.delete(r.user_id);
    if (!r.events_url) return;
    const off = this.gateway.addSink(r.user_id, (e) => {
      if (e.type !== "interaction.created" && this.wants(r.user_id, e)) void this.post(r.user_id, e).catch(() => {});
    });
    this.httpSinks.set(r.user_id, off);
  }

  /** POSTs an event to a bot's events address, signed. Returns the answer's JSON, if any. */
  private async post(botId: number, event: ServerEvent, timeoutMs = 10_000): Promise<unknown> {
    const r = this.row(botId);
    if (!r?.events_url) return undefined;
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await this.fetchImpl(r.events_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Dendrop-Bot-Events",
          "x-dendrop-event": event.type,
          "x-dendrop-timestamp": timestamp,
          "x-dendrop-signature": signEvent(r.signing_secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        this.log(`bot ${botId}'s events address answered ${res.status}`);
        return undefined;
      }
      if (!(res.headers.get("content-type") ?? "").includes("json")) return undefined;
      return await res.json();
    } catch (err) {
      this.log(`bot ${botId}'s events address failed`, err);
      throw err;
    }
  }

  // ---- Messages -----------------------------------------------------------------------

  /** The per-minute limit on what a bot posts. */
  private ratelimit(botId: number): void {
    const t = Date.now();
    const times = (this.posts.get(botId) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= BOT_LIMITS.perMinute) throw new HttpError(429, `A bot can post ${BOT_LIMITS.perMinute} times a minute`);
    times.push(t);
    this.posts.set(botId, times);
  }

  /** A text channel the bot can see, or a 404. */
  channel(bot: UserRecord, channelId: number) {
    const c = this.servers.channelById(channelId);
    if (!c || !this.convos.isMember(c.conversationId, bot.id)) throw new HttpError(404, "No such channel");
    return c;
  }

  messages(bot: UserRecord, channelId: number, before?: number, limit?: number): Array<Message & { author: { id: number; username: string; displayName: string } | null }> {
    const c = this.channel(bot, channelId);
    if (!this.row(bot.id)?.reads_messages) throw new HttpError(403, "This bot doesn't read messages; its owner can turn that on");
    // Who wrote each one, so a bot can show the history without looking people up.
    return this.convos.messages(c.conversationId, before, limit).map((m) => {
      const u = this.users.byId(m.authorId);
      return { ...m, author: u ? { id: u.id, username: u.username, displayName: u.displayName } : null };
    });
  }

  /** Posts a message as the bot, through automod like anyone else's. */
  send(bot: UserRecord, channelId: number, input: { content?: unknown; buttons?: unknown }): Message {
    const c = this.channel(bot, channelId);
    if (c.kind !== "text") throw new HttpError(400, "Bots can only post in text channels");
    const buttons = cleanButtons(input.buttons) ?? null;
    const text = cleanBody(input.content);
    this.ratelimit(bot.id);
    this.automod.checkMessage(c.conversationId, bot, text);
    const m = this.convos.send(c.conversationId, bot.id, text, [], null, null, buttons);
    this.announce(c.conversationId, m, "message.created");
    return m;
  }

  /** The bot's own message, or a 404. */
  private own(bot: UserRecord, messageId: number): Message {
    const m = this.convos.message(messageId);
    if (!m || m.authorId !== bot.id || m.webhook || !this.convos.isMember(m.conversationId, bot.id)) throw new HttpError(404, "No such message");
    if (m.deleted) throw new HttpError(409, "That message was deleted");
    return m;
  }

  /** Changes a bot's message: its text, its buttons, or both. */
  edit(bot: UserRecord, messageId: number, input: { content?: unknown; buttons?: unknown }): Message {
    const m = this.own(bot, messageId);
    const buttons = cleanButtons(input.buttons);
    if (input.content === undefined && buttons === undefined) throw new HttpError(400, "Send content, buttons or both");
    this.ratelimit(bot.id);
    let out = m;
    if (input.content !== undefined) {
      const text = cleanBody(input.content);
      this.automod.checkMessage(m.conversationId, bot, text, true);
      out = this.convos.edit(messageId, bot.id, text);
    }
    if (buttons !== undefined) out = this.convos.setButtons(messageId, buttons);
    this.announce(m.conversationId, out, "message.updated");
    return out;
  }

  remove(bot: UserRecord, messageId: number): void {
    this.own(bot, messageId);
    const { message } = this.convos.delete(messageId, bot.id);
    this.announce(message.conversationId, message, "message.updated");
  }

  private announce(conversationId: number, m: Message, type: "message.created" | "message.updated"): void {
    const memberIds = this.convos.memberIds(conversationId);
    this.gateway.send(memberIds, { type, message: m });
    if (type === "message.created") {
      void this.push.notify(
        memberIds.filter((u) => u !== m.authorId && !this.gateway.isActive(u) && !this.isBot(u)),
        "message",
      );
    }
  }

  // ---- Buttons ------------------------------------------------------------------------

  /**
   * Someone clicked a button on a bot's message. The bot hears about it over its gateway and,
   * if it has an events address, that's asked too; its answer can reply to the clicker (only
   * they see it) and change the message, for example to take the buttons away once a chore is
   * approved. Clicking counts as chatting: kids outside their hours and people timed out can't.
   */
  async click(user: UserRecord, messageId: number, buttonId: string): Promise<{ reply: string | null }> {
    const m = this.convos.message(messageId);
    if (!m || m.deleted || !this.convos.isMember(m.conversationId, user.id)) throw new HttpError(404, "No such message");
    const bot = this.row(m.authorId);
    const button = m.buttons?.find((b) => b.id === buttonId);
    if (!bot || !button || button.url) throw new HttpError(404, "No such button");
    if (button.disabled) throw new HttpError(409, "That button is turned off");
    const channel = this.servers.channelForConversation(m.conversationId);
    if (!channel) throw new HttpError(404, "No such message");
    const role = this.servers.role(channel.serverId, user.id);
    if (!role) throw new HttpError(404, "No such message");
    if (user.isKid) this.family.assertCanChat(user.id);
    this.automod.assertNotTimedOut(channel.serverId, user.id);

    const t = Date.now();
    const times = (this.clicks.get(user.id) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= BOT_LIMITS.clicksPerMinute) throw new HttpError(429, "Slow down a little");
    times.push(t);
    this.clicks.set(user.id, times);

    if (!this.online(bot.user_id)) throw new HttpError(503, "That bot isn't running right now");
    const createdAt = now();
    const res = this.db
      .prepare("INSERT INTO bot_interactions (bot_id, message_id, user_id, button_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(bot.user_id, m.id, user.id, buttonId, createdAt);
    const interaction: BotInteraction = {
      id: Number(res.lastInsertRowid),
      botId: bot.user_id,
      messageId: m.id,
      conversationId: m.conversationId,
      serverId: channel.serverId,
      channelId: channel.id,
      buttonId,
      user: toPublic(user),
      role,
      createdAt,
    };
    const event: ServerEvent = { type: "interaction.created", interaction };
    // Gateway connections get it like any event; the events address is asked and waited for.
    this.gateway.send([bot.user_id], event);
    if (!bot.events_url) return { reply: null };
    let answer: unknown;
    try {
      answer = await this.post(bot.user_id, event, BOT_LIMITS.callbackMs);
    } catch {
      throw new HttpError(504, "That bot didn't answer in time");
    }
    return this.respond(interaction, answer as InteractionResponse | undefined);
  }

  /** Applies a bot's answer to a click: the update to its message, and the reply (returned for the clicker). */
  private respond(interaction: BotInteraction, answer: InteractionResponse | undefined): { reply: string | null } {
    if (!answer || typeof answer !== "object") return { reply: null };
    const bot = this.users.byId(interaction.botId)!;
    if (answer.update && typeof answer.update === "object") {
      try {
        this.edit(bot, interaction.messageId, answer.update);
      } catch (err) {
        this.log(`bot ${bot.id}'s update after a click was refused`, err);
      }
    }
    return { reply: answer.reply === undefined ? null : this.replyText(interaction, answer.reply) };
  }

  /** A reply only the clicker sees: checked against a kid's family filter, and marked as given. */
  private replyText(interaction: BotInteraction, content: unknown): string | null {
    const text = cleanBody(content);
    const clicker = this.users.byId(interaction.user.id);
    if (clicker?.isKid) {
      const rules = this.family.rules(clicker.id);
      if (rules.profanityFilter && findBlockedWords(text, rules.blockedWords).length) return null;
    }
    this.db.prepare("UPDATE bot_interactions SET replied_at = ? WHERE id = ?").run(now(), interaction.id);
    return text;
  }

  /** A bot answering a click later, over the API: once per click, within BOT_LIMITS.replyMinutes. */
  reply(bot: UserRecord, interactionId: number, content: unknown): void {
    const r = this.db.prepare("SELECT * FROM bot_interactions WHERE id = ? AND bot_id = ?").get(interactionId, bot.id) as InteractionRow | undefined;
    if (!r) throw new HttpError(404, "No such interaction");
    if (r.replied_at) throw new HttpError(409, "That click already has a reply");
    if (Date.now() - new Date(r.created_at).getTime() > BOT_LIMITS.replyMinutes * 60_000) throw new HttpError(410, "Too late to reply to that click");
    const m = this.convos.message(r.message_id);
    if (!m) throw new HttpError(404, "No such interaction");
    const user = this.users.byId(r.user_id);
    const text = user && this.replyText({ id: r.id, user: toPublic(user) } as BotInteraction, content);
    if (!text) return;
    this.gateway.send([r.user_id], { type: "interaction.reply", interactionId: r.id, messageId: m.id, conversationId: m.conversationId, botId: bot.id, content: text });
  }

  /** Who may add or remove bots in a server. */
  assertModerator(serverId: number, user: UserRecord): void {
    const role = this.servers.role(serverId, user.id);
    if (!role) throw new HttpError(404, "No such server");
    if (!this.servers.can(serverId, user.id, "manageWebhooks", role)) throw new HttpError(403, "You need Manage webhooks & bots to do that");
  }
}
