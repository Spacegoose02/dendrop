import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LIMITS, WEBHOOK_LIMITS, type NewWebhook, type Webhook } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { now } from "../db.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { isModerator, ServerRepo } from "../servers.js";
import { toPublic, type UserRecord } from "../users.js";

interface WebhookRow {
  id: number;
  server_id: number;
  channel_id: number;
  name: string;
  token_hash: string;
  created_by: number;
  created_at: string;
  last_used_at: string | null;
}

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!s) throw new HttpError(400, "Give the webhook a name");
  return s.slice(0, WEBHOOK_LIMITS.name);
}

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

/**
 * The text of a webhook post. Takes the shapes other tools send, so most work as they are:
 * Apprise's json:// ({ title, message }), the Apprise API ({ title, body }), Discord-style
 * ({ content, username, embeds }), Slack-style ({ text }), or a plain text body. A title goes
 * on its own line above the text. Long posts are cut to fit rather than refused.
 */
export function webhookPost(body: unknown): { text: string; name: string | null } {
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const text = str(String(body));
    if (!text) throw new HttpError(400, "The post has no text");
    return { text: text.slice(0, LIMITS.messageLength), name: null };
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let title = str(b.title) || str(b.subject);
  let text = str(b.content) || str(b.message) || str(b.body) || str(b.text);
  // Discord-style embeds: the first one's title and description, when there's no plain text.
  const embed = Array.isArray(b.embeds) ? (b.embeds[0] as Record<string, unknown> | undefined) : undefined;
  if (!text && embed && typeof embed === "object") {
    title ||= str(embed.title);
    text = str(embed.description);
  }
  const lines = title && title !== text ? [title, text] : [text || title];
  const out = lines.filter(Boolean).join("\n");
  if (!out) throw new HttpError(400, "The post has no text: send { \"content\": \"...\" } or { \"title\": \"...\", \"message\": \"...\" }");
  const name = str(b.username) || str(b.name);
  return { text: out.slice(0, LIMITS.messageLength), name: name ? name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, WEBHOOK_LIMITS.name) : null };
}

/**
 * Incoming webhooks: the owner and admins of a server make a secret address for a channel, and
 * anything that can send an HTTP POST (LootDen's Apprise alerts, Home Assistant, a script) can
 * post there. The address is the only thing that's needed, so it's shown once and only a hash
 * is kept; "New address" replaces a leaked one.
 */
export function webhookRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, config } = ctx;
  const servers = new ServerRepo(db, users);
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  /** Recent posts per webhook, for the per-minute limit. */
  const recent = new Map<number, number[]>();

  const toWebhook = (r: WebhookRow): Webhook => {
    const by = users.byId(r.created_by);
    return {
      id: r.id,
      serverId: r.server_id,
      channelId: r.channel_id,
      name: r.name,
      createdBy: by ? toPublic(by) : null,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  };
  const row = (serverId: number, hookId: number): WebhookRow => {
    const r = db.prepare("SELECT * FROM webhooks WHERE id = ? AND server_id = ?").get(hookId, serverId) as WebhookRow | undefined;
    if (!r) throw new HttpError(404, "No such webhook");
    return r;
  };
  const moderator = (serverId: number, user: UserRecord) => {
    const role = servers.role(serverId, user.id);
    if (!role) throw new HttpError(404, "No such server");
    if (!isModerator(role)) throw new HttpError(403, "Only the owner and admins can do that");
  };
  const base = (req: FastifyRequest) => config.publicUrl || `${req.protocol}://${req.headers.host}`;
  /** A new secret for a webhook, and its full address. */
  const issue = (req: FastifyRequest, hookId: number): string => {
    const token = randomBytes(24).toString("base64url");
    db.prepare("UPDATE webhooks SET token_hash = ? WHERE id = ?").run(hash(token), hookId);
    return `${base(req)}/api/hooks/${hookId}/${token}`;
  };

  // Apprise's form:// and other simple senders post HTML form fields.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id/webhooks", async (req) => {
    const serverId = id(req.params.id);
    moderator(serverId, requireUser(req));
    return (db.prepare("SELECT * FROM webhooks WHERE server_id = ? ORDER BY channel_id, id").all(serverId) as unknown as WebhookRow[]).map(toWebhook);
  });

  /** Forum channels hold posts, not one chat, so webhooks can't post there. */
  const postable = <C extends { kind: string }>(c: C): C => {
    if (c.kind === "forum") throw new HttpError(400, "Pick a text or voice channel; forums hold posts");
    return c;
  };

  app.post<{ Params: { id: string }; Body: { channelId?: unknown; name?: unknown } }>("/api/servers/:id/webhooks", async (req): Promise<NewWebhook> => {
    const me = requireUser(req);
    const serverId = id(req.params.id);
    moderator(serverId, me);
    const channel = postable(servers.channel(serverId, id(req.body?.channelId)));
    const name = cleanName(req.body?.name);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE channel_id = ?").get(channel.id) as { n: number }).n;
    if (count >= WEBHOOK_LIMITS.perChannel) throw new HttpError(400, `A channel can have up to ${WEBHOOK_LIMITS.perChannel} webhooks`);
    const res = db
      .prepare("INSERT INTO webhooks (server_id, channel_id, name, token_hash, created_by, created_at) VALUES (?, ?, ?, '', ?, ?)")
      .run(serverId, channel.id, name, me.id, now());
    const hookId = Number(res.lastInsertRowid);
    const url = issue(req, hookId);
    return { ...toWebhook(row(serverId, hookId)), url };
  });

  app.patch<{ Params: { id: string; hookId: string }; Body: { channelId?: unknown; name?: unknown } }>("/api/servers/:id/webhooks/:hookId", async (req) => {
    const serverId = id(req.params.id);
    moderator(serverId, requireUser(req));
    const r = row(serverId, id(req.params.hookId));
    const name = req.body?.name === undefined ? r.name : cleanName(req.body.name);
    const channelId = req.body?.channelId === undefined ? r.channel_id : postable(servers.channel(serverId, id(req.body.channelId))).id;
    db.prepare("UPDATE webhooks SET name = ?, channel_id = ? WHERE id = ?").run(name, channelId, r.id);
    return toWebhook(row(serverId, r.id));
  });

  /** A new address; the old one stops working. */
  app.post<{ Params: { id: string; hookId: string } }>("/api/servers/:id/webhooks/:hookId/reset", async (req): Promise<NewWebhook> => {
    const serverId = id(req.params.id);
    moderator(serverId, requireUser(req));
    const r = row(serverId, id(req.params.hookId));
    const url = issue(req, r.id);
    return { ...toWebhook(r), url };
  });

  app.delete<{ Params: { id: string; hookId: string } }>("/api/servers/:id/webhooks/:hookId", async (req) => {
    const serverId = id(req.params.id);
    moderator(serverId, requireUser(req));
    const r = row(serverId, id(req.params.hookId));
    db.prepare("DELETE FROM webhooks WHERE id = ?").run(r.id);
    recent.delete(r.id);
    return { ok: true };
  });

  /** The webhook address itself: no sign-in, the secret in the path is the key. */
  app.post<{ Params: { hookId: string; token: string } }>("/api/hooks/:hookId/:token", async (req, reply) => {
    const hookId = Number(req.params.hookId);
    const r = Number.isInteger(hookId) ? (db.prepare("SELECT * FROM webhooks WHERE id = ?").get(hookId) as WebhookRow | undefined) : undefined;
    const given = Buffer.from(hash(req.params.token));
    const stored = Buffer.from(r?.token_hash ?? "");
    if (!r || stored.length !== given.length || !timingSafeEqual(given, stored)) {
      throw new HttpError(404, "No such webhook");
    }
    const t = Date.now();
    const times = (recent.get(r.id) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= WEBHOOK_LIMITS.perMinute) {
      void reply.header("retry-after", "60");
      throw new HttpError(429, `A webhook can post ${WEBHOOK_LIMITS.perMinute} times a minute`);
    }
    times.push(t);
    recent.set(r.id, times);

    const { text, name } = webhookPost(req.body);
    const channel = servers.channelById(r.channel_id);
    if (!channel) throw new HttpError(404, "No such webhook");
    const m = convos.send(channel.conversationId, r.created_by, text, [], null, { id: r.id, name: name ?? r.name });
    db.prepare("UPDATE webhooks SET last_used_at = ? WHERE id = ?").run(now(), r.id);
    const memberIds = convos.memberIds(channel.conversationId);
    ctx.notifications.deliver(m, memberIds, null);
    return reply.code(204).send();
  });
}
