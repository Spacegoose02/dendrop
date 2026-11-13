import { ECDH, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { INLINE_IMAGE_TYPES, isUsername, LIMITS, type E2eeSetup, type KeyBackup } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { CallService } from "../calls.js";
import { ConversationRepo, type NewAttachment, type SendOptions } from "../conversations.js";
import { HttpError } from "../errors.js";
import { livekitUrl } from "../livekit.js";
import { BlockRepo } from "../blocks.js";
import { FriendRepo } from "../friends.js";
import { presenceNow, toMe, toPublic } from "../users.js";

const keyVersion = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad keyVersion");
  return n;
};

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
  const blocks = new BlockRepo(db, users);
  /** Whether friends see someone as online: connected, and not appearing offline. */
  const looksOnline = (userId: number) => {
    const u = users.byId(userId);
    return !!u && gateway.isOnline(userId) && presenceNow(u) !== "invisible";
  };
  const isDnd = (userId: number) => {
    const u = users.byId(userId);
    return !!u && presenceNow(u) === "dnd";
  };
  const friendView = (f: NonNullable<ReturnType<typeof friends.view>>) => {
    const on = f.state === "friends" && looksOnline(f.user.id);
    return { ...f, online: on, ...(on && isDnd(f.user.id) ? { dnd: true } : {}) };
  };
  /** A 403 when this is a 1:1 DM and either person blocked the other. */
  const notBlocked = (cid: number, me: number) => {
    const other = convos.dmPartner(cid, me);
    if (other !== undefined && blocks.between(me, other)) throw new HttpError(403, "You can't message this person");
  };

  /** Tells both sides how their friendship looks now. */
  const pushFriend = (a: number, b: number) => {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const f = friends.view(me, other);
      gateway.send(
        [me],
        f ? { type: "friend.updated", friend: friendView(f) } : { type: "friend.removed", userId: other },
      );
    }
  };

  // Presence goes to friends only, and typing to the other people in the conversation.
  const calls = new CallService(config, gateway, ctx.callRingMs);
  app.addHook("onClose", async () => calls.closeAll());

  /** Tells someone's friends how they show up now. Someone appearing offline never shows as online. */
  const announcePresence = (userId: number, online: boolean) => {
    const ids = friends.list(userId).filter((f) => f.state === "friends").map((f) => f.user.id);
    const u = users.byId(userId);
    const shown = online && !!u && presenceNow(u) !== "invisible";
    gateway.send(ids, { type: "presence", userId, online: shown, ...(shown && isDnd(userId) ? { dnd: true } : {}) });
  };
  ctx.onPresence.push((userId, online) => {
    if (!online) calls.leaveAll(userId);
    announcePresence(userId, online);
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
    return friends.list(me.id).map(friendView);
  });

  /** Sends a friend request by username, or accepts theirs if they already asked. */
  app.post<{ Body: { username?: unknown } }>("/api/friends", async (req) => {
    const me = requireUser(req);
    const name = req.body?.username;
    const other = isUsername(name) ? users.byUsername(name) : undefined;
    if (!other) throw new HttpError(404, "No one has that username");
    if (other.id === me.id) throw new HttpError(400, "You can't add yourself");
    // Bots live in server channels only, so they're never in DMs or encrypted chats.
    if (other.isBot) throw new HttpError(400, "Bots can't be friends; add them to a server instead");
    if (blocks.has(me.id, other.id)) throw new HttpError(409, "You blocked them. Unblock them first.");
    // The same answer as a missing username, so a blocked person can't tell.
    if (blocks.has(other.id, me.id)) throw new HttpError(404, "No one has that username");
    const f = friends.request(me.id, other.id);
    pushFriend(me.id, other.id);
    ctx.family.friendsChanged(me.id, other.id);
    return f;
  });

  app.post<{ Params: { id: string } }>("/api/friends/:id/accept", async (req) => {
    const me = requireUser(req);
    const other = id(req.params.id);
    let f;
    try {
      if (blocks.between(me.id, other)) throw new Error("There's no friend request from them");
      f = friends.accept(me.id, other);
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    pushFriend(me.id, other);
    ctx.family.friendsChanged(me.id, other);
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

  // ---- Presence -----------------------------------------------------------------

  /**
   * How you show up: { presence: "online" | "dnd" | "invisible", minutes? }. minutes ends Do Not
   * Disturb by itself. Friends hear straight away; your other devices too.
   */
  app.put<{ Body: { presence?: unknown; minutes?: unknown } }>("/api/me/presence", async (req) => {
    const me = requireUser(req);
    const { presence, minutes } = req.body ?? {};
    if (presence !== "online" && presence !== "dnd" && presence !== "invisible") throw new HttpError(400, "presence is online, dnd or invisible");
    let until: string | null = null;
    if (minutes !== undefined && minutes !== null) {
      const n = Number(minutes);
      if (!Number.isInteger(n) || n < 1 || n > 7 * 24 * 60) throw new HttpError(400, "minutes is 1 to a week");
      until = new Date(Date.now() + n * 60_000).toISOString();
    }
    const updated = users.setPresence(me.id, presence, until);
    announcePresence(me.id, gateway.isOnline(me.id));
    gateway.send([me.id], { type: "me.updated", user: toMe(updated) });
    return toMe(updated);
  });

  // ---- Blocking -----------------------------------------------------------------

  const pushBlocks = (me: number) => gateway.send([me], { type: "blocks.updated", blocked: blocks.list(me) });

  app.get("/api/blocks", async (req) => blocks.list(requireUser(req).id));

  /** Blocks someone: ends any friendship or request, and stops their 1:1 DM both ways. */
  app.post<{ Body: { userId?: unknown } }>("/api/blocks", async (req) => {
    const me = requireUser(req);
    const other = users.byId(id(req.body?.userId));
    if (!other) throw new HttpError(404, "No such person");
    if (other.id === me.id) throw new HttpError(400, "You can't block yourself");
    blocks.block(me.id, other.id);
    if (friends.remove(me.id, other.id)) pushFriend(me.id, other.id);
    // A call in progress between the two ends now.
    const dm = convos.openDmIfExists(me.id, other.id);
    if (dm !== undefined) {
      calls.leave(dm, me.id);
      calls.leave(dm, other.id);
    }
    pushBlocks(me.id);
    return toPublic(other);
  });

  app.delete<{ Params: { id: string } }>("/api/blocks/:id", async (req) => {
    const me = requireUser(req);
    if (!blocks.unblock(me.id, id(req.params.id))) throw new HttpError(404, "You haven't blocked them");
    pushBlocks(me.id);
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

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    return convos.get(cid, me.id);
  });

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
  const readMessage = async (req: FastifyRequest): Promise<{ body: unknown; files: NewAttachment[]; keyVersion: number | null; extras: SendOptions }> => {
    if (!req.isMultipart()) {
      const json = req.body as
        | { body?: unknown; keyVersion?: unknown; replyToId?: unknown; replyPing?: unknown; mentions?: unknown; mentionsEveryone?: unknown; forwardOf?: unknown }
        | undefined;
      return {
        body: json?.body,
        files: [],
        keyVersion: keyVersion(json?.keyVersion),
        extras: { replyToId: json?.replyToId, replyPing: json?.replyPing, mentions: json?.mentions, mentionsEveryone: json?.mentionsEveryone, forwardOf: json?.forwardOf },
      };
    }
    const files: NewAttachment[] = [];
    let body: unknown;
    let kv: number | null = null;
    const extras: SendOptions = {};
    try {
      for await (const part of req.parts({ limits: { fileSize: config.maxUploadBytes, files: LIMITS.attachmentsPerMessage, fields: 8 } })) {
        if (part.type === "field") {
          if (part.fieldname === "body") body = part.value;
          if (part.fieldname === "keyVersion") kv = keyVersion(part.value);
          if (part.fieldname === "replyToId") extras.replyToId = part.value;
          if (part.fieldname === "forwardOf") extras.forwardOf = part.value;
          if (part.fieldname === "replyPing") extras.replyPing = part.value !== "false";
          if (part.fieldname === "mentionsEveryone") extras.mentionsEveryone = part.value === "true";
          if (part.fieldname === "mentions") {
            try {
              extras.mentions = JSON.parse(String(part.value));
            } catch {
              throw new HttpError(400, "mentions is a list of user ids");
            }
          }
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
    // Encrypted files carry their real name and type inside the message, so store neither.
    if (kv) for (const f of files) Object.assign(f, { name: "file", contentType: "application/octet-stream" });
    return { body, files, keyVersion: kv, extras };
  };

  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    notBlocked(cid, me.id);
    const msg = await readMessage(req);
    const { body, files } = msg;
    let m;
    try {
      // Server channels: automod checks it first (and may block it or time the sender out).
      ctx.automod.checkMessage(cid, me, body);
      const canMentionEveryone = ctx.canMentionEveryone?.(cid, me.id) ?? true;
      m = convos.send(cid, me.id, body, files, msg.keyVersion, null, null, { ...msg.extras, canMentionEveryone });
    } catch (err) {
      removeFiles(files.map((f) => f.id));
      throw err;
    }
    // First, so clients learn a thread exists before its messages arrive.
    for (const fn of ctx.onMessageCreated) fn(m);
    // Everyone gets it, marked with whether their notification settings want a heads-up.
    ctx.notifications.deliver(m, convos.memberIds(cid), me.id);
    ctx.levels?.award(cid, me);
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
    notBlocked(cid, me.id);
    const isNew = !calls.get(cid);
    const join = await calls.join(cid, convos.memberIds(cid), me, req.body?.video === true, livekitUrl(config, req));
    // A new call rings everyone's phones too, even if a PC is already ringing.
    if (isNew) void ctx.push.notify(join.call.ringing, "call");
    return join;
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

  /** Unread counts for every conversation with unread messages: DMs, groups, channels and threads. */
  app.get("/api/unread", async (req) => convos.unread(requireUser(req).id));

  /** "Mark as unread" from a message on. Only for you: read receipts others saw stay. */
  app.post<{ Params: { id: string }; Body: { messageId?: unknown } }>("/api/conversations/:id/unread", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    convos.markUnread(cid, me.id, id(req.body?.messageId));
    const unread = convos.unread(me.id, cid)[0]!;
    gateway.send([me.id], { type: "unread", unread });
    return unread;
  });

  app.patch<{ Params: { id: string }; Body: { body?: unknown; keyVersion?: unknown; mentions?: unknown; mentionsEveryone?: unknown } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const mid = id(req.params.id);
    ctx.automod.checkEdit(mid, me, req.body?.body);
    const cid = convos.message(mid)?.conversationId;
    const canMentionEveryone = cid ? (ctx.canMentionEveryone?.(cid, me.id) ?? true) : false;
    const m = convos.edit(mid, me.id, req.body?.body, keyVersion(req.body?.keyVersion), { mentions: req.body?.mentions, mentionsEveryone: req.body?.mentionsEveryone, canMentionEveryone });
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });

  /** A message's earlier versions, oldest first (see MessageEdit). */
  app.get<{ Params: { id: string } }>("/api/messages/:id/edits", async (req) => convos.edits(id(req.params.id), requireUser(req).id));

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const mid = id(req.params.id);
    // A kid's parents get a copy of what they delete, files included, so those stay on disk.
    const kept = ctx.family.keepBeforeDelete(me.id, mid);
    let result;
    try {
      result = convos.delete(mid, me.id);
    } catch (err) {
      ctx.family.afterDelete(me.id, mid, false);
      throw err;
    }
    const { message: m, removedFiles } = result;
    ctx.family.afterDelete(me.id, mid, true);
    removeFiles(removedFiles.filter((f) => !kept.has(f)));
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });
  // ---- End-to-end encryption ------------------------------------------------------

  /** Sends each member their own view of a conversation (read receipts differ per person). */
  const pushConversation = (cid: number) => {
    for (const uid of convos.memberIds(cid)) gateway.send([uid], { type: "conversation.updated", conversation: convos.get(cid, uid)! });
  };

  app.get("/api/e2ee", async (req): Promise<E2eeSetup> => {
    const me = requireUser(req);
    return { publicKey: me.publicKey, backup: me.keyBackup ? (JSON.parse(me.keyBackup) as KeyBackup) : null };
  });

  /**
   * Saves your public key and passphrase-encrypted private key. With the same public key this
   * changes the passphrase. A new public key needs reset: true, because messages encrypted to
   * the old one can't be read again.
   */
  app.put<{ Body: { publicKey?: unknown; backup?: unknown; reset?: unknown } }>("/api/e2ee", async (req): Promise<E2eeSetup> => {
    const me = requireUser(req);
    const { publicKey, backup, reset } = req.body ?? {};
    if (!isPublicKey(publicKey)) throw new HttpError(400, "That isn't a P-256 public key");
    const b = cleanBackup(backup);
    const changed = me.publicKey !== null && me.publicKey !== publicKey;
    if (changed && reset !== true) throw new HttpError(409, "You already have encryption keys; resetting them needs reset: true");
    const user = users.setKeys(me.id, publicKey, JSON.stringify(b));
    if (me.publicKey !== publicKey) for (const c of convos.list(me.id)) pushConversation(c.id);
    return { publicKey: user.publicKey, backup: b };
  });

  /** Your copies of a conversation's keys, one per version you can read. */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/keys", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    return convos.wrappedKeys(cid, me.id);
  });

  /** Adds the next key version: { version, keys: { [userId]: { publicKey, wrapped } } }. */
  app.post<{ Params: { id: string }; Body: { version?: unknown; keys?: unknown } }>("/api/conversations/:id/keys", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    convos.addKey(cid, me.id, req.body?.version, req.body?.keys);
    pushConversation(cid);
    return convos.get(cid, me.id);
  });
}

function isPublicKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(v)) return false;
  try {
    // Throws unless it's an uncompressed point on the curve.
    ECDH.convertKey(Buffer.from(v, "base64url"), "prime256v1", undefined, undefined, "uncompressed");
    return Buffer.from(v, "base64url")[0] === 4;
  } catch {
    return false;
  }
}

function cleanBackup(v: unknown): KeyBackup {
  const b = (v ?? {}) as Partial<Record<keyof KeyBackup, unknown>>;
  const b64 = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
  const iterations = Number(b.iterations);
  if (!b64(b.salt, 64) || !b64(b.iv, 32) || !b64(b.ciphertext, 1024) || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) {
    throw new HttpError(400, "That isn't a key backup");
  }
  return { salt: b.salt, iterations, iv: b.iv, ciphertext: b.ciphertext };
}

/** A safe display name for an uploaded file: no paths or control characters. */
function cleanName(name: string | undefined): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (base || "file").slice(0, 200);
}

function cleanType(type: string | undefined): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type ?? "") ? type!.toLowerCase() : "application/octet-stream";
}
