import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { INLINE_IMAGE_TYPES, isUsername, LIMITS } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { CallService } from "../calls.js";
import { ConversationRepo, type NewAttachment } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** Friends, direct messages and group DMs. */
export function dmRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, config } = ctx;
  const uploads = path.join(config.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const removeFiles = (ids: string[]) => {
    for (const f of ids) rmSync(path.join(uploads, f), { force: true });
  };
  const friends = new FriendRepo(db, users);
  const convos = new ConversationRepo(db, users, friends);

  /** Tells both sides how their friendship looks now. */
  const pushFriend = (a: number, b: number) => {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const f = friends.view(me, other);
      gateway.send(
        [me],
        f ? { type: "friend.updated", friend: { ...f, online: f.state === "friends" && gateway.isOnline(other) } } : { type: "friend.removed", userId: other },
      );
    }
  };

  // Presence goes to friends only, and typing to the other people in the conversation.
  const calls = new CallService(config, gateway, ctx.callRingMs);
  app.addHook("onClose", async () => calls.closeAll());

  ctx.onPresence.push((userId, online) => {
    if (!online) calls.leaveAll(userId);
    const ids = friends.list(userId).filter((f) => f.state === "friends").map((f) => f.user.id);
    gateway.send(ids, { type: "presence", userId, online });
  });
  ctx.onClientEvent.push((user, event) => {
    if (event.type !== "typing") return;
    const cid = Number(event.conversationId);
    if (!convos.isMember(cid, user.id)) return;
    gateway.send(convos.memberIds(cid).filter((m) => m !== user.id), { type: "typing", conversationId: cid, userId: user.id });
  });

  // ---- Friends ----------------------------------------------------------------

  app.get("/api/friends", async (req) => {
    const me = requireUser(req);
    return friends.list(me.id).map((f) => ({ ...f, online: f.state === "friends" && gateway.isOnline(f.user.id) }));
  });

  /** Sends a friend request by username, or accepts theirs if they already asked. */
  app.post<{ Body: { username?: unknown } }>("/api/friends", async (req) => {
    const me = requireUser(req);
    const name = req.body?.username;
    const other = isUsername(name) ? users.byUsername(name) : undefined;
    if (!other) throw new HttpError(404, "No one has that username");
    if (other.id === me.id) throw new HttpError(400, "You can't add yourself");
    const f = friends.request(me.id, other.id);
    pushFriend(me.id, other.id);
    return f;
  });

  app.post<{ Params: { id: string } }>("/api/friends/:id/accept", async (req) => {
    const me = requireUser(req);
    const other = id(req.params.id);
    let f;
    try {
      f = friends.accept(me.id, other);
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    pushFriend(me.id, other);
    return f;
  });

  /** Removes a friend, or declines or cancels a request. Existing conversations stay readable. */
  app.delete<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    const other = id(req.params.id);
    if (!friends.remove(me.id, other)) throw new HttpError(404, "Not a friend or request");
    pushFriend(me.id, other);
    return { ok: true };
  });

  // ---- Conversations ------------------------------------------------------------

  app.get("/api/conversations", async (req) => convos.list(requireUser(req).id));

  /** { userId } opens the 1:1 DM with a friend; { userIds, name } makes a group DM. */
  app.post<{ Body: { userId?: unknown; userIds?: unknown; name?: unknown } }>("/api/conversations", async (req) => {
    const me = requireUser(req);
    const body = req.body ?? {};
    if (Array.isArray(body.userIds)) {
      const c = convos.createGroup(me.id, body.userIds.map(id), typeof body.name === "string" ? body.name : null);
      gateway.send(convos.memberIds(c.id), { type: "conversation.created", conversation: c });
      return c;
    }
    const { conversation, created } = convos.openDm(me.id, id(body.userId));
    if (created) gateway.send(convos.memberIds(conversation.id), { type: "conversation.created", conversation });
    return conversation;
  });

  const member = (cid: number, userId: number) => {
    if (!convos.isMember(cid, userId)) throw new HttpError(404, "No such conversation");
  };

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>("/api/conversations/:id/messages", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    return convos.messages(cid, req.query.before ? id(req.query.before) : undefined, req.query.limit ? Number(req.query.limit) : undefined);
  });

  /**
   * Reads a message from JSON ({ body }) or multipart (a "body" field plus files). Files are
   * streamed to the uploads folder; on any error the ones already written are removed.
   */
  const readMessage = async (req: FastifyRequest): Promise<{ body: unknown; files: NewAttachment[] }> => {
    if (!req.isMultipart()) return { body: (req.body as { body?: unknown } | undefined)?.body, files: [] };
    const files: NewAttachment[] = [];
    let body: unknown;
    try {
      for await (const part of req.parts({ limits: { fileSize: config.maxUploadBytes, files: LIMITS.attachmentsPerMessage, fields: 4 } })) {
        if (part.type === "field") {
          if (part.fieldname === "body") body = part.value;
          continue;
        }
        if (files.length >= LIMITS.attachmentsPerMessage) throw new HttpError(400, `Up to ${LIMITS.attachmentsPerMessage} files per message`);
        const fileId = randomBytes(16).toString("hex");
        const dest = path.join(uploads, fileId);
        files.push({ id: fileId, name: cleanName(part.filename), size: 0, contentType: cleanType(part.mimetype) });
        await pipeline(part.file, createWriteStream(dest, { flags: "wx" }));
        if (part.file.truncated) {
          throw new HttpError(413, `Files can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
        }
        files[files.length - 1]!.size = statSync(dest).size;
      }
    } catch (err) {
      removeFiles(files.map((f) => f.id));
      if (err instanceof HttpError) throw err;
      const code = (err as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, `Files can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
      if (code === "FST_FILES_LIMIT") throw new HttpError(400, `Up to ${LIMITS.attachmentsPerMessage} files per message`);
      throw err;
    }
    return { body, files };
  };

  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    const { body, files } = await readMessage(req);
    let m;
    try {
      m = convos.send(cid, me.id, body, files);
    } catch (err) {
      removeFiles(files.map((f) => f.id));
      throw err;
    }
    gateway.send(convos.memberIds(cid), { type: "message.created", message: m });
    return m;
  });

  /** Downloads a file. Only pictures are shown in the browser; everything else downloads. */
  app.get<{ Params: { id: string; name: string } }>("/api/attachments/:id/:name", async (req, reply) => {
    const me = requireUser(req);
    const a = /^[0-9a-f]{32}$/.test(req.params.id) ? convos.attachment(req.params.id, me.id) : undefined;
    if (!a) throw new HttpError(404, "No such file");
    const inline = INLINE_IMAGE_TYPES.includes(a.contentType);
    return reply
      .header("content-type", inline ? a.contentType : "application/octet-stream")
      .header("content-length", a.size)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(path.join(uploads, a.id)));
  });

  // ---- Calls ------------------------------------------------------------------

  app.get("/api/calls", async (req) => {
    const me = requireUser(req);
    return calls.forUser(me.id);
  });

  /** Starts a call in a conversation, or joins the one going. Returns a LiveKit token. */
  app.post<{ Params: { id: string }; Body: { video?: unknown } }>("/api/conversations/:id/call", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    return calls.join(cid, convos.memberIds(cid), me, req.body?.video === true);
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/call/decline", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    calls.decline(cid, me.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/call/leave", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    calls.leave(cid, me.id);
    return { ok: true };
  });

  /** Marks messages up to `messageId` as read and tells the others, if receipts are on. */
  app.post<{ Params: { id: string }; Body: { messageId?: unknown } }>("/api/conversations/:id/read", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    const moved = convos.markRead(cid, me.id, id(req.body?.messageId));
    if (moved && me.readReceipts) {
      const others = convos.memberIds(cid).filter((u) => u !== me.id && users.byId(u)?.readReceipts);
      gateway.send(others, { type: "read", conversationId: cid, userId: me.id, messageId: moved });
    }
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { body?: unknown } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const m = convos.edit(id(req.params.id), me.id, req.body?.body);
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const { message: m, removedFiles } = convos.delete(id(req.params.id), me.id);
    removeFiles(removedFiles);
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });
}

/** A safe display name for an uploaded file: no paths or control characters. */
function cleanName(name: string | undefined): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (base || "file").slice(0, 200);
}

function cleanType(type: string | undefined): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type ?? "") ? type!.toLowerCase() : "application/octet-stream";
}
