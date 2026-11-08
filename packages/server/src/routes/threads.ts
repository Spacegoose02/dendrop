import { rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Message, Thread } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { ServerRepo } from "../servers.js";
import { ThreadRepo } from "../threads.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/**
 * Threads off channel messages, forum posts, and the pinned board. A thread's messages go
 * through /api/conversations/:conversationId/messages like a channel's.
 */
export function threadRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, config } = ctx;
  const servers = new ServerRepo(db, users);
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const threads = new ThreadRepo(db, servers, convos);
  const uploads = path.join(config.dataDir, "uploads");

  /** Tells everyone who can see a thread how it looks now, and updates the message it hangs off. */
  const pushThread = (thread: Thread) => {
    gateway.send(threads.memberIds(thread), { type: "thread.updated", thread });
    if (thread.parentMessageId) {
      const parent = convos.message(thread.parentMessageId);
      if (parent) gateway.send(convos.memberIds(parent.conversationId), { type: "message.updated", message: parent });
    }
  };

  // New messages in a thread change its count and last activity.
  ctx.onMessageCreated.push((m: Message) => {
    const thread = threads.forConversation(m.conversationId);
    if (thread) pushThread(thread);
  });

  /** Starts a thread off a channel message (or opens the one it has): { title? }. */
  app.post<{ Params: { id: string }; Body: { title?: unknown } }>("/api/messages/:id/thread", async (req) => {
    const me = requireUser(req);
    const m = convos.message(id(req.params.id));
    if (!m || !convos.isMember(m.conversationId, me.id)) throw new HttpError(404, "No such message");
    if (!m.thread) ctx.automod.checkMessage(m.conversationId, me, typeof req.body?.title === "string" ? req.body.title : "", true);
    const { thread, created } = threads.startFromMessage(m.id, me.id, req.body?.title);
    if (created) pushThread(thread);
    return thread;
  });

  /** A channel's threads (forum posts, for a forum), most recently active first. ?closed=true includes closed ones. */
  app.get<{ Params: { id: string; channelId: string }; Querystring: { closed?: string } }>("/api/servers/:id/channels/:channelId/threads", async (req) => {
    const me = requireUser(req);
    return threads.list(id(req.params.id), id(req.params.channelId), me.id, req.query.closed === "true");
  });

  /** Makes a forum post: { title, body, tags? }. The body is its first message. */
  app.post<{ Params: { id: string; channelId: string }; Body: { title?: unknown; body?: unknown; tags?: unknown } }>(
    "/api/servers/:id/channels/:channelId/threads",
    async (req) => {
      const me = requireUser(req);
      const sid = id(req.params.id);
      const channel = servers.channelById(id(req.params.channelId));
      if (!channel || channel.serverId !== sid || !convos.isMember(channel.conversationId, me.id)) throw new HttpError(404, "No such channel");
      const b = req.body ?? {};
      // The title shows in the list, so automod checks it like a message.
      ctx.automod.checkMessage(channel.conversationId, me, typeof b.title === "string" ? b.title : "", true);
      const thread = threads.createPost(sid, channel.id, me.id, b);
      let first: Message;
      try {
        ctx.automod.checkMessage(thread.conversationId, me, b.body);
        first = convos.send(thread.conversationId, me.id, b.body);
      } catch (err) {
        threads.discard(thread.id);
        throw err;
      }
      // The post first, so clients know the conversation is a thread when its message arrives.
      const made = threads.get(thread.id, me.id);
      pushThread(made);
      gateway.send(convos.memberIds(thread.conversationId), { type: "message.created", message: first });
      return made;
    },
  );

  app.get<{ Params: { id: string } }>("/api/threads/:id", async (req) => threads.get(id(req.params.id), requireUser(req).id));

  /** Renames, closes or reopens, or retags a thread: { title?, closed?, tags? }. */
  app.patch<{ Params: { id: string }; Body: { title?: unknown; closed?: unknown; tags?: unknown } }>("/api/threads/:id", async (req) => {
    const me = requireUser(req);
    const before = threads.get(id(req.params.id), me.id);
    if (typeof req.body?.title === "string") ctx.automod.checkMessage(before.conversationId, me, req.body.title, true);
    const thread = threads.update(before.id, me.id, req.body ?? {});
    pushThread(thread);
    return thread;
  });

  /** Deletes a thread and everything in it: Manage channels or Delete messages. */
  app.delete<{ Params: { id: string } }>("/api/threads/:id", async (req) => {
    const me = requireUser(req);
    const { thread, files, memberIds } = threads.delete(id(req.params.id), me.id);
    for (const f of files) rmSync(path.join(uploads, f), { force: true });
    gateway.send(memberIds, { type: "thread.removed", serverId: thread.serverId, channelId: thread.channelId, threadId: thread.id, conversationId: thread.conversationId });
    if (thread.parentMessageId) {
      const parent = convos.message(thread.parentMessageId);
      if (parent) gateway.send(convos.memberIds(parent.conversationId), { type: "message.updated", message: parent });
    }
    return { ok: true };
  });

  // ---- The pinned board -------------------------------------------------------------

  const pin = (messageId: number, userId: number, pinned: boolean) => {
    const place = threads.setPinned(messageId, userId, pinned);
    const message = convos.message(messageId)!;
    const memberIds = convos.memberIds(place.conversationId);
    gateway.send(memberIds, { type: "message.updated", message });
    gateway.send(memberIds, { type: "pins.updated", serverId: place.serverId, channelId: place.channelId, messageId, pinned });
    return message;
  };

  app.put<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => pin(id(req.params.id), requireUser(req).id, true));
  app.delete<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => pin(id(req.params.id), requireUser(req).id, false));

  /** The server's pinned board: pins you can see, newest first. ?channelId= for one channel and its threads. */
  app.get<{ Params: { id: string }; Querystring: { channelId?: string } }>("/api/servers/:id/pins", async (req) => {
    const me = requireUser(req);
    return threads.board(id(req.params.id), me.id, req.query.channelId ? id(req.query.channelId) : undefined);
  });
}
