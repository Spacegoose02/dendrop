import { cleanKeywords, matchesKeyword, NOTIFY_LEVELS, type Message, type NotificationSettings, type NotifyLevel } from "@dendrop/shared";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import type { PushService } from "./push.js";

/**
 * Per-person notification settings: for a conversation (a DM, group, channel or thread) and for a
 * whole server. The most specific one wins: the conversation, then a thread's channel, then the
 * server, then "all".
 */
export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly gateway: Gateway,
    private readonly push: PushService,
  ) {}

  /** Whether someone has Do Not Disturb on right now. */
  dnd(userId: number, at = Date.now()): boolean {
    const r = this.db.prepare("SELECT presence, dnd_until FROM users WHERE id = ?").get(userId) as { presence: string; dnd_until: string | null } | undefined;
    return r?.presence === "dnd" && (!r.dnd_until || Date.parse(r.dnd_until) > at);
  }

  settings(userId: number): NotificationSettings {
    const out: NotificationSettings = { conversations: {}, servers: {} };
    const rows = this.db.prepare("SELECT scope, target_id, level FROM notification_settings WHERE user_id = ?").all(userId) as {
      scope: string;
      target_id: number;
      level: NotifyLevel;
    }[];
    for (const r of rows) (r.scope === "server" ? out.servers : out.conversations)[r.target_id] = r.level;
    out.keywords = this.keywords(userId);
    return out;
  }

  /** Someone's keyword alerts. */
  keywords(userId: number): string[] {
    const r = this.db.prepare("SELECT keyword_alerts FROM users WHERE id = ?").get(userId) as { keyword_alerts: string | null } | undefined;
    if (!r?.keyword_alerts) return [];
    try {
      const list = cleanKeywords(JSON.parse(r.keyword_alerts));
      return typeof list === "string" ? [] : list;
    } catch {
      return [];
    }
  }

  /** Replaces someone's keyword alerts. */
  setKeywords(userId: number, input: unknown): NotificationSettings {
    const list = cleanKeywords(input);
    if (typeof list === "string") throw new HttpError(400, list);
    this.db.prepare("UPDATE users SET keyword_alerts = ? WHERE id = ?").run(list.length ? JSON.stringify(list) : null, userId);
    const settings = this.settings(userId);
    this.gateway.send([userId], { type: "notifications.updated", settings });
    return settings;
  }

  /** Sets (or with level null, clears) one setting. The caller checks the person can see the place. */
  set(userId: number, scope: "conversation" | "server", targetId: number, level: unknown): NotificationSettings {
    if (level === null) {
      this.db.prepare("DELETE FROM notification_settings WHERE user_id = ? AND scope = ? AND target_id = ?").run(userId, scope, targetId);
    } else {
      if (!NOTIFY_LEVELS.includes(level as NotifyLevel)) throw new HttpError(400, `level is one of ${NOTIFY_LEVELS.join(", ")}, or null`);
      this.db
        .prepare(
          `INSERT INTO notification_settings (user_id, scope, target_id, level) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, scope, target_id) DO UPDATE SET level = excluded.level`,
        )
        .run(userId, scope, targetId, level as string);
    }
    const settings = this.settings(userId);
    this.gateway.send([userId], { type: "notifications.updated", settings });
    return settings;
  }

  /** How much `userId` wants to hear about a conversation. */
  levelFor(userId: number, conversationId: number): NotifyLevel {
    const place = this.db
      .prepare(
        `SELECT cc.server_id, cc.thread_id, ch.conversation_id AS channel_conversation_id
         FROM channel_conversations cc JOIN server_channels ch ON ch.id = cc.channel_id WHERE cc.conversation_id = ?`,
      )
      .get(conversationId) as { server_id: number; thread_id: number | null; channel_conversation_id: number } | undefined;
    const look = this.db.prepare("SELECT level FROM notification_settings WHERE user_id = ? AND scope = ? AND target_id = ?");
    const get = (scope: string, id: number) => (look.get(userId, scope, id) as { level: NotifyLevel } | undefined)?.level;
    return (
      get("conversation", conversationId) ??
      (place?.thread_id ? get("conversation", place.channel_conversation_id) : undefined) ??
      (place ? get("server", place.server_id) : undefined) ??
      "all"
    );
  }

  /**
   * Sends a new message to the people in its conversation, each with whether it should notify
   * them, and wakes up the phones of those with nothing open who want to hear about it.
   * A keyword alert counts as a mention. Encrypted messages can't be checked here: the app
   * checks those itself once it has opened them.
   */
  deliver(m: Message, recipients: number[], senderId: number | null): void {
    const groups = new Map<string, number[]>();
    const wake: number[] = [];
    const wakeMentioned: number[] = [];
    const readable = !m.keyVersion && !m.deleted && !!m.body;
    const keywordsOf = readable ? this.keywordsFor(recipients.filter((uid) => uid !== senderId)) : new Map<number, string[]>();
    for (const uid of recipients) {
      const own = uid === senderId;
      const pinged = !own && (!!m.mentionsEveryone || !!m.mentions?.includes(uid));
      const keyword = !own && !pinged && matchesKeyword(m.body, keywordsOf.get(uid));
      const mentioned = pinged || keyword;
      const level = this.levelFor(uid, m.conversationId);
      // Do Not Disturb: the message still arrives, just without a notification or a push.
      const notify = !own && (level === "all" || (level === "mentions" && mentioned)) && !this.dnd(uid);
      const muted = level === "nothing";
      const key = `${notify}|${mentioned}|${muted}|${keyword}`;
      groups.set(key, [...(groups.get(key) ?? []), uid]);
      // Connected but in the background (a phone with the screen off) still gets a push.
      if (notify && !this.gateway.isActive(uid)) (mentioned ? wakeMentioned : wake).push(uid);
    }
    for (const [key, ids] of groups) {
      const [notify, mentioned, muted, keyword] = key.split("|").map((x) => x === "true") as [boolean, boolean, boolean, boolean];
      this.gateway.send(ids, { type: "message.created", message: m, notify, mentioned, muted, ...(keyword ? { keyword } : {}) });
    }
    // Phones of people with nothing open get a wake-up that says only "message", or "mention"
    // when they were @mentioned. Still nothing about who, where or what.
    if (wake.length) void this.push.notify(wake, "message");
    if (wakeMentioned.length) void this.push.notify(wakeMentioned, "mention");
  }

  /** Keyword alerts for many people at once, leaving out those with none. */
  private keywordsFor(userIds: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!userIds.length) return out;
    const rows = this.db
      .prepare(`SELECT id, keyword_alerts FROM users WHERE keyword_alerts IS NOT NULL AND id IN (${userIds.map(() => "?").join(",")})`)
      .all(...userIds) as { id: number; keyword_alerts: string }[];
    for (const r of rows) {
      try {
        const list = cleanKeywords(JSON.parse(r.keyword_alerts));
        if (typeof list !== "string" && list.length) out.set(r.id, list);
      } catch {
        // A broken list alerts on nothing.
      }
    }
    return out;
  }
}
