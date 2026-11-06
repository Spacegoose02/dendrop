import type { FastifyInstance } from "fastify";
import { isUsername } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** Friends, direct messages and group DMs. */
export function dmRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway } = ctx;
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
  ctx.onPresence.push((userId, online) => {
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

  app.post<{ Params: { id: string }; Body: { body?: unknown } }>("/api/conversations/:id/messages", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.id);
    member(cid, me.id);
    const m = convos.send(cid, me.id, req.body?.body);
    gateway.send(convos.memberIds(cid), { type: "message.created", message: m });
    return m;
  });

  app.patch<{ Params: { id: string }; Body: { body?: unknown } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const m = convos.edit(id(req.params.id), me.id, req.body?.body);
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const m = convos.delete(id(req.params.id), me.id);
    gateway.send(convos.memberIds(m.conversationId), { type: "message.updated", message: m });
    return m;
  });
}
