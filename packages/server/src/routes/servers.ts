import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { INLINE_IMAGE_TYPES, LIMITS } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { livekitUrl } from "../livekit.js";
import { isModerator, ServerRepo, type ImageKind } from "../servers.js";
import { VoiceService } from "../voice.js";
import type { UserRecord } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

const imageKind = (v: string): ImageKind => {
  if (v !== "icon" && v !== "banner") throw new HttpError(404, "Not found");
  return v;
};

/**
 * Chat servers: making and joining them, channels (open or locked to picked members), invite
 * links and friend invites, roles, and the super admin's approval of who may make servers.
 *
 * Privacy: private servers are invisible to anyone not in them (404, never 403), locked channels
 * are invisible to members who weren't picked, and super admins see server names and counts but
 * no messages.
 */
export function serverRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, config } = ctx;
  const servers = new ServerRepo(db, users);
  const friends = new FriendRepo(db, users);
  const convos = new ConversationRepo(db, users, friends);
  const uploads = path.join(config.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const removeFiles = (ids: (string | null)[]) => {
    for (const f of ids) if (f) rmSync(path.join(uploads, f), { force: true });
  };

  const voice = new VoiceService(config, gateway, (cid) => convos.memberIds(cid));
  app.addHook("onClose", async () => voice.closeAll());
  ctx.onPresence.push((userId, online) => {
    if (!online) voice.leave(userId);
  });
  /** Takes people out of voice channels they can't see any more. */
  const pruneVoice = () => voice.prune((channelId) => !!servers.channelById(channelId));

  /** Sends each member their own view (locked channels differ per person). */
  const push = (serverId: number) => {
    for (const uid of servers.memberIds(serverId)) {
      const view = servers.view(serverId, uid);
      if (view) gateway.send([uid], { type: "server.updated", server: view });
    }
    pruneVoice();
  };
  const superAdmins = () => (db.prepare("SELECT id FROM users WHERE is_super_admin = 1").all() as { id: number }[]).map((r) => r.id);

  /** The caller's role, or a 404 if they aren't in the server (so private servers stay hidden). */
  const member = (serverId: number, user: UserRecord) => {
    const role = servers.role(serverId, user.id);
    if (!role) throw new HttpError(404, "No such server");
    return role;
  };
  const moderator = (serverId: number, user: UserRecord) => {
    if (!isModerator(member(serverId, user))) throw new HttpError(403, "Only the owner and admins can do that");
  };
  const owner = (serverId: number, user: UserRecord) => {
    if (member(serverId, user) !== "owner") throw new HttpError(403, "Only the owner can do that");
  };
  const superAdmin = (req: FastifyRequest) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only super admins can do that");
    return me;
  };

  // ---- Servers -------------------------------------------------------------------

  app.get("/api/servers", async (req) => servers.list(requireUser(req).id));

  app.post<{ Body: { name?: unknown; description?: unknown; isPublic?: unknown } }>("/api/servers", async (req) => {
    const me = requireUser(req);
    const sid = servers.create(me, req.body ?? {});
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Public servers anyone can join. Private servers are never listed. */
  app.get<{ Querystring: { q?: string } }>("/api/servers/directory", async (req) => {
    requireUser(req);
    return servers.directory(req.query.q);
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    return servers.view(sid, me.id);
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; description?: unknown; isPublic?: unknown; memberInvites?: unknown } }>(
    "/api/servers/:id",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      moderator(sid, me);
      servers.update(sid, req.body ?? {});
      push(sid);
      return servers.view(sid, me.id);
    },
  );

  /** The owner deletes their server; a super admin can delete any. */
  app.delete<{ Params: { id: string } }>("/api/servers/:id", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    if (!me.isSuperAdmin) owner(sid, me);
    const memberIds = servers.memberIds(sid);
    removeFiles(servers.delete(sid));
    gateway.send(memberIds, { type: "server.removed", serverId: sid });
    pruneVoice();
    return { ok: true };
  });

  /** Sets the icon or banner from one uploaded picture. */
  app.put<{ Params: { id: string; kind: string } }>("/api/servers/:id/:kind(icon|banner)", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    const kind = imageKind(req.params.kind);
    moderator(sid, me);
    if (!req.isMultipart()) throw new HttpError(400, "Send the picture as multipart form data");
    const part = await req.file({ limits: { fileSize: LIMITS.serverImageBytes, files: 1 } });
    if (!part) throw new HttpError(400, "Send a picture");
    const type = part.mimetype.toLowerCase();
    if (!INLINE_IMAGE_TYPES.includes(type)) {
      part.file.resume();
      throw new HttpError(400, "Use a PNG, JPEG, GIF or WebP picture");
    }
    const file = randomBytes(16).toString("hex");
    const dest = path.join(uploads, file);
    try {
      await pipeline(part.file, createWriteStream(dest, { flags: "wx" }));
      if (part.file.truncated || statSync(dest).size === 0) {
        throw new HttpError(413, `Pictures can be up to ${LIMITS.serverImageBytes / 1024 / 1024} MB`);
      }
    } catch (err) {
      removeFiles([file]);
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, `Pictures can be up to ${LIMITS.serverImageBytes / 1024 / 1024} MB`);
      throw err;
    }
    removeFiles([servers.setImage(sid, kind, file, type)]);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.delete<{ Params: { id: string; kind: string } }>("/api/servers/:id/:kind(icon|banner)", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    const kind = imageKind(req.params.kind);
    moderator(sid, me);
    removeFiles([servers.setImage(sid, kind, null, null)]);
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Icons and banners: members see them, and anyone signed in for public servers (the directory). */
  app.get<{ Params: { id: string; file: string } }>("/api/servers/:id/images/:file", async (req, reply) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    const file = req.params.file;
    const pic = /^[0-9a-f]{32}$/.test(file) ? servers.image(sid, file) : undefined;
    const allowed = servers.isPublic(sid) || !!servers.role(sid, me.id) || servers.pendingFor(me.id).some((i) => i.server.id === sid);
    if (!pic || !allowed) throw new HttpError(404, "Not found");
    return reply
      .header("content-type", pic.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(path.join(uploads, file)));
  });

  // ---- Members -------------------------------------------------------------------

  /** Joins a public server straight from the directory. */
  app.post<{ Params: { id: string } }>("/api/servers/:id/join", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    if (!servers.isPublic(sid) && !servers.role(sid, me.id)) throw new HttpError(404, "No such server");
    servers.addMember(sid, me.id);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.post<{ Params: { id: string } }>("/api/servers/:id/leave", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    if (member(sid, me) === "owner") throw new HttpError(400, "Hand the server to someone else, or delete it, before leaving");
    servers.removeMember(sid, me.id);
    gateway.send([me.id], { type: "server.removed", serverId: sid });
    push(sid);
    return { ok: true };
  });

  /** Your nickname in this server ({ nickname: null } clears it). */
  app.patch<{ Params: { id: string }; Body: { nickname?: unknown } }>("/api/servers/:id/me", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.setNickname(sid, me.id, req.body?.nickname ?? null);
    push(sid);
    return servers.view(sid, me.id);
  });

  /** The owner makes someone an admin, or a member again. */
  app.patch<{ Params: { id: string; userId: string }; Body: { role?: unknown } }>("/api/servers/:id/members/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    owner(sid, me);
    servers.setRole(sid, id(req.params.userId), req.body?.role);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>("/api/servers/:id/transfer", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    owner(sid, me);
    servers.transfer(sid, me.id, id(req.body?.userId));
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Removes someone, and with ?ban=true keeps them out. Admins can't remove the owner or other admins. */
  app.delete<{ Params: { id: string; userId: string }; Querystring: { ban?: string } }>("/api/servers/:id/members/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    const myRole = member(sid, me);
    const target = id(req.params.userId);
    const theirRole = servers.role(sid, target);
    if (!isModerator(myRole)) throw new HttpError(403, "Only the owner and admins can do that");
    if (!theirRole) throw new HttpError(404, "They aren't in this server");
    if (target === me.id) throw new HttpError(400, "Leave the server instead");
    if (theirRole === "owner" || (theirRole === "admin" && myRole !== "owner")) throw new HttpError(403, "Only the owner can remove an admin");
    servers.removeMember(sid, target, req.query.ban === "true" ? { by: me.id } : null);
    gateway.send([target], { type: "server.removed", serverId: sid });
    push(sid);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id/bans", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    moderator(sid, me);
    return servers.bans(sid);
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/servers/:id/bans/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    moderator(sid, me);
    if (!servers.unban(sid, id(req.params.userId))) throw new HttpError(404, "They aren't banned");
    return { ok: true };
  });

  // ---- Channels ------------------------------------------------------------------
  // Messages in a channel go through /api/conversations/:conversationId/messages like DMs.

  app.post<{ Params: { id: string }; Body: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown; kind?: unknown } }>(
    "/api/servers/:id/channels",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      moderator(sid, me);
      const channel = servers.createChannel(sid, req.body ?? {});
      push(sid);
      return channel;
    },
  );

  app.put<{ Params: { id: string }; Body: { ids?: unknown } }>("/api/servers/:id/channels/order", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    moderator(sid, me);
    servers.reorderChannels(sid, req.body?.ids);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.patch<{ Params: { id: string; channelId: string }; Body: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown } }>(
    "/api/servers/:id/channels/:channelId",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      moderator(sid, me);
      servers.updateChannel(sid, id(req.params.channelId), req.body ?? {});
      push(sid);
      return servers.view(sid, me.id);
    },
  );

  app.delete<{ Params: { id: string; channelId: string } }>("/api/servers/:id/channels/:channelId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    moderator(sid, me);
    removeFiles(servers.deleteChannel(sid, id(req.params.channelId)));
    push(sid);
    return { ok: true };
  });

  // ---- Voice channels -------------------------------------------------------------
  // Drop-in rooms: no ringing. Media goes through LiveKit, one room per channel.

  /** Voice channels with people in them, in every server you're in (only ones you can see). */
  app.get("/api/voice", async (req) => voice.forUser(requireUser(req).id));

  /** Joins a voice channel (leaving any other one). Returns a LiveKit token for its room. */
  app.post<{ Params: { id: string; channelId: string } }>("/api/servers/:id/channels/:channelId/voice", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    const c = servers.channelById(id(req.params.channelId));
    // Locked channels you weren't picked for don't exist, as far as you can tell.
    if (!c || c.serverId !== sid || !convos.isMember(c.conversationId, me.id)) throw new HttpError(404, "No such channel");
    if (c.kind !== "voice") throw new HttpError(400, "That's a text channel");
    const nick = servers.view(sid, me.id)?.nickname;
    return voice.join({ channelId: c.id, serverId: sid, conversationId: c.conversationId }, { id: me.id, displayName: nick || me.displayName }, livekitUrl(config, req));
  });

  /** Mute, deafen, camera and screen, so the others see it in the channel list. */
  app.post<{ Body: { muted?: unknown; deafened?: unknown; video?: unknown; screen?: unknown } }>("/api/voice/state", async (req) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    return voice.setState(me.id, { muted: bool(b.muted), deafened: bool(b.deafened), video: bool(b.video), screen: bool(b.screen) });
  });

  app.post("/api/voice/leave", async (req) => {
    voice.leave(requireUser(req).id);
    return { ok: true };
  });

  /** The owner and admins can delete anyone's message in their server's channels. */
  app.delete<{ Params: { id: string; messageId: string } }>("/api/servers/:id/messages/:messageId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    moderator(sid, me);
    const mid = id(req.params.messageId);
    if (servers.serverOfMessage(mid) !== sid) throw new HttpError(404, "No such message");
    const { message, removedFiles } = convos.delete(mid, me.id, true);
    removeFiles(removedFiles);
    gateway.send(convos.memberIds(message.conversationId), { type: "message.updated", message });
    return message;
  });

  // ---- Invites -------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/servers/:id/invites", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    return servers.invites(sid, me.id);
  });

  /** Makes an invite link: { maxUses?: number | null, expiresInHours?: number | null } (default a week). */
  app.post<{ Params: { id: string }; Body: { maxUses?: unknown; expiresInHours?: unknown } }>("/api/servers/:id/invites", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    if (!servers.canInvite(sid, me.id)) throw new HttpError(403, "Only the owner and admins can make invites here");
    return servers.createInvite(sid, me.id, req.body ?? {});
  });

  /** Invites a friend: they see it in the app and can accept or decline. */
  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>("/api/servers/:id/invites/friend", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    if (!servers.canInvite(sid, me.id)) throw new HttpError(403, "Only the owner and admins can make invites here");
    const friendId = id(req.body?.userId);
    if (!friends.areFriends(me.id, friendId)) throw new HttpError(403, "You can only invite friends");
    const { invite, isNew } = servers.inviteFriend(sid, me.id, friendId);
    const preview = servers.preview(invite.code, friendId);
    if (isNew && preview) {
      gateway.send([friendId], { type: "server.invited", invite: preview });
      void ctx.push.notify([friendId].filter((u) => !gateway.isOnline(u)), "message");
    }
    return invite;
  });

  /** Friend invites waiting for you. */
  app.get("/api/invites", async (req) => servers.pendingFor(requireUser(req).id));

  /** What an invite is for, before joining. */
  app.get<{ Params: { code: string } }>("/api/invites/:code", async (req) => {
    const me = requireUser(req);
    const preview = servers.preview(req.params.code, me.id);
    if (!preview) throw new HttpError(404, "That invite has expired or doesn't exist");
    return preview;
  });

  app.post<{ Params: { code: string } }>("/api/invites/:code/accept", async (req) => {
    const me = requireUser(req);
    const sid = servers.accept(req.params.code, me.id);
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Revokes an invite link, or declines a friend invite. */
  app.delete<{ Params: { code: string } }>("/api/invites/:code", async (req) => {
    const me = requireUser(req);
    servers.deleteInvite(req.params.code, me.id);
    return { ok: true };
  });

  // ---- Permission to make servers ---------------------------------------------------

  app.get("/api/server-requests/me", async (req) => servers.creatorRequest(requireUser(req).id));

  app.post<{ Body: { reason?: unknown } }>("/api/server-requests", async (req) => {
    const me = requireUser(req);
    const request = servers.requestCreator(me, req.body?.reason);
    gateway.send(superAdmins(), { type: "server.request", request });
    return request;
  });

  // ---- Super admin -----------------------------------------------------------------

  app.get("/api/admin/server-requests", async (req) => {
    superAdmin(req);
    return servers.creatorRequests();
  });

  /** Allows or stops someone making servers: { allowed: boolean }. */
  app.put<{ Params: { userId: string }; Body: { allowed?: unknown } }>("/api/admin/server-creators/:userId", async (req) => {
    const me = superAdmin(req);
    if (typeof req.body?.allowed !== "boolean") throw new HttpError(400, "allowed is true or false");
    const userId = id(req.params.userId);
    const request = servers.decideCreator(userId, req.body.allowed, me.id);
    gateway.send([...superAdmins(), userId], { type: "server.request", request });
    return request;
  });

  app.get("/api/admin/servers", async (req) => {
    superAdmin(req);
    return servers.adminList();
  });
}

/**
 * Channels share the DM conversation endpoints for messages, but not calls or end-to-end keys
 * (calls would ring the whole server; channels aren't encrypted yet). Registered on the root app.
 */
export function guardChannelConversations(app: FastifyInstance, ctx: Context): void {
  app.addHook("preHandler", async (req) => {
    if (req.method !== "POST") return;
    const m = /^\/api\/conversations\/(\d+)\/(call|keys)(\/|\?|$)/.exec(req.url);
    if (!m) return;
    const row = ctx.db.prepare("SELECT kind FROM conversations WHERE id = ?").get(Number(m[1])) as { kind: string } | undefined;
    if (row?.kind === "channel") throw new HttpError(400, m[2] === "call" ? "Channels don't have calls yet" : "Channels aren't end-to-end encrypted yet");
  });
}
