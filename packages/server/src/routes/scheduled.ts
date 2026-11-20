import type { FastifyInstance } from "fastify";
import { findBlockedWords, type Message } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { BlockRepo } from "../blocks.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { publicScheduled, ScheduledRepo, type ScheduledInput, type ScheduledRecord } from "../scheduled.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** How often due scheduled messages are checked for, like reminders. */
const SCHEDULED_TICK_MS = 15_000;

/**
 * Send later: schedule a message for a set time, then see, edit, send now or cancel it. When
 * its time comes it goes through the same checks as one sent right then (membership, blocks,
 * kids' rules, channel rules, automod), and shows up as a normal message. If a check says no,
 * it stays with its error for its author to fix, retry or cancel.
 */
export function scheduledRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway } = ctx;
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const blocks = new BlockRepo(db, users);
  const scheduled = new ScheduledRepo(db);

  const member = (cid: number, userId: number) => {
    if (!convos.isMember(cid, userId)) throw new HttpError(404, "No such conversation");
  };
  /** Rules that don't change with time (unlike slowmode): checked when scheduling, too. */
  const assertCanPost = (cid: number, userId: number) => {
    const other = convos.dmPartner(cid, userId);
    if (other !== undefined && blocks.between(userId, other)) throw new HttpError(403, "You can't message this person");
    const rule = ctx.postBlocked?.(cid, userId);
    if (rule && !rule.startsWith("Slowmode")) throw new HttpError(403, rule);
  };
  const updated = (s: ScheduledRecord) => {
    const out = publicScheduled(s);
    gateway.send([s.userId], { type: "scheduled.updated", scheduled: out });
    return out;
  };

  /**
   * Posts it now, as its author, with every check a new message gets. Returns the message, or
   * null when slowmode says to wait a little (it's tried again on the next tick).
   */
  const sendNow = (s: ScheduledRecord, force: boolean): Message | null => {
    const user = users.byId(s.userId);
    if (!user) throw new HttpError(404, "No such user");
    const cid = s.conversationId;
    if (!convos.isMember(cid, user.id)) throw new HttpError(403, "You're not in this chat anymore");
    const other = convos.dmPartner(cid, user.id);
    if (other !== undefined && blocks.between(user.id, other)) throw new HttpError(403, "You can't message this person");
    if (user.isKid) {
      ctx.family.assertCanChat(user.id);
      const rules = ctx.family.rules(user.id);
      if (rules.profanityFilter && !s.keyVersion && findBlockedWords(s.body, rules.blockedWords).length) {
        throw new HttpError(400, "That message has a word your family filter blocks");
      }
    }
    const rule = ctx.postBlocked?.(cid, user.id);
    if (rule) {
      if (rule.startsWith("Slowmode") && !force) return null;
      throw new HttpError(rule.startsWith("Slowmode") ? 429 : 403, rule);
    }
    ctx.automod.checkMessage(cid, user, s.body);
    const canMentionEveryone = ctx.canMentionEveryone?.(cid, user.id) ?? true;
    const m = convos.send(cid, user.id, s.body, [], s.keyVersion, null, null, {
      replyToId: s.replyToId ?? undefined,
      ...(s.keyVersion ? { mentions: s.mentions, mentionsEveryone: s.mentionsEveryone } : {}),
      canMentionEveryone,
    });
    scheduled.remove(s.id);
    for (const fn of ctx.onMessageCreated) fn(m);
    ctx.notifications.deliver(m, convos.memberIds(cid), user.id);
    ctx.levels?.award(cid, user);
    gateway.send([user.id], { type: "scheduled.removed", id: s.id, conversationId: cid, messageId: m.id });
    return m;
  };

  /** Your scheduled messages, soonest first. ?conversationId= for just one chat. */
  app.get<{ Querystring: { conversationId?: string } }>("/api/scheduled", async (req) => {
    const me = requireUser(req);
    const cid = req.query.conversationId ? id(req.query.conversationId) : undefined;
    return scheduled.list(me.id, cid).map(publicScheduled);
  });

  /** Schedules a message: { body, keyVersion?, mentions?, mentionsEveryone?, replyToId?, sendAt }. Text only. */
  app.post<{ Params: { id: string }; Body: ScheduledInput }>("/api/conversations/:id/scheduled", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    assertCanPost(cid, me.id);
    return updated(scheduled.create(me.id, cid, convos.keyVersion(cid), req.body ?? {}));
  });

  /** Changes its words ({ body, keyVersion, ... } together) and/or its time. Clears a failed send. */
  app.patch<{ Params: { id: string }; Body: ScheduledInput }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const s = scheduled.mine(id(req.params.id), me.id);
    member(s.conversationId, me.id);
    return updated(scheduled.update(s, convos.keyVersion(s.conversationId), req.body ?? {}));
  });

  /** Sends it right away. Errors come back as they would for a normal message, and it stays. */
  app.post<{ Params: { id: string } }>("/api/scheduled/:id/send", async (req) => {
    const me = requireUser(req);
    const s = scheduled.mine(id(req.params.id), me.id);
    return sendNow(s, true)!;
  });

  /** Cancels it. */
  app.delete<{ Params: { id: string } }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const s = scheduled.mine(id(req.params.id), me.id);
    scheduled.remove(s.id);
    gateway.send([me.id], { type: "scheduled.removed", id: s.id, conversationId: s.conversationId, messageId: null });
    return { ok: true };
  });

  /** Sends everything due by `at`. One that can't go out keeps its error and its author is told. */
  ctx.fireScheduled = (at = new Date()) => {
    for (const s of scheduled.due(at)) {
      try {
        sendNow(s, false);
      } catch (err) {
        if (!(err instanceof HttpError)) app.log.error({ err }, "scheduled message failed");
        const failed = scheduled.fail(s.id, err instanceof HttpError ? err.message : "Something went wrong on the server");
        if (!failed) continue;
        updated(failed);
        if (!gateway.isActive(s.userId)) void ctx.push.notify([s.userId], "message");
      }
    }
  };
  const timer = setInterval(() => ctx.fireScheduled?.(), SCHEDULED_TICK_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
