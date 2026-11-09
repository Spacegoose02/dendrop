import type { FastifyInstance } from "fastify";
import { findBlockedWords, isNudgeKind, type Message } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { cleanPoll } from "../fun.js";
import type { UserRecord } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** How often due reminders are checked for. */
const REMINDER_TICK_MS = 15_000;

/**
 * Polls (DMs, group chats and server channels), quick games, raccoon nudges (DMs) and
 * "ping me about this" reminders. Kids' rules apply through guardKids, like messages.
 */
export function funRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway } = ctx;
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const fun = convos.fun;

  const channelServer = (cid: number) =>
    // Threads belong to their channel's server.
    (db.prepare("SELECT server_id FROM channel_conversations WHERE conversation_id = ?").get(cid) as { server_id: number } | undefined)?.server_id;

  const member = (cid: number, userId: number) => {
    if (!convos.isMember(cid, userId)) throw new HttpError(404, "No such conversation");
  };

  /** The message, if `user` can see it and play along: a member, and not timed out in its server. */
  const playable = (messageId: number, user: UserRecord): Message => {
    const m = convos.message(messageId);
    if (!m || !convos.isMember(m.conversationId, user.id)) throw new HttpError(404, "No such message");
    if (m.deleted) throw new HttpError(409, "That message was deleted");
    const serverId = channelServer(m.conversationId);
    if (serverId) ctx.automod.assertNotTimedOut(serverId, user.id);
    return m;
  };

  /** Tells everyone in the chat, and wakes the phones of anyone with nothing open. */
  const announce = (m: Message, from: number) => {
    const memberIds = convos.memberIds(m.conversationId);
    for (const fn of ctx.onMessageCreated) fn(m);
    ctx.notifications.deliver(m, memberIds, from);
    return m;
  };
  const changed = (messageId: number) => {
    const m = convos.message(messageId)!;
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  };

  /** A kid's family filter, for a poll's plain words (encrypted ones are checked on the kid's device). */
  const familyFilter = (me: UserRecord, cid: number, text: string) => {
    if (!me.isKid) return;
    const rules = ctx.family.rules(me.id);
    if (rules.profanityFilter && findBlockedWords(text, rules.blockedWords).length) {
      ctx.family.alert(me.id, "profanity", { conversationId: cid });
      throw new HttpError(400, "That poll has a word your family filter blocks");
    }
  };

  // ---- Polls ------------------------------------------------------------------------------

  /**
   * Posts a poll. Plain: { question, options, multi?, closesInMinutes? }. In an encrypted chat:
   * { body (ciphertext of { t: question, o: options }), keyVersion, optionCount, multi?, closesInMinutes? }.
   */
  app.post<{
    Params: { id: string };
    Body: { question?: unknown; options?: unknown; body?: unknown; keyVersion?: unknown; optionCount?: unknown; multi?: unknown; closesInMinutes?: unknown };
  }>("/api/conversations/:id/polls", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    const b = req.body ?? {};
    const encrypted = b.keyVersion !== undefined && b.keyVersion !== null;
    const poll = cleanPoll(b, encrypted);
    if (!encrypted) {
      const words = `${poll.question}\n${poll.options!.join("\n")}`;
      familyFilter(me, cid, words);
      ctx.automod.checkMessage(cid, me, words);
    } else ctx.automod.checkMessage(cid, me, "");
    const m = convos.sendCard(cid, me.id, {
      body: encrypted ? b.body : poll.question,
      keyVersion: encrypted ? id(b.keyVersion) : null,
      add: (mid) => fun.addPoll(mid, poll),
    });
    return announce(m, me.id);
  });

  /** Votes: { options: [0, 2] } replaces your picks; [] takes your vote back. */
  app.post<{ Params: { id: string }; Body: { options?: unknown } }>("/api/messages/:id/votes", async (req) => {
    const me = requireUser(req);
    const m = playable(id(req.params.id), me);
    fun.vote(m.id, me.id, req.body?.options);
    return changed(m.id);
  });

  /** Ends voting. Only the poll's maker can. */
  app.post<{ Params: { id: string } }>("/api/messages/:id/close-poll", async (req) => {
    const me = requireUser(req);
    const m = playable(id(req.params.id), me);
    if (!m.poll) throw new HttpError(404, "That isn't a poll");
    if (m.authorId !== me.id) throw new HttpError(403, "Only the person who made the poll can close it");
    fun.closePoll(m.id);
    return changed(m.id);
  });

  // ---- Games ------------------------------------------------------------------------------

  /** Starts a game: { kind: "tictactoe" | "rps" | "dice", dice?: "2d6" }. */
  app.post<{ Params: { id: string }; Body: { kind?: unknown; dice?: unknown } }>("/api/conversations/:id/games", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    ctx.automod.checkMessage(cid, me, "");
    const c = convos.get(cid)!;
    // In a 1:1 DM the other person is the opponent; elsewhere the second seat is open.
    const isDm = !c.isGroup && !channelServer(cid);
    const opponent = isDm ? (c.members.find((u) => u.id !== me.id)?.id ?? null) : null;
    const state = fun.newGame(req.body?.kind, me.id, opponent, req.body?.dice);
    const m = convos.sendCard(cid, me.id, { body: "", keyVersion: null, add: (mid) => fun.addGame(mid, state) });
    return announce(m, me.id);
  });

  /** A move: { action: "join" } | { action: "move", cell } | { action: "pick", pick }. */
  app.post<{ Params: { id: string }; Body: { action?: unknown; cell?: unknown; pick?: unknown } }>("/api/messages/:id/game", async (req) => {
    const me = requireUser(req);
    const m = playable(id(req.params.id), me);
    fun.play(m.id, me.id, req.body ?? {});
    const after = changed(m.id);
    // If it's someone's turn and they've nothing open, give their phone a nudge.
    const next = after.game?.turn;
    if (next && next !== me.id && !gateway.isActive(next)) void ctx.push.notify([next], "message");
    return after;
  });

  // ---- Nudges -----------------------------------------------------------------------------

  /** Sends a raccoon nudge: { kind: "poke" | "wave" | ... }. DMs and group chats only. */
  app.post<{ Params: { id: string }; Body: { kind?: unknown } }>("/api/conversations/:id/nudges", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    if (channelServer(cid)) throw new HttpError(400, "Nudges are for DMs and group chats");
    const kind = req.body?.kind;
    if (!isNudgeKind(kind)) throw new HttpError(400, "No such nudge");
    const wait = fun.nudgeWait(cid, me.id);
    if (wait) throw new HttpError(429, `Easy, raccoon! You can nudge again in ${wait} seconds`);
    return announce(convos.sendCard(cid, me.id, { body: "", keyVersion: null, nudge: kind }), me.id);
  });

  // ---- Reminders --------------------------------------------------------------------------

  app.get("/api/reminders", async (req) => fun.reminders(requireUser(req).id));

  /** "Ping me about this": { at } is when, as an ISO date and time. Only you see it. */
  app.post<{ Params: { id: string }; Body: { at?: unknown } }>("/api/messages/:id/reminders", async (req) => {
    const me = requireUser(req);
    const m = convos.message(id(req.params.id));
    if (!m || !convos.isMember(m.conversationId, me.id)) throw new HttpError(404, "No such message");
    if (m.deleted) throw new HttpError(409, "That message was deleted");
    return fun.addReminder(me.id, m.id, m.conversationId, req.body?.at);
  });

  /** Cancels a reminder, or dismisses one that went off. */
  app.delete<{ Params: { id: string } }>("/api/reminders/:id", async (req) => {
    const me = requireUser(req);
    fun.removeReminder(id(req.params.id), me.id);
    return { ok: true };
  });

  /** Sends everyone their reminders that are due by `at`. */
  ctx.fireReminders = (at = new Date()) => {
    for (const r of fun.fireDue(at)) {
      const m = convos.isMember(r.conversationId, r.userId) ? convos.message(r.messageId) : undefined;
      const { userId, ...reminder } = r;
      gateway.send([userId], { type: "reminder", reminder, message: m && !m.deleted ? m : null });
      if (!gateway.isActive(userId)) void ctx.push.notify([userId], "message");
    }
  };
  const timer = setInterval(() => ctx.fireReminders?.(), REMINDER_TICK_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
