import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditEntry } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import type { UserRecord } from "./users.js";

/** One thing to write to the log once the request has worked. */
export interface AuditDraft {
  serverId: number | null;
  action: string;
  targetUserId?: number | null;
  targetName?: string | null;
  details?: string;
}

interface Row {
  id: number;
  server_id: number | null;
  actor_id: number | null;
  actor_name: string;
  action: string;
  target_user_id: number | null;
  target_name: string | null;
  details: string;
  created_at: string;
}

const PAGE = 50;

/** The audit log: who changed what in a server, and what super admins did to the instance. */
export class AuditLog {
  constructor(private readonly db: Db) {}

  write(actor: Pick<UserRecord, "id" | "displayName"> | null, draft: AuditDraft): void {
    let targetName = draft.targetName ?? null;
    if (targetName === null && draft.targetUserId) targetName = this.userName(draft.targetUserId);
    this.db
      .prepare(
        "INSERT INTO audit_log (server_id, actor_id, actor_name, action, target_user_id, target_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(draft.serverId, actor?.id ?? null, actor?.displayName ?? "Dendrop", draft.action, draft.targetUserId ?? null, targetName, (draft.details ?? "").slice(0, 500), now());
  }

  /** Newest first. serverId null is the instance log. */
  list(serverId: number | null, opts: { before?: number; action?: string; userId?: number } = {}): AuditEntry[] {
    const where = [serverId === null ? "server_id IS NULL" : "server_id = ?"];
    const args: (number | string)[] = serverId === null ? [] : [serverId];
    if (opts.before) {
      where.push("id < ?");
      args.push(opts.before);
    }
    if (opts.action) {
      // "member" matches every member.* action.
      where.push(opts.action.includes(".") ? "action = ?" : "action LIKE ?");
      args.push(opts.action.includes(".") ? opts.action : `${opts.action}.%`);
    }
    if (opts.userId) {
      where.push("(actor_id = ? OR target_user_id = ?)");
      args.push(opts.userId, opts.userId);
    }
    const rows = this.db.prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${PAGE}`).all(...args) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      actor: { id: r.actor_id, name: r.actor_name },
      action: r.action,
      target: { userId: r.target_user_id, name: r.target_name },
      details: r.details,
      createdAt: r.created_at,
    }));
  }

  private userName(id: number): string | null {
    return (this.db.prepare("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | undefined)?.display_name ?? null;
  }
}

// ---- Recording admin and moderator actions -------------------------------------------
//
// Rather than a log call in every route, each logged route has a rule here, keyed by its method
// and path. The rule runs before the route (so it can still read names of things about to be
// deleted) and the entry is written only if the route answers with success.

type Params = Record<string, string>;
type Body = Record<string, unknown>;
type Rule = (p: Params, body: Body, req: FastifyRequest, db: Db, me: UserRecord) => AuditDraft | AuditDraft[] | null;

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 100) : "");
const keys = (body: Body, skip: string[] = []) =>
  Object.keys(body)
    .filter((k) => !skip.includes(k))
    .join(", ");

const get = <T>(db: Db, sql: string, ...args: (number | string)[]): T | undefined => db.prepare(sql).get(...args) as T | undefined;
const nameOf = (db: Db, table: string, id: unknown) => get<{ name: string }>(db, `SELECT name FROM ${table} WHERE id = ?`, num(id))?.name ?? null;
const serverName = (db: Db, id: number) => nameOf(db, "servers", id);

/** The server a message is in, and who wrote it, for messages in channels and threads. */
const channelMessage = (db: Db, messageId: unknown) =>
  get<{ server_id: number; author_id: number; channel: string }>(
    db,
    `SELECT cc.server_id, m.author_id, sc.name AS channel FROM messages m
     JOIN channel_conversations cc ON cc.conversation_id = m.conversation_id
     JOIN server_channels sc ON sc.id = cc.channel_id WHERE m.id = ?`,
    num(messageId),
  );

const s = (p: Params) => num(p.id);

const RULES: Record<string, Rule> = {
  // ---- Servers
  "PATCH /api/servers/:id": (p, b) => ({ serverId: s(p), action: "server.update", details: keys(b) }),
  "PUT /api/servers/:id/:kind(icon|banner)": (p) => ({ serverId: s(p), action: "server.image", details: `new ${p.kind}` }),
  "DELETE /api/servers/:id/:kind(icon|banner)": (p) => ({ serverId: s(p), action: "server.image", details: `removed the ${p.kind}` }),
  "DELETE /api/servers/:id": (p, _b, _r, db) => ({ serverId: null, action: "server.delete", targetName: serverName(db, s(p)) }),
  "POST /api/servers/:id/transfer": (p, b) => ({ serverId: s(p), action: "server.transfer", targetUserId: num(b.userId) }),

  // ---- Members
  "PATCH /api/servers/:id/members/:userId": (p, b) => ({ serverId: s(p), action: "member.role", targetUserId: num(p.userId), details: `to ${str(b.role)}` }),
  "PUT /api/servers/:id/members/:userId/roles": (p, b, _r, db) => {
    const ids = Array.isArray(b.roleIds) ? b.roleIds.map(num) : [];
    const names = ids.map((i) => nameOf(db, "server_roles", i)).filter(Boolean);
    return { serverId: s(p), action: "member.roles", targetUserId: num(p.userId), details: names.length ? `now ${names.join(", ")}` : "no roles" };
  },
  "DELETE /api/servers/:id/members/:userId": (p, _b, req) => ({
    serverId: s(p),
    action: (req.query as { ban?: string }).ban === "true" ? "member.ban" : "member.kick",
    targetUserId: num(p.userId),
  }),
  "DELETE /api/servers/:id/bans/:userId": (p) => ({ serverId: s(p), action: "member.unban", targetUserId: num(p.userId) }),
  "PUT /api/servers/:id/timeouts/:userId": (p, b) => ({
    serverId: s(p),
    action: "member.timeout",
    targetUserId: num(p.userId),
    details: `${num(b.minutes)} min${str(b.reason) ? `: ${str(b.reason)}` : ""}`,
  }),
  "DELETE /api/servers/:id/timeouts/:userId": (p) => ({ serverId: s(p), action: "member.untimeout", targetUserId: num(p.userId) }),
  "DELETE /api/servers/:id/levels": (p) => ({ serverId: s(p), action: "levels.reset", details: "everyone" }),
  "DELETE /api/servers/:id/levels/:userId": (p) => ({ serverId: s(p), action: "levels.reset", targetUserId: num(p.userId) }),
  "PUT /api/servers/:id/welcome": (p, b) => ({ serverId: s(p), action: "welcome.update", details: keys(b) }),

  // ---- Roles
  "POST /api/servers/:id/roles": (p, b) => ({ serverId: s(p), action: "role.create", targetName: str(b.name) }),
  "PUT /api/servers/:id/roles/order": (p) => ({ serverId: s(p), action: "role.reorder" }),
  "PATCH /api/servers/:id/roles/:roleId": (p, b, _r, db) => ({ serverId: s(p), action: "role.update", targetName: nameOf(db, "server_roles", p.roleId), details: keys(b) }),
  "DELETE /api/servers/:id/roles/:roleId": (p, _b, _r, db) => ({ serverId: s(p), action: "role.delete", targetName: nameOf(db, "server_roles", p.roleId) }),

  // ---- Channels, messages, threads
  "POST /api/servers/:id/channels": (p, b) => ({ serverId: s(p), action: "channel.create", targetName: `#${str(b.name)}` }),
  "PUT /api/servers/:id/channels/order": (p) => ({ serverId: s(p), action: "channel.reorder" }),
  "PATCH /api/servers/:id/channels/:channelId": (p, b, _r, db) => ({ serverId: s(p), action: "channel.update", targetName: `#${nameOf(db, "server_channels", p.channelId) ?? "?"}`, details: keys(b) }),
  "DELETE /api/servers/:id/channels/:channelId": (p, _b, _r, db) => ({ serverId: s(p), action: "channel.delete", targetName: `#${nameOf(db, "server_channels", p.channelId) ?? "?"}` }),
  "DELETE /api/servers/:id/messages/:messageId": (p, _b, _r, db) => {
    const m = channelMessage(db, p.messageId);
    return m ? { serverId: s(p), action: "message.delete", targetUserId: m.author_id, details: `in #${m.channel}` } : null;
  },
  "PUT /api/messages/:id/pin": (p, _b, _r, db) => {
    const m = channelMessage(db, p.id);
    return m ? { serverId: m.server_id, action: "message.pin", targetUserId: m.author_id, details: `in #${m.channel}` } : null;
  },
  "DELETE /api/messages/:id/pin": (p, _b, _r, db) => {
    const m = channelMessage(db, p.id);
    return m ? { serverId: m.server_id, action: "message.unpin", targetUserId: m.author_id, details: `in #${m.channel}` } : null;
  },
  // Only someone else's thread: people tidying their own posts isn't moderation.
  "PATCH /api/threads/:id": (p, b, _r, db, me) => {
    const t = get<{ server_id: number; title: string; created_by: number | null }>(
      db,
      "SELECT c.server_id, t.title, t.created_by FROM channel_threads t JOIN server_channels c ON c.id = t.channel_id WHERE t.id = ?",
      num(p.id),
    );
    if (!t || t.created_by === me.id) return null;
    const what = b.closed === true ? "closed" : b.closed === false ? "reopened" : keys(b);
    return { serverId: t.server_id, action: "thread.update", targetName: t.title, details: what };
  },
  "DELETE /api/threads/:id": (p, _b, _r, db, me) => {
    const t = get<{ server_id: number; title: string; created_by: number | null }>(
      db,
      "SELECT c.server_id, t.title, t.created_by FROM channel_threads t JOIN server_channels c ON c.id = t.channel_id WHERE t.id = ?",
      num(p.id),
    );
    return t && t.created_by !== me.id ? { serverId: t.server_id, action: "thread.delete", targetName: t.title } : null;
  },

  // ---- Server tools
  "PATCH /api/servers/:id/automod": (p, b) => ({ serverId: s(p), action: "automod.update", details: keys(b) }),
  "POST /api/servers/:id/invites": (p) => ({ serverId: s(p), action: "invite.create" }),
  "POST /api/servers/:id/emojis": (p) => ({ serverId: s(p), action: "emoji.add" }),
  "PATCH /api/servers/:id/emojis/:emojiId": (p, b, _r, db) => ({ serverId: s(p), action: "emoji.update", targetName: `:${nameOf(db, "server_emojis", p.emojiId) ?? "?"}:`, details: `to :${str(b.name)}:` }),
  "DELETE /api/servers/:id/emojis/:emojiId": (p, _b, _r, db) => ({ serverId: s(p), action: "emoji.delete", targetName: `:${nameOf(db, "server_emojis", p.emojiId) ?? "?"}:` }),
  "POST /api/servers/:id/stickers": (p) => ({ serverId: s(p), action: "sticker.add" }),
  "DELETE /api/servers/:id/stickers/:stickerId": (p, _b, _r, db) => ({ serverId: s(p), action: "sticker.delete", targetName: nameOf(db, "server_stickers", p.stickerId) }),
  "POST /api/servers/:id/sounds": (p) => ({ serverId: s(p), action: "sound.add" }),
  "PATCH /api/servers/:id/sounds/:soundId": (p, b, _r, db) => ({ serverId: s(p), action: "sound.update", targetName: nameOf(db, "server_sounds", p.soundId), details: keys(b) }),
  "DELETE /api/servers/:id/sounds/:soundId": (p, _b, _r, db) => ({ serverId: s(p), action: "sound.delete", targetName: nameOf(db, "server_sounds", p.soundId) }),
  "POST /api/servers/:id/webhooks": (p, b) => ({ serverId: s(p), action: "webhook.create", targetName: str(b.name) }),
  "PATCH /api/servers/:id/webhooks/:hookId": (p, b, _r, db) => ({ serverId: s(p), action: "webhook.update", targetName: nameOf(db, "webhooks", p.hookId), details: keys(b) }),
  "POST /api/servers/:id/webhooks/:hookId/reset": (p, _b, _r, db) => ({ serverId: s(p), action: "webhook.reset", targetName: nameOf(db, "webhooks", p.hookId) }),
  "DELETE /api/servers/:id/webhooks/:hookId": (p, _b, _r, db) => ({ serverId: s(p), action: "webhook.delete", targetName: nameOf(db, "webhooks", p.hookId) }),
  "POST /api/servers/:id/bots": (p, b) => ({ serverId: s(p), action: "bot.add", targetUserId: num(b.botId) }),
  "DELETE /api/servers/:id/bots/:botId": (p) => ({ serverId: s(p), action: "bot.remove", targetUserId: num(p.botId) }),
  "POST /api/servers/:id/events": (p, b) => ({ serverId: s(p), action: "event.create", targetName: str(b.name) }),
  "PATCH /api/events/:eventId": (p, b, _r, db) => {
    const e = get<{ server_id: number; name: string }>(db, "SELECT server_id, name FROM server_events WHERE id = ?", num(p.eventId));
    return e ? { serverId: e.server_id, action: "event.update", targetName: e.name, details: keys(b) } : null;
  },
  "DELETE /api/events/:eventId": (p, _b, _r, db) => {
    const e = get<{ server_id: number; name: string }>(db, "SELECT server_id, name FROM server_events WHERE id = ?", num(p.eventId));
    return e ? { serverId: e.server_id, action: "event.delete", targetName: e.name } : null;
  },

  // ---- The instance (super admins)
  "PUT /api/admin/signin": (_p, b) => ({
    serverId: null,
    action: "signin.update",
    details: Object.entries(b)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k, v]) => `${k} ${v ? "on" : "off"}`)
      .join(", "),
  }),
  "PUT /api/admin/accounts/:id/password": (p) => ({ serverId: null, action: "account.password", targetUserId: num(p.id) }),
  "DELETE /api/admin/accounts/:id/signins/:provider": (p) => ({ serverId: null, action: "account.unlink", targetUserId: num(p.id), details: p.provider }),
  "DELETE /api/admin/accounts/:id/2fa": (p) => ({ serverId: null, action: "account.reset2fa", targetUserId: num(p.id) }),
  "PUT /api/admin/server-creators/:userId": (p, b) => ({ serverId: null, action: b.allowed === true ? "creator.allow" : "creator.deny", targetUserId: num(p.userId) }),
  "POST /api/admin/family": (_p, b) => ({ serverId: null, action: "family.link", targetName: `${str(b.parent)} → ${str(b.kid)}` }),
  "PUT /api/admin/gifs": (_p, b) => ({ serverId: null, action: "gifs.update", details: keys(b).replace("apiKey", "API key") }),
  "PUT /api/admin/lootden": () => ({ serverId: null, action: "lootden.update" }),
  "PUT /api/admin/lootden/channels": () => ({ serverId: null, action: "lootden.update", details: "channels" }),
  "PUT /api/admin/denduty": () => ({ serverId: null, action: "denduty.update" }),
  "PUT /api/admin/denduty/channels": () => ({ serverId: null, action: "denduty.update", details: "channels" }),
  "PUT /api/admin/denduty/kids": () => ({ serverId: null, action: "denduty.update", details: "kids" }),
  "POST /api/admin/backups": () => ({ serverId: null, action: "backup.create" }),
  "PUT /api/admin/backups/settings": (_p, b) => ({ serverId: null, action: "backup.settings", details: keys(b) }),
  "GET /api/admin/backups/:name": (p) => ({ serverId: null, action: "backup.download", targetName: p.name ?? null }),
  "DELETE /api/admin/backups/:name": (p) => ({ serverId: null, action: "backup.delete", targetName: p.name ?? null }),
};

declare module "fastify" {
  interface FastifyRequest {
    auditDrafts?: AuditDraft[];
  }
}

/** Registered on the root app, so it sees every route. */
export function recordAudit(app: FastifyInstance, log: AuditLog, db: Db): void {
  app.addHook("preHandler", async (req) => {
    const rule = RULES[`${req.method} ${req.routeOptions.url}`];
    if (!rule || !req.user) return;
    try {
      const out = rule((req.params ?? {}) as Params, (req.body && typeof req.body === "object" ? req.body : {}) as Body, req, db, req.user);
      if (out) req.auditDrafts = (Array.isArray(out) ? out : [out]).filter((d) => d.serverId === null || d.serverId > 0);
    } catch (err) {
      req.log.warn({ err }, "audit rule failed");
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    if (!req.auditDrafts?.length || !req.user || reply.statusCode >= 400) return;
    for (const d of req.auditDrafts) {
      try {
        // The server is gone after server.delete; its entry lives in the instance log.
        if (d.serverId !== null && !get(db, "SELECT 1 FROM servers WHERE id = ?", d.serverId)) continue;
        log.write(req.user, d);
      } catch (err) {
        req.log.warn({ err }, "audit write failed");
      }
    }
  });
}
