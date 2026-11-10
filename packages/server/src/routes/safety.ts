import { rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { REPORT_REASONS, type Report, type ReportReason } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { verifyPassword } from "../auth/crypto.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { now } from "../db.js";
import { HttpError } from "../errors.js";
import { ConversationRepo } from "../conversations.js";
import { FriendRepo } from "../friends.js";
import { ServerRepo } from "../servers.js";
import { toMe, toPublic, type UserRecord } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

interface ReportRow {
  id: number;
  reporter_id: number | null;
  reported_id: number | null;
  server_id: number | null;
  conversation_id: number | null;
  message_id: number | null;
  reason: string;
  details: string;
  quote: string | null;
  place: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: number | null;
}

/** Most reports kept open per reporter, so one person can't flood moderators. */
const OPEN_REPORTS_PER_PERSON = 20;

/** Reporting messages and people, deleting your account, and downloading your data. */
export function safetyRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway } = ctx;
  const servers = new ServerRepo(db, users);
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const uploads = path.join(ctx.config.dataDir, "uploads");
  const superAdmins = () => (db.prepare("SELECT id FROM users WHERE is_super_admin = 1").all() as { id: number }[]).map((r) => r.id);
  const pub = (uid: number | null) => {
    const u = uid === null ? undefined : users.byId(uid);
    return u ? toPublic(u) : null;
  };
  const toReport = (r: ReportRow): Report => ({
    id: r.id,
    serverId: r.server_id,
    reporter: pub(r.reporter_id),
    reported: pub(r.reported_id),
    reason: r.reason as ReportReason,
    details: r.details,
    messageId: r.message_id,
    conversationId: r.conversation_id,
    quote: r.quote,
    place: r.place,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: pub(r.resolved_by),
  });
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  /** Who reviews reports for a server: anyone who can delete its messages. */
  const reviewers = (serverId: number) => servers.memberIds(serverId).filter((u) => servers.can(serverId, u, "deleteMessages"));

  // ---- Reports ----------------------------------------------------------------------

  /**
   * Reports a message ({ messageId, reason, details, quote }) or a person ({ userId, reason,
   * details }). A message in a server channel goes to that server's moderators with its text;
   * anything else goes to super admins, with only the text the reporter chose to share (`quote`),
   * because the server can't read encrypted chats.
   */
  app.post<{ Body: { messageId?: unknown; userId?: unknown; reason?: unknown; details?: unknown; quote?: unknown } }>("/api/reports", async (req) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    if (typeof b.reason !== "string" || !(b.reason in REPORT_REASONS)) throw new HttpError(400, "Pick a reason");
    const open = (db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND resolved_at IS NULL").get(me.id) as { n: number }).n;
    if (open >= OPEN_REPORTS_PER_PERSON) throw new HttpError(429, "You have a lot of reports waiting already. Moderators will get to them.");
    const details = text(b.details, 1000);
    let row: Omit<ReportRow, "id" | "created_at" | "resolved_at" | "resolved_by">;
    if (b.messageId !== undefined) {
      const mid = id(b.messageId);
      const m = db.prepare("SELECT id, conversation_id, author_id, body, key_version, deleted_at FROM messages WHERE id = ?").get(mid) as
        | { id: number; conversation_id: number; author_id: number; body: string; key_version: number | null; deleted_at: string | null }
        | undefined;
      const isMember = m && !!db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(m.conversation_id, me.id);
      if (!m || !isMember || m.deleted_at) throw new HttpError(404, "No such message");
      if (m.author_id === me.id) throw new HttpError(400, "You can't report your own message");
      const channel = servers.channelOrThreadChannel(m.conversation_id);
      const serverId = channel ? servers.serverOfMessage(mid) ?? null : null;
      row = {
        reporter_id: me.id,
        reported_id: m.author_id,
        server_id: serverId,
        conversation_id: m.conversation_id,
        message_id: mid,
        reason: b.reason,
        details,
        // Plain messages are copied as they are, so deleting one doesn't lose it; encrypted ones
        // only carry what the reporter shared.
        quote: m.key_version === null && m.body ? m.body.slice(0, 4000) : text(b.quote, 4000) || null,
        place: channel ? `#${channel.name}` : m.key_version === null ? "A group or direct message" : "An encrypted chat",
      };
    } else if (b.userId !== undefined) {
      const other = users.byId(id(b.userId));
      if (!other) throw new HttpError(404, "No such person");
      if (other.id === me.id) throw new HttpError(400, "You can't report yourself");
      row = { reporter_id: me.id, reported_id: other.id, server_id: null, conversation_id: null, message_id: null, reason: b.reason, details, quote: null, place: "Their account" };
    } else {
      throw new HttpError(400, "Report a messageId or a userId");
    }
    const res = db
      .prepare(
        `INSERT INTO reports (reporter_id, reported_id, server_id, conversation_id, message_id, reason, details, quote, place, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.reporter_id, row.reported_id, row.server_id, row.conversation_id, row.message_id, row.reason, row.details, row.quote, row.place, now());
    gateway.send(row.server_id !== null ? reviewers(row.server_id) : superAdmins(), { type: "report.created", serverId: row.server_id });
    return { id: Number(res.lastInsertRowid) };
  });

  const list = (where: string, args: (number | null)[], open: boolean) =>
    (
      db
        .prepare(`SELECT * FROM reports WHERE ${where} ${open ? "AND resolved_at IS NULL" : ""} ORDER BY resolved_at IS NOT NULL, id DESC LIMIT 200`)
        .all(...args) as unknown as ReportRow[]
    ).map(toReport);

  const reviewer = (serverId: number, me: UserRecord) => {
    if (!servers.role(serverId, me.id)) throw new HttpError(404, "No such server");
    if (!servers.can(serverId, me.id, "deleteMessages")) throw new HttpError(403, "You need Delete messages to see reports");
  };
  const superAdmin = (req: FastifyRequest) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
    return me;
  };

  /** A server's reports, open ones first. ?open=1 for open ones only. */
  app.get<{ Params: { id: string }; Querystring: { open?: string } }>("/api/servers/:id/reports", async (req) => {
    const me = requireUser(req);
    const serverId = id(req.params.id);
    reviewer(serverId, me);
    return list("server_id = ?", [serverId], req.query.open === "1");
  });

  /** Reports for super admins: people, and messages outside servers. */
  app.get<{ Querystring: { open?: string } }>("/api/admin/reports", async (req) => {
    superAdmin(req);
    return list("server_id IS NULL", [], req.query.open === "1");
  });

  /** Marks a report done ({ resolved: true }) or opens it again. */
  app.post<{ Params: { id: string }; Body: { resolved?: unknown } }>("/api/reports/:id/resolve", async (req) => {
    const me = requireUser(req);
    const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(id(req.params.id)) as ReportRow | undefined;
    if (!r) throw new HttpError(404, "No such report");
    if (r.server_id !== null) reviewer(r.server_id, me);
    else if (!me.isSuperAdmin) throw new HttpError(404, "No such report");
    const done = req.body?.resolved !== false;
    db.prepare("UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE id = ?").run(done ? now() : null, done ? me.id : null, r.id);
    return toReport(db.prepare("SELECT * FROM reports WHERE id = ?").get(r.id) as unknown as ReportRow);
  });

  // ---- Your data ------------------------------------------------------------------

  /**
   * Everything Dendrop keeps about you, as one JSON file: your account, friends, blocks,
   * servers and the messages you wrote. Messages in encrypted chats are exported as the server
   * has them (encrypted); your apps can read them, the server can't.
   */
  app.get("/api/me/export", async (req, reply) => {
    const me = requireUser(req);
    const all = <T>(sql: string, ...args: (number | string)[]) => db.prepare(sql).all(...args) as T[];
    const data = {
      exportedAt: now(),
      account: {
        ...toMe(me),
        createdAt: me.createdAt,
        signIns: { password: !!me.passwordHash, tinyauth: !!me.oidcSubject, google: !!me.googleSubject },
      },
      friends: all<{ other: number; accepted_at: string | null; created_at: string }>(
        "SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS other, accepted_at, created_at FROM friendships WHERE user_a = ? OR user_b = ?",
        me.id,
        me.id,
        me.id,
      ).map((f) => ({ user: pub(f.other), friendsSince: f.accepted_at, requestedAt: f.created_at })),
      blocked: all<{ blocked_id: number; created_at: string }>("SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ?", me.id).map((b) => ({ user: pub(b.blocked_id), since: b.created_at })),
      servers: all<{ id: number; name: string; role: string; nickname: string | null; joined_at: string }>(
        "SELECT s.id, s.name, m.role, m.nickname, m.joined_at FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ?",
        me.id,
      ),
      conversations: all<{ id: number; kind: string; is_group: number; name: string | null; joined_at: string }>(
        "SELECT c.id, c.kind, c.is_group, c.name, m.joined_at FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = ?",
        me.id,
      ),
      messages: all<{ id: number; conversation_id: number; body: string; key_version: number | null; created_at: string; edited_at: string | null }>(
        "SELECT id, conversation_id, body, key_version, created_at, edited_at FROM messages WHERE author_id = ? AND deleted_at IS NULL ORDER BY id",
        me.id,
      ).map((m) => ({ id: m.id, conversationId: m.conversation_id, encrypted: m.key_version !== null, body: m.body, createdAt: m.created_at, editedAt: m.edited_at })),
      files: all<{ id: string; message_id: number; name: string; size: number; content_type: string; created_at: string }>(
        "SELECT a.id, a.message_id, a.name, a.size, a.content_type, a.created_at FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id = ?",
        me.id,
      ),
      reactions: all("SELECT message_id, emoji, created_at FROM message_reactions WHERE user_id = ?", me.id),
    };
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="dendrop-${me.username}-${now().slice(0, 10)}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  // ---- Deleting your account ------------------------------------------------------

  /**
   * Deletes your account for good: your messages, files, reactions, friends and sign-ins go
   * with it. Confirm with { password }, or { username } for accounts without one. Owners give
   * their servers away (or delete them) first, and kid accounts ask a parent.
   */
  app.delete<{ Body: { password?: unknown; username?: unknown } }>("/api/me", async (req, reply) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    if (me.passwordHash) {
      if (typeof b.password !== "string" || !(await verifyPassword(b.password, me.passwordHash))) throw new HttpError(403, "That password isn't right");
    } else if (typeof b.username !== "string" || b.username.toLowerCase() !== me.username.toLowerCase()) {
      throw new HttpError(403, "Type your username to confirm");
    }
    if (toMe(me).isKid) throw new HttpError(403, "Kid accounts can't delete themselves. Ask a parent.");
    const owned = all(db, "SELECT name FROM servers WHERE owner_id = ?", me.id).map((r) => (r as { name: string }).name);
    if (owned.length) throw new HttpError(409, `Give your servers to someone else or delete them first: ${owned.join(", ")}`);
    const kids = all(db, "SELECT display_name FROM users WHERE managed_by = ?", me.id).map((r) => (r as { display_name: string }).display_name);
    if (kids.length) throw new HttpError(409, `You look after these kid accounts, so delete them or hand them to another parent first: ${kids.join(", ")}`);
    if (me.isSuperAdmin && superAdmins().length === 1 && users.count() > 1) throw new HttpError(409, "You're the only super admin. Make someone else a super admin first.");

    // Files on disk go too: attachments on their messages, and profile pictures.
    const files = [
      ...all(db, "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id = ?", me.id).map((r) => (r as { id: string }).id),
      me.avatarFile,
      me.bannerFile,
    ].filter((f): f is string => !!f);
    const touched = all(db, "SELECT conversation_id FROM conversation_members WHERE user_id = ?", me.id).map((r) => (r as { conversation_id: number }).conversation_id);
    const serverIds = all(db, "SELECT server_id FROM server_members WHERE user_id = ?", me.id).map((r) => (r as { server_id: number }).server_id);
    const friendIds = all(db, "SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS other FROM friendships WHERE user_a = ? OR user_b = ?", me.id, me.id, me.id).map(
      (r) => (r as { other: number }).other,
    );
    ctx.couples.wipeFor(me.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(me.id);
    for (const f of files) rmSync(path.join(uploads, path.basename(f)), { force: true });
    gateway.closeUser(me.id, "Account deleted");
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    // Everyone who could see them hears they're gone.
    for (const other of friendIds) gateway.send([other], { type: "friend.removed", userId: me.id });
    // DMs and group chats show who's left in them.
    for (const cid of touched) {
      if (servers.channelOrThreadChannel(cid)) continue;
      for (const uid of convos.memberIds(cid)) {
        const c = convos.get(cid, uid);
        if (c) gateway.send([uid], { type: "conversation.updated", conversation: c });
      }
    }
    for (const sid of serverIds) ctx.serverChanged?.(sid);
    req.log.info({ userId: me.id }, "account deleted");
    return { ok: true };
  });
}

function all(db: Context["db"], sql: string, ...args: number[]): unknown[] {
  return db.prepare(sql).all(...args);
}
