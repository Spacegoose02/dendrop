import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EXPRESSION_LIMITS } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { ExpressionRepo, sniffPicture } from "../expressions.js";
import { ServerRepo } from "../servers.js";
import type { UserRecord } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/**
 * Custom emoji and stickers (uploaded per server by people with Manage emoji & stickers),
 * reactions on messages, and the GIF search (see gifs.ts).
 */
export function expressionRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, config } = ctx;
  const servers = new ServerRepo(db, users);
  const expressions = new ExpressionRepo(db);
  const uploads = path.join(config.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });

  const manager = (serverId: number, user: UserRecord) => {
    const role = servers.role(serverId, user.id);
    if (!role) throw new HttpError(404, "No such server");
    if (!servers.can(serverId, user.id, "manageExpressions", role)) throw new HttpError(403, "You need Manage emoji & stickers to do that");
  };

  /** Reads a picture and its text fields from a multipart upload, checking what the bytes really are. */
  const readPicture = async (req: FastifyRequest, maxBytes: number) => {
    if (!req.isMultipart()) throw new HttpError(400, "Send the picture as multipart form data");
    const fields: Record<string, string> = {};
    let data: Buffer | undefined;
    try {
      for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 5 } })) {
        if (part.type === "field") fields[part.fieldname] = String(part.value);
        else data = await part.toBuffer();
      }
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, `Pictures here can be up to ${Math.round(maxBytes / 1024)} KB`);
      throw err;
    }
    if (!data?.length) throw new HttpError(400, "Send a picture");
    const picture = sniffPicture(data);
    if (!picture) throw new HttpError(400, "Use a PNG, GIF, WebP or JPEG picture");
    return { fields, data, picture };
  };

  const save = (data: Buffer) => {
    const file = randomBytes(16).toString("hex");
    writeFileSync(path.join(uploads, file), data, { flag: "wx" });
    return file;
  };
  const remove = (file: string) => rmSync(path.join(uploads, file), { force: true });

  const serve = (reply: FastifyReply, file: string, type: string) =>
    reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(path.join(uploads, file)));

  // ---- Custom emoji ------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/servers/:id/emojis", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    if (!servers.role(sid, me.id)) throw new HttpError(404, "No such server");
    return expressions.emojis(sid);
  });

  /** Multipart: name, and the picture (PNG, GIF, WebP or JPEG; GIFs and animated PNG/WebP move). */
  app.post<{ Params: { id: string } }>("/api/servers/:id/emojis", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    manager(sid, me);
    const { fields, data, picture } = await readPicture(req, EXPRESSION_LIMITS.emojiBytes);
    const file = save(data);
    try {
      const emoji = expressions.addEmoji(sid, me.id, fields.name, file, picture);
      ctx.serverChanged?.(sid);
      return emoji;
    } catch (err) {
      remove(file);
      throw err;
    }
  });

  app.patch<{ Params: { id: string; emojiId: string }; Body: { name?: unknown } }>("/api/servers/:id/emojis/:emojiId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    manager(sid, me);
    const emoji = expressions.renameEmoji(sid, id(req.params.emojiId), req.body?.name);
    ctx.serverChanged?.(sid);
    return emoji;
  });

  app.delete<{ Params: { id: string; emojiId: string } }>("/api/servers/:id/emojis/:emojiId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    manager(sid, me);
    remove(expressions.deleteEmoji(sid, id(req.params.emojiId)));
    ctx.serverChanged?.(sid);
    return { ok: true };
  });

  /** An emoji's picture. Anyone signed in: emoji travel in messages everywhere. */
  app.get<{ Params: { id: string } }>("/api/emojis/:id", async (req, reply) => {
    requireUser(req);
    const r = expressions.emojiRow(id(req.params.id));
    if (!r) throw new HttpError(404, "No such emoji");
    return serve(reply, r.file, r.content_type);
  });

  // ---- Stickers ------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/servers/:id/stickers", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    if (!servers.role(sid, me.id)) throw new HttpError(404, "No such server");
    return expressions.stickers(sid);
  });

  /** Multipart: name, description, emoji (one that goes with it), and the picture. */
  app.post<{ Params: { id: string } }>("/api/servers/:id/stickers", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    manager(sid, me);
    const { fields, data, picture } = await readPicture(req, EXPRESSION_LIMITS.stickerBytes);
    if (picture.type === "image/jpeg") throw new HttpError(400, "Stickers are PNG, GIF or WebP (so they can be see-through)");
    const file = save(data);
    try {
      const sticker = expressions.addSticker(sid, me.id, fields, file, picture);
      ctx.serverChanged?.(sid);
      return sticker;
    } catch (err) {
      remove(file);
      throw err;
    }
  });

  app.patch<{ Params: { id: string; stickerId: string }; Body: { name?: unknown; description?: unknown; emoji?: unknown } }>(
    "/api/servers/:id/stickers/:stickerId",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      manager(sid, me);
      const sticker = expressions.updateSticker(sid, id(req.params.stickerId), req.body ?? {});
      ctx.serverChanged?.(sid);
      return sticker;
    },
  );

  app.delete<{ Params: { id: string; stickerId: string } }>("/api/servers/:id/stickers/:stickerId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    manager(sid, me);
    remove(expressions.deleteSticker(sid, id(req.params.stickerId)));
    ctx.serverChanged?.(sid);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/stickers/:id", async (req, reply) => {
    requireUser(req);
    const r = expressions.stickerRow(id(req.params.id));
    if (!r) throw new HttpError(404, "No such sticker");
    return serve(reply, r.file, r.content_type);
  });

  // ---- Reactions -------------------------------------------------------------------------

  /** The message, if `user` can see it and react: a member, and not timed out in its server. */
  const reactable = (messageId: number, user: UserRecord) => {
    const m = db.prepare("SELECT conversation_id, deleted_at FROM messages WHERE id = ?").get(messageId) as
      | { conversation_id: number; deleted_at: string | null }
      | undefined;
    if (!m || !db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(m.conversation_id, user.id)) {
      throw new HttpError(404, "No such message");
    }
    if (m.deleted_at) throw new HttpError(409, "That message was deleted");
    const channel = db.prepare("SELECT server_id FROM server_channels WHERE conversation_id = ?").get(m.conversation_id) as { server_id: number } | undefined;
    if (channel) {
      ctx.automod.assertNotTimedOut(channel.server_id, user.id);
      servers.assertAgreed(channel.server_id, user.id);
    }
    return m.conversation_id;
  };

  const pushReactions = (conversationId: number, messageId: number) => {
    const reactions = expressions.reactions([messageId]).get(messageId) ?? [];
    const memberIds = (db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(conversationId) as { user_id: number }[]).map((r) => r.user_id);
    gateway.send(memberIds, { type: "message.reactions", conversationId, messageId, reactions });
    return reactions;
  };

  /** Reacts with an emoji ("👍", URL-encoded) or a custom emoji's token ("<:raccoon:12>"). */
  app.put<{ Params: { id: string; emoji: string } }>("/api/messages/:id/reactions/:emoji", async (req) => {
    const me = requireUser(req);
    const mid = id(req.params.id);
    const cid = reactable(mid, me);
    expressions.react(mid, me.id, req.params.emoji);
    return pushReactions(cid, mid);
  });

  app.delete<{ Params: { id: string; emoji: string } }>("/api/messages/:id/reactions/:emoji", async (req) => {
    const me = requireUser(req);
    const mid = id(req.params.id);
    const cid = reactable(mid, me);
    expressions.unreact(mid, me.id, req.params.emoji);
    return pushReactions(cid, mid);
  });

  // ---- GIFs --------------------------------------------------------------------------------

  /** ?q= searches; no q gives what's trending. ?offset= for the next page. */
  app.get<{ Querystring: { q?: string; offset?: string } }>("/api/gifs", async (req) => {
    const me = requireUser(req);
    return ctx.gifs.search(me, req.query.q, req.query.offset);
  });

  app.get<{ Params: { gifId: string; variant: string } }>("/api/gifs/media/:gifId/:variant", async (req, reply) => {
    const me = requireUser(req);
    const variant = req.params.variant;
    if (variant !== "preview" && variant !== "full") throw new HttpError(404, "Not found");
    const { data, type } = await ctx.gifs.media(me, req.params.gifId, variant);
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

  app.get("/api/admin/gifs", async (req) => {
    superAdmin(req);
    return ctx.gifs.settings();
  });

  app.put<{ Body: { enabled?: unknown; apiKey?: unknown; rating?: unknown } }>("/api/admin/gifs", async (req) => {
    superAdmin(req);
    return ctx.gifs.setSettings(req.body ?? {});
  });
}
