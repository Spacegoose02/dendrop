import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AUTOMOD_LIMITS, INLINE_IMAGE_TYPES, isVoiceKind, LIMITS, parseWatchLink, WATCH_VIDEO_TYPES, type ServerPermission, type WatchVideo } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { livekitUrl } from "../livekit.js";
import { LevelService } from "../levels.js";
import { ServerRepo, type ImageKind } from "../servers.js";
import { ThreadRepo } from "../threads.js";
import { VoiceService } from "../voice.js";
import { cleanPosition, cleanWatchTitle, titleFromUrl } from "../watch.js";
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
  // Someone timed out in a server leaves its voice channel.
  ctx.automod.onTimeout.push((serverId, userId) => {
    const cid = voice.channelOf(userId);
    if (cid !== undefined && voice.state(cid)?.serverId === serverId) voice.leave(userId);
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
  ctx.serverChanged = push;
  const levels = new LevelService(db, servers, gateway, push);
  ctx.levels = levels;
  ctx.voiceCount = (channelId) => voice.state(channelId)?.members.length ?? 0;
  ctx.voiceMembers = (channelId) => voice.state(channelId)?.members.map((m) => m.userId) ?? [];
  const superAdmins = () => (db.prepare("SELECT id FROM users WHERE is_super_admin = 1").all() as { id: number }[]).map((r) => r.id);

  /** The caller's role, or a 404 if they aren't in the server (so private servers stay hidden). */
  const member = (serverId: number, user: UserRecord) => {
    const role = servers.role(serverId, user.id);
    if (!role) throw new HttpError(404, "No such server");
    return role;
  };
  const PERMISSION_NAMES: Record<ServerPermission, string> = {
    manageServer: "Manage server",
    manageChannels: "Manage channels",
    manageRoles: "Manage roles",
    manageAutomod: "Manage automod",
    kickMembers: "Remove and ban",
    timeoutMembers: "Time out",
    deleteMessages: "Delete messages",
    createInvites: "Make invites",
    manageExpressions: "Manage emoji & stickers",
    pinMessages: "Pin messages",
    manageEvents: "Manage events",
  };
  /** A 404 if they aren't in the server, a 403 if none of their roles allow any of `perms`. */
  const allowed = (serverId: number, user: UserRecord, ...perms: ServerPermission[]) => {
    const role = member(serverId, user);
    if (!perms.some((p) => servers.can(serverId, user.id, p, role))) throw new HttpError(403, `You need ${PERMISSION_NAMES[perms[0]!]} to do that`);
    return role;
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

  app.patch<{ Params: { id: string }; Body: { name?: unknown; description?: unknown; isPublic?: unknown; memberInvites?: unknown; playTogether?: unknown; levels?: unknown } }>(
    "/api/servers/:id",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      allowed(sid, me, "manageServer");
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
    allowed(sid, me, "manageServer");
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
    allowed(sid, me, "manageServer");
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

  /**
   * Removes someone, and with ?ban=true keeps them out. Needs Remove and ban, and only works on
   * people ranked below you (admins can't remove the owner or other admins).
   */
  app.delete<{ Params: { id: string; userId: string }; Querystring: { ban?: string } }>("/api/servers/:id/members/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "kickMembers");
    const target = id(req.params.userId);
    const theirRole = servers.role(sid, target);
    if (!theirRole) throw new HttpError(404, "They aren't in this server");
    if (target === me.id) throw new HttpError(400, "Leave the server instead");
    if (!servers.outranks(sid, me.id, target)) throw new HttpError(403, theirRole === "admin" ? "Only the owner can remove an admin" : "You can only remove people ranked below you");
    servers.removeMember(sid, target, req.query.ban === "true" ? { by: me.id } : null);
    gateway.send([target], { type: "server.removed", serverId: sid });
    push(sid);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id/bans", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "kickMembers");
    return servers.bans(sid);
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/servers/:id/bans/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "kickMembers");
    if (!servers.unban(sid, id(req.params.userId))) throw new HttpError(404, "They aren't banned");
    return { ok: true };
  });

  // ---- Levels ----------------------------------------------------------------------

  /** The leaderboard: [{ userId, xp }], most XP first. Empty while levels are off. */
  app.get<{ Params: { id: string } }>("/api/servers/:id/levels", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    return servers.levelsOn(sid) ? levels.leaderboard(sid) : [];
  });

  /** Sets everyone's XP back to zero (Manage server). */
  app.delete<{ Params: { id: string } }>("/api/servers/:id/levels", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageServer");
    levels.reset(sid);
    push(sid);
    return { ok: true };
  });

  /** Sets one person's XP back to zero (Manage server, and only people ranked below you). */
  app.delete<{ Params: { id: string; userId: string } }>("/api/servers/:id/levels/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageServer");
    const target = id(req.params.userId);
    if (!servers.role(sid, target)) throw new HttpError(404, "They aren't in this server");
    if (target !== me.id && !servers.outranks(sid, me.id, target)) throw new HttpError(403, "You can only reset people ranked below you");
    levels.reset(sid, target);
    push(sid);
    return { ok: true };
  });

  // ---- Welcome screen ----------------------------------------------------------------
  // Everyone in the server gets it with the server. See ServerRepo.setWelcome for who can change what.

  app.put<{ Params: { id: string }; Body: { enabled?: unknown; message?: unknown; rules?: unknown; requireAgree?: unknown; roles?: unknown } }>(
    "/api/servers/:id/welcome",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      allowed(sid, me, "manageServer");
      const welcome = servers.setWelcome(sid, me.id, req.body ?? {});
      push(sid);
      return welcome;
    },
  );

  /** You went through the welcome screen: agrees to the rules, and sets the roles you picked ({ roleIds? }). */
  app.post<{ Params: { id: string }; Body: { roleIds?: unknown } }>("/api/servers/:id/welcome/done", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    if (req.body?.roleIds !== undefined) servers.pickRoles(sid, me.id, req.body.roleIds);
    servers.finishWelcome(sid, me.id);
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Picks your welcome-screen roles again, any time: { roleIds }. */
  app.put<{ Params: { id: string }; Body: { roleIds?: unknown } }>("/api/servers/:id/me/roles", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.pickRoles(sid, me.id, req.body?.roleIds);
    push(sid);
    return servers.view(sid, me.id);
  });

  // ---- Custom roles ----------------------------------------------------------------
  // Everyone in the server sees the roles (they come with the server). Changing them needs
  // Manage roles, and only roles ranked below your own (see ServerRepo).

  /** Makes a role: { name, color?: "#rrggbb" | null, permissions?: [...] }. New roles rank lowest. */
  app.post<{ Params: { id: string }; Body: { name?: unknown; color?: unknown; permissions?: unknown } }>("/api/servers/:id/roles", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    const role = servers.createRole(sid, me.id, req.body ?? {});
    push(sid);
    return role;
  });

  /** Puts the roles in a new order, highest first: { ids: [...] }. */
  app.put<{ Params: { id: string }; Body: { ids?: unknown } }>("/api/servers/:id/roles/order", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.reorderRoles(sid, me.id, req.body?.ids);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: unknown; color?: unknown; permissions?: unknown } }>("/api/servers/:id/roles/:roleId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.updateRole(sid, me.id, id(req.params.roleId), req.body ?? {});
    push(sid);
    return servers.view(sid, me.id);
  });

  app.delete<{ Params: { id: string; roleId: string } }>("/api/servers/:id/roles/:roleId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.deleteRole(sid, me.id, id(req.params.roleId));
    push(sid);
    return servers.view(sid, me.id);
  });

  /** Sets someone's custom roles: { roleIds: [...] }. */
  app.put<{ Params: { id: string; userId: string }; Body: { roleIds?: unknown } }>("/api/servers/:id/members/:userId/roles", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    servers.setMemberRoles(sid, me.id, id(req.params.userId), req.body?.roleIds);
    push(sid);
    return servers.view(sid, me.id);
  });

  // ---- Channels ------------------------------------------------------------------
  // Messages in a channel go through /api/conversations/:conversationId/messages like DMs.

  app.post<{ Params: { id: string }; Body: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown; roleIds?: unknown; kind?: unknown } }>(
    "/api/servers/:id/channels",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      allowed(sid, me, "manageChannels");
      const channel = servers.createChannel(sid, req.body ?? {});
      push(sid);
      return channel;
    },
  );

  app.put<{ Params: { id: string }; Body: { ids?: unknown } }>("/api/servers/:id/channels/order", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageChannels");
    servers.reorderChannels(sid, req.body?.ids);
    push(sid);
    return servers.view(sid, me.id);
  });

  app.patch<{ Params: { id: string; channelId: string }; Body: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown; roleIds?: unknown } }>(
    "/api/servers/:id/channels/:channelId",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      allowed(sid, me, "manageChannels");
      servers.updateChannel(sid, id(req.params.channelId), req.body ?? {});
      push(sid);
      return servers.view(sid, me.id);
    },
  );

  app.delete<{ Params: { id: string; channelId: string } }>("/api/servers/:id/channels/:channelId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageChannels");
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
    if (!isVoiceKind(c.kind)) throw new HttpError(400, "That's a text channel");
    ctx.automod.assertNotTimedOut(sid, me.id);
    servers.assertAgreed(sid, me.id);
    const nick = servers.view(sid, me.id)?.nickname;
    const stage = c.kind === "stage";
    return voice.join(
      { channelId: c.id, serverId: sid, conversationId: c.conversationId, stage },
      { id: me.id, displayName: nick || me.displayName },
      livekitUrl(config, req),
      stage && stageModerator(sid, me),
    );
  });

  /**
   * Who runs a stage: people who can manage channels or events (the owner and admins always).
   * They come in as speakers and pick who else speaks.
   */
  const stageModerator = (serverId: number, user: UserRecord) =>
    servers.can(serverId, user.id, "manageChannels") || servers.can(serverId, user.id, "manageEvents");

  /** A stage listener raises or lowers their hand: { raised: boolean }. */
  app.post<{ Body: { raised?: unknown } }>("/api/voice/hand", async (req) => {
    const me = requireUser(req);
    if (typeof req.body?.raised !== "boolean") throw new HttpError(400, "raised is true or false");
    return voice.setHand(me.id, req.body.raised);
  });

  /**
   * Lets someone on a stage speak, or moves them to the audience: { speaker: boolean }. Stage
   * moderators can do either to anyone; anyone can step down to the audience themselves.
   */
  app.put<{ Params: { id: string; channelId: string; userId: string }; Body: { speaker?: unknown } }>(
    "/api/servers/:id/channels/:channelId/stage/:userId",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      member(sid, me);
      const c = servers.channelById(id(req.params.channelId));
      if (!c || c.serverId !== sid || !convos.isMember(c.conversationId, me.id)) throw new HttpError(404, "No such channel");
      if (c.kind !== "stage") throw new HttpError(400, "That isn't a stage channel");
      const speaker = req.body?.speaker;
      if (typeof speaker !== "boolean") throw new HttpError(400, "speaker is true or false");
      const target = id(req.params.userId);
      const self = target === me.id && !speaker;
      if (!self && !stageModerator(sid, me)) throw new HttpError(403, "You need Manage channels or Manage events to run the stage");
      if (speaker && ctx.automod.timedOutUntil(sid, target)) throw new HttpError(403, "They're timed out, so they can't speak for now");
      return voice.setSpeaker(c.id, target, speaker);
    },
  );

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

  // ---- Watch together -------------------------------------------------------------------
  // A video everyone in a voice channel watches at the same time. The server keeps what's on and
  // where it's up to; each device plays it and keeps itself in step.

  const watchFile = (conversationId: number, attachmentId: unknown) => {
    const a = typeof attachmentId === "string" && /^[0-9a-f]{32}$/.test(attachmentId) ? convos.attachmentIn(attachmentId, conversationId) : undefined;
    if (!a || !WATCH_VIDEO_TYPES.includes(a.contentType)) throw new HttpError(404, "No such video in this channel's chat");
    return a;
  };

  /** Videos posted in a voice channel's chat, newest first, to pick one to watch. */
  app.get<{ Params: { id: string; channelId: string } }>("/api/servers/:id/channels/:channelId/watch/videos", async (req): Promise<WatchVideo[]> => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    const c = servers.channelById(id(req.params.channelId));
    if (!c || c.serverId !== sid || !convos.isMember(c.conversationId, me.id)) throw new HttpError(404, "No such channel");
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.size, m.author_id, a.created_at FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE a.conversation_id = ? AND m.deleted_at IS NULL AND m.key_version IS NULL
            AND a.content_type IN (${WATCH_VIDEO_TYPES.map(() => "?").join(", ")})
          ORDER BY a.created_at DESC, a.rowid DESC LIMIT 50`,
      )
      .all(c.conversationId, ...WATCH_VIDEO_TYPES) as { id: string; name: string; size: number; author_id: number; created_at: string }[];
    return rows.map((r) => ({ attachmentId: r.id, name: r.name, size: r.size, postedBy: r.author_id, postedAt: r.created_at }));
  });

  /**
   * Puts a video on in the voice channel you're in, or queues it: { attachmentId } for a video
   * from the channel's chat, or { url } for a link (a video file, or YouTube when it's on).
   * Kid accounts can only put on videos from the chat.
   */
  app.post<{ Body: { attachmentId?: unknown; url?: unknown; title?: unknown } }>("/api/voice/watch", async (req) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    const ref = voice.watchChannel(me.id);
    if (b.attachmentId !== undefined) {
      const a = watchFile(ref.conversationId, b.attachmentId);
      return voice.watchAdd(me.id, {
        kind: "file",
        src: `/api/voice/watch/${ref.channelId}/files/${a.id}`,
        title: cleanWatchTitle(b.title, a.name.replace(/\.[a-z0-9]{2,5}$/i, "")),
      });
    }
    const link = typeof b.url === "string" ? parseWatchLink(b.url) : null;
    if (!link) throw new HttpError(400, "Paste a link to a video, or pick one from the chat");
    if (me.isKid) throw new HttpError(403, "Kid accounts can watch videos shared in the chat, not links from other sites");
    if (link.kind === "youtube") {
      if (!ctx.watch.get().youtube) throw new HttpError(403, "YouTube isn't turned on for this Dendrop server. A super admin can turn it on in Admin.");
      return voice.watchAdd(me.id, { kind: "youtube", src: link.videoId, title: cleanWatchTitle(b.title, "YouTube video") });
    }
    return voice.watchAdd(me.id, { kind: "link", src: link.url, title: cleanWatchTitle(b.title, titleFromUrl(link.url)) });
  });

  /** Play, pause or jump: { playing?: boolean, position?: seconds }. */
  app.post<{ Body: { playing?: unknown; position?: unknown } }>("/api/voice/watch/control", async (req) => {
    const me = requireUser(req);
    const b = req.body ?? {};
    if (b.playing !== undefined && typeof b.playing !== "boolean") throw new HttpError(400, "playing is true or false");
    return voice.watchControl(me.id, { playing: b.playing as boolean | undefined, position: b.position === undefined ? undefined : cleanPosition(b.position) });
  });

  /** Skips to the next video: { itemId } when a video ended, so it moves on once however many devices say so. */
  app.post<{ Body: { itemId?: unknown } }>("/api/voice/watch/next", async (req) => {
    const me = requireUser(req);
    const itemId = req.body?.itemId;
    if (itemId !== undefined && typeof itemId !== "string") throw new HttpError(400, "Bad item");
    return voice.watchNext(me.id, itemId);
  });

  app.delete<{ Params: { itemId: string } }>("/api/voice/watch/queue/:itemId", async (req) => voice.watchRemove(requireUser(req).id, req.params.itemId));

  /** Stops the video for everyone. */
  app.delete("/api/voice/watch", async (req) => voice.watchStop(requireUser(req).id));

  /**
   * Streams a video from a voice channel's chat, with ranges so it can be skipped through.
   * Anyone who can see the channel can stream its videos (same as downloading them).
   */
  app.get<{ Params: { channelId: string; attachmentId: string } }>("/api/voice/watch/:channelId/files/:attachmentId", async (req, reply) => {
    const me = requireUser(req);
    const c = servers.channelById(id(req.params.channelId));
    if (!c || !isVoiceKind(c.kind) || !convos.isMember(c.conversationId, me.id)) throw new HttpError(404, "No such channel");
    const a = watchFile(c.conversationId, req.params.attachmentId);
    const file = path.join(uploads, a.id);
    const size = statSync(file).size;
    void reply
      .header("content-type", a.contentType)
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!range || (!range[1] && !range[2])) return reply.header("content-length", size).send(createReadStream(file));
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    start = Math.max(0, start);
    end = Math.max(start, end);
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .header("content-length", end - start + 1)
      .send(createReadStream(file, { start, end }));
  });

  app.get("/api/admin/watch", async (req) => {
    if (!requireUser(req).isSuperAdmin) throw new HttpError(403, "Only super admins can do that");
    return ctx.watch.get();
  });

  app.put<{ Body: { youtube?: unknown } }>("/api/admin/watch", async (req) => {
    if (!requireUser(req).isSuperAdmin) throw new HttpError(403, "Only super admins can do that");
    return ctx.watch.set(req.body ?? {});
  });

  /** People with Delete messages (and the owner and admins) can delete anyone's message in the server's channels. */
  app.delete<{ Params: { id: string; messageId: string } }>("/api/servers/:id/messages/:messageId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "deleteMessages");
    const mid = id(req.params.messageId);
    if (servers.serverOfMessage(mid) !== sid) throw new HttpError(404, "No such message");
    const { message, removedFiles } = convos.delete(mid, me.id, true);
    removeFiles(removedFiles);
    gateway.send(convos.memberIds(message.conversationId), { type: "message.updated", message });
    return message;
  });

  // ---- Automod and timeouts ---------------------------------------------------------
  // Only people with Manage automod (and the owner and admins) see or change automod. Channels aren't encrypted, so the server
  // checks each message before saving it (see automod.ts).

  app.get<{ Params: { id: string } }>("/api/servers/:id/automod", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageAutomod");
    return ctx.automod.settings(sid);
  });

  /** Changes some rules: { words?: {...}, spam?: {...}, links?: {...}, newAccounts?: {...} }. */
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/servers/:id/automod", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageAutomod");
    return ctx.automod.update(sid, req.body);
  });

  /** What automod caught, newest first. ?before=<id> for older entries. */
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/servers/:id/automod/events", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "manageAutomod");
    return ctx.automod.events(sid, req.query.before ? id(req.query.before) : undefined);
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id/timeouts", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "timeoutMembers", "manageAutomod");
    return ctx.automod.timeouts(sid);
  });

  /** Times someone out: { minutes, reason? }. Needs Time out, and only works on people ranked below you. */
  app.put<{ Params: { id: string; userId: string }; Body: { minutes?: unknown; reason?: unknown } }>("/api/servers/:id/timeouts/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "timeoutMembers");
    const target = id(req.params.userId);
    const theirRole = servers.role(sid, target);
    if (!theirRole) throw new HttpError(404, "They aren't in this server");
    if (target === me.id) throw new HttpError(400, "You can't time yourself out");
    if (!servers.outranks(sid, me.id, target)) throw new HttpError(403, theirRole === "admin" ? "Only the owner can time out an admin" : "You can only time out people ranked below you");
    const minutes = Number(req.body?.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > AUTOMOD_LIMITS.timeoutMinutes) throw new HttpError(400, "Pick a timeout from 1 minute to 7 days");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const until = ctx.automod.timeout(sid, target, minutes, reason, me.id);
    return { until };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/servers/:id/timeouts/:userId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    allowed(sid, me, "timeoutMembers");
    if (!ctx.automod.clearTimeout(sid, id(req.params.userId))) throw new HttpError(404, "They aren't timed out");
    return { ok: true };
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
    if (!servers.canInvite(sid, me.id)) throw new HttpError(403, "You need Make invites to invite people here");
    return servers.createInvite(sid, me.id, req.body ?? {});
  });

  /** Invites a friend: they see it in the app and can accept or decline. */
  app.post<{ Params: { id: string }; Body: { userId?: unknown } }>("/api/servers/:id/invites/friend", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    member(sid, me);
    if (!servers.canInvite(sid, me.id)) throw new HttpError(403, "You need Make invites to invite people here");
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
 * Channels and their threads share the DM conversation endpoints for messages, but not calls or
 * end-to-end keys (calls would ring the whole server; channels aren't encrypted yet). Forum
 * channels take posts rather than messages, and closed threads are read only. Registered on the
 * root app.
 */
export function guardChannelConversations(app: FastifyInstance, ctx: Context): void {
  const servers = new ServerRepo(ctx.db, ctx.users);
  const threads = new ThreadRepo(ctx.db, servers, new ConversationRepo(ctx.db, ctx.users, new FriendRepo(ctx.db, ctx.users)));
  app.addHook("preHandler", async (req) => {
    if (req.method !== "POST") return;
    const m = /^\/api\/conversations\/(\d+)\/(call|keys|messages|polls|games|nudges)(\/|\?|$)/.exec(req.url);
    if (!m) return;
    const row = ctx.db.prepare("SELECT kind FROM conversations WHERE id = ?").get(Number(m[1])) as { kind: string } | undefined;
    if (row?.kind !== "channel" && row?.kind !== "thread") return;
    if (m[2] !== "call" && m[2] !== "keys") {
      // Non-members get the usual 404 from the route.
      const blocked = req.user ? threads.postBlocked(Number(m[1]), req.user.id) : null;
      if (blocked) throw new HttpError(blocked.startsWith("This thread") ? 403 : 400, blocked);
      return;
    }
    throw new HttpError(400, m[2] === "call" ? "Channels don't have calls yet" : "Channels aren't end-to-end encrypted yet");
  });
}
