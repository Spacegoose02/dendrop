import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { SearchService, type SearchQuery } from "../search.js";

/** Message search, notification settings and link previews. */
export function searchRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users } = ctx;
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const search = new SearchService(db, convos);

  // ---- Search -----------------------------------------------------------------------

  /** ?q=words&conversationId=&serverId=&authorId=&has=file|link|image&before=messageId */
  app.get<{ Querystring: SearchQuery }>("/api/search", async (req) => {
    const me = requireUser(req);
    const q = req.query ?? {};
    if (q.conversationId && !convos.isMember(Number(q.conversationId), me.id)) throw new HttpError(404, "No such conversation");
    if (q.serverId && !db.prepare("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?").get(Number(q.serverId), me.id)) {
      throw new HttpError(404, "No such server");
    }
    return search.search(me.id, q);
  });

  // ---- Notification settings ------------------------------------------------------------

  app.get("/api/notification-settings", async (req) => ctx.notifications.settings(requireUser(req).id));

  /** { conversationId, level } or { serverId, level }; level is all, mentions, nothing or null (back to the default). */
  app.put<{ Body: { conversationId?: unknown; serverId?: unknown; level?: unknown } }>("/api/notification-settings", async (req) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    const level = b.level === undefined ? null : b.level;
    if (b.conversationId !== undefined) {
      const cid = Number(b.conversationId);
      if (!Number.isInteger(cid) || !convos.isMember(cid, me.id)) throw new HttpError(404, "No such conversation");
      return ctx.notifications.set(me.id, "conversation", cid, level);
    }
    if (b.serverId !== undefined) {
      const sid = Number(b.serverId);
      if (!Number.isInteger(sid) || !db.prepare("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?").get(sid, me.id)) {
        throw new HttpError(404, "No such server");
      }
      return ctx.notifications.set(me.id, "server", sid, level);
    }
    throw new HttpError(400, "Say which conversationId or serverId");
  });

  // ---- Link previews ----------------------------------------------------------------------

  /** Whether you get previews here: on for the server, and allowed for your account. */
  app.get("/api/link-previews/settings", async (req) => ({ enabled: ctx.linkPreviews.allowed(requireUser(req)) }));

  app.get<{ Querystring: { url?: string } }>("/api/link-previews", async (req) => {
    const me = requireUser(req);
    return { preview: await ctx.linkPreviews.preview(me, req.query?.url) };
  });

  app.get<{ Params: { id: string } }>("/api/link-previews/image/:id", async (req, reply) => {
    const me = requireUser(req);
    const { data, type } = ctx.linkPreviews.image(me, req.params.id);
    return reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=86400")
      .send(data);
  });

  const superAdmin = (req: FastifyRequest) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only super admins can do that");
    return me;
  };

  app.get("/api/admin/link-previews", async (req) => {
    superAdmin(req);
    return ctx.linkPreviews.settings();
  });

  app.put<{ Body: { enabled?: unknown } }>("/api/admin/link-previews", async (req) => {
    superAdmin(req);
    return ctx.linkPreviews.setSettings(req.body ?? {});
  });
}
