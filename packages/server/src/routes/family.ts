import { createReadStream, rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { findBlockedWords, INLINE_IMAGE_TYPES, isUsername, type FamilyChat, type Message } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";
import { toMe } from "../users.js";
import { hashPassword } from "../auth/crypto.js";
import { checkNew, MIN_PASSWORD } from "./auth.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** Kid-safe chat: linking, rules, alerts, and parents' read-only view of an alerted chat. */
export function familyRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway, family, config } = ctx;
  const uploads = path.join(config.dataDir, "uploads");
  const removeFiles = (ids: string[]) => {
    for (const f of ids) rmSync(path.join(uploads, f), { force: true });
  };
  const friends = new FriendRepo(db, users);
  const convos = new ConversationRepo(db, users, friends);

  family.start();
  app.addHook("onClose", async () => family.stop());

  /** Linking or unlinking changes who gets conversation keys, so every chat the kid is in changes. */
  const pushKidConversations = (kidId: number) => {
    for (const c of convos.list(kidId)) {
      for (const uid of convos.memberIds(c.id)) gateway.send([uid], { type: "conversation.updated", conversation: convos.get(c.id, uid)! });
    }
  };
  const pushFriendship = (a: number, b: number) => {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const f = friends.view(me, other);
      gateway.send([me], f ? { type: "friend.updated", friend: { ...f, online: f.state === "friends" && gateway.isOnline(other) } } : { type: "friend.removed", userId: other });
    }
  };
  const afterLink = (kidId: number) => {
    family.pushFamily([kidId]);
    for (const p of family.parentsOf(kidId)) family.pushFamily([p]);
    // The kid's own "ready" user (isKid) changed too.
    gateway.send([kidId], { type: "ready", user: toMe(users.byId(kidId)!) });
    pushKidConversations(kidId);
  };
  app.get("/api/family", async (req) => family.info(requireUser(req).id));

  // ---- Linking -------------------------------------------------------------------------

  /** A parent makes a code for their kid to type. */
  app.post("/api/family/codes", async (req) => family.createCode(requireUser(req).id));

  /** The kid types it. The app shows what parents can see before this is sent. */
  app.post<{ Body: { code?: unknown; timezone?: unknown } }>("/api/family/link", async (req) => {
    const me = requireUser(req);
    family.redeem(me.id, req.body?.code, req.body?.timezone);
    afterLink(me.id);
    return family.info(me.id);
  });

  /** A super admin links accounts directly, for families who'd rather set it up for the kids. */
  app.post<{ Body: { parent?: unknown; kid?: unknown; timezone?: unknown } }>("/api/admin/family", async (req) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
    const parent = isUsername(req.body?.parent) ? users.byUsername(req.body.parent) : undefined;
    const kid = isUsername(req.body?.kid) ? users.byUsername(req.body.kid) : undefined;
    if (!parent || !kid) throw new HttpError(404, "No one has that username");
    family.link(parent.id, kid.id, req.body?.timezone);
    afterLink(kid.id);
    return family.kidView(kid.id);
  });

  // ---- Kid accounts under a parent's ---------------------------------------------------

  /**
   * A parent makes a kid account under theirs: they pick its username and password, and look
   * after how it signs in. The kid signs in with it and sets up their own encryption.
   */
  app.post<{ Body: { username?: unknown; displayName?: unknown; password?: unknown; timezone?: unknown } }>("/api/family/kids", async (req) => {
    const me = requireUser(req);
    if (!ctx.signin.settings().parentKidAccounts) throw new HttpError(403, "The admin has switched off making kid accounts");
    if (me.isKid || me.isBot) throw new HttpError(403, "Kid accounts can't make other accounts");
    if (!me.publicKey) throw new HttpError(409, "Turn on end-to-end encryption first, so your kid's chats can be encrypted to you too");
    const n = checkNew(ctx, req.body ?? {});
    const kid = users.create({ username: n.username, displayName: n.displayName, passwordHash: await hashPassword(n.password), managedBy: me.id });
    try {
      family.link(me.id, kid.id, req.body?.timezone);
    } catch (err) {
      db.prepare("DELETE FROM users WHERE id = ?").run(kid.id);
      throw err;
    }
    afterLink(kid.id);
    return family.kidView(kid.id);
  });

  const managedKid = (parentId: number, kidId: number) => {
    family.requireParent(parentId, kidId);
    const kid = users.byId(kidId)!;
    if (kid.managedBy === null) throw new HttpError(409, `${kid.displayName} has their own account, so only they can change how it signs in`);
    return kid;
  };

  /** Any of a managed kid's parents can set its password. Signs the kid out everywhere. */
  app.put<{ Params: { kidId: string }; Body: { password?: unknown } }>("/api/family/kids/:kidId/password", async (req) => {
    const me = requireUser(req);
    const kid = managedKid(me.id, id(req.params.kidId));
    const password = req.body?.password;
    if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
    users.update(kid.id, { passwordHash: await hashPassword(password) });
    ctx.sessions.endAllFor(kid.id);
    return family.kidView(kid.id);
  });

  /**
   * Hands a kid account over to the kid: it stays linked, with the same rules, but the kid now
   * looks after its password and can link their own sign-ins.
   */
  app.post<{ Params: { kidId: string } }>("/api/family/kids/:kidId/release", async (req) => {
    const me = requireUser(req);
    const kid = managedKid(me.id, id(req.params.kidId));
    users.setManagedBy(kid.id, null);
    afterLink(kid.id);
    return family.kidView(kid.id);
  });

  /** Unlinks a kid from you (a parent), or from everyone (a super admin). Kids can't unlink themselves. */
  app.delete<{ Params: { kidId: string } }>("/api/family/kids/:kidId", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    const parents = family.parentsOf(kidId);
    if (!parents.includes(me.id) && !me.isSuperAdmin) throw new HttpError(404, "That isn't one of your kids");
    const targets = parents.includes(me.id) ? [me.id] : parents;
    const kid = users.byId(kidId)!;
    if (kid.managedBy !== null) {
      const left = parents.filter((p) => !targets.includes(p));
      // The last parent can't walk away from an account only they can sign in to; hand it over first.
      if (!left.length) throw new HttpError(409, `${kid.displayName}'s account is under yours. Hand it over to them before unlinking.`);
      if (targets.includes(kid.managedBy)) users.setManagedBy(kidId, left[0]!);
    }
    for (const p of targets) removeFiles(family.unlink(p, kidId));
    family.pushFamily([kidId, ...targets]);
    gateway.send([kidId], { type: "ready", user: toMe(users.byId(kidId)!) });
    // Friendships that were waiting for a parent are open now.
    for (const f of friends.list(kidId)) pushFriendship(kidId, f.user.id);
    pushKidConversations(kidId);
    return { ok: true };
  });

  // ---- Rules -----------------------------------------------------------------------------

  app.patch<{ Params: { kidId: string }; Body: Record<string, unknown> }>("/api/family/kids/:kidId", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    family.requireParent(me.id, kidId);
    family.setRules(kidId, req.body ?? {});
    family.pushFamily([kidId]);
    return family.kidView(kidId);
  });

  app.put<{ Body: { url?: unknown } }>("/api/family/webhook", async (req) => {
    const me = requireUser(req);
    return { webhookUrl: family.setWebhook(me.id, req.body?.url ?? null) };
  });

  // ---- Contacts ----------------------------------------------------------------------------

  /** A kid's friends and requests, so a parent can see who they talk to. */
  app.get<{ Params: { kidId: string } }>("/api/family/kids/:kidId/friends", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    family.requireParent(me.id, kidId);
    return friends.list(kidId);
  });

  app.post<{ Params: { kidId: string; userId: string } }>("/api/family/kids/:kidId/friends/:userId/approve", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    const other = id(req.params.userId);
    family.approveContact(me.id, kidId, other);
    pushFriendship(kidId, other);
    family.pushFamily([kidId]);
    return friends.view(kidId, other);
  });

  /** Declines a waiting friend, or removes an existing one. */
  app.delete<{ Params: { kidId: string; userId: string } }>("/api/family/kids/:kidId/friends/:userId", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    const other = id(req.params.userId);
    family.requireParent(me.id, kidId);
    friends.remove(kidId, other);
    for (const p of family.parentsOf(kidId)) family.resolveContact(p, kidId, other);
    pushFriendship(kidId, other);
    return { ok: true };
  });

  // ---- Alerts --------------------------------------------------------------------------------

  app.get("/api/family/alerts", async (req) => family.alertsFor(requireUser(req).id));

  /**
   * The kid's app reports something: a filtered word it caught (never which word), or the kid
   * asking a parent to look at a chat. Either opens that chat to the parents until they're done.
   */
  app.post<{ Body: { type?: unknown; conversationId?: unknown } }>("/api/family/alerts", async (req) => {
    const me = requireUser(req);
    if (!family.isKid(me.id)) throw new HttpError(403, "Only kid accounts send these");
    const type = req.body?.type;
    if (type !== "profanity" && type !== "help") throw new HttpError(400, "type is profanity or help");
    const cid = id(req.body?.conversationId);
    if (!convos.isMember(cid, me.id)) throw new HttpError(404, "No such conversation");
    return family.alert(me.id, type, { conversationId: cid });
  });

  app.post<{ Params: { id: string } }>("/api/family/alerts/:id/resolve", async (req) => {
    const me = requireUser(req);
    const alert = family.alertFor(me.id, id(req.params.id));
    removeFiles(family.resolve(me.id, alert.id));
    for (const p of family.parentsOf(alert.kid.id)) family.pushFamily([p]);
    return family.alertFor(me.id, alert.id);
  });

  /** The chat an open alert is about, read only, with what the kid deleted put back. Logged for the kid to see. */
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/family/alerts/:id/chat", async (req): Promise<FamilyChat> => {
    const me = requireUser(req);
    const { alert, conversationId } = family.viewable(me.id, id(req.params.id));
    family.audit(me.id, alert);
    const fileUrl = (fileId: string, name: string) => `/api/family/alerts/${alert.id}/files/${fileId}/${encodeURIComponent(name)}`;
    const messages = convos.messages(conversationId, req.query.before ? id(req.query.before) : undefined).map((m): Message & { deletedByKid?: boolean } => {
      const kept = m.deleted ? family.keptMessage(m.id) : undefined;
      if (kept) {
        return {
          ...m,
          body: kept.body,
          keyVersion: kept.keyVersion,
          deletedByKid: true,
          attachments: kept.files.map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType, url: fileUrl(f.id, f.name) })),
        };
      }
      return { ...m, attachments: m.attachments.map((a) => ({ ...a, url: fileUrl(a.id, a.name) })) };
    });
    return { alert, conversation: convos.get(conversationId, me.id)!, messages };
  });

  /** Your copies of the chat's keys, while the alert is open. */
  app.get<{ Params: { id: string } }>("/api/family/alerts/:id/keys", async (req) => {
    const me = requireUser(req);
    const { conversationId } = family.viewable(me.id, id(req.params.id));
    return convos.wrappedKeys(conversationId, me.id);
  });

  app.get<{ Params: { id: string; fileId: string; name: string } }>("/api/family/alerts/:id/files/:fileId/:name", async (req, reply) => {
    const me = requireUser(req);
    const { alert, conversationId } = family.viewable(me.id, id(req.params.id));
    const fileId = /^[0-9a-f]{32}$/.test(req.params.fileId) ? req.params.fileId : "";
    const live = fileId ? convos.attachmentIn(fileId, conversationId) : undefined;
    const kept = fileId && !live ? family.kept(alert.kid.id, conversationId).flatMap((k) => k.files).find((f) => f.id === fileId) : undefined;
    const a = live ?? kept;
    if (!a) throw new HttpError(404, "No such file");
    const inline = INLINE_IMAGE_TYPES.includes(a.contentType);
    return reply
      .header("content-type", inline ? a.contentType : "application/octet-stream")
      .header("content-length", a.size)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, no-store")
      .send(createReadStream(path.join(uploads, a.id)));
  });
}

/**
 * The rules the server enforces for kid accounts, on every route they apply to. Registered on
 * the root app so it covers routes from every plugin:
 * - outside chat hours, or past the daily limit: no sending, editing, calling, joining voice,
 *   starting chats or adding friends (reading still works);
 * - no joining or making chat servers unless a parent allows it;
 * - plain messages (server channels) with a filtered word are refused. Encrypted ones are
 *   checked by the kid's app, because the server can't read them.
 */
export function guardKids(app: FastifyInstance, ctx: Context): void {
  const chat: [string, RegExp][] = [
    ["POST", /^\/api\/conversations$/],
    ["POST", /^\/api\/conversations\/\d+\/messages$/],
    ["PATCH", /^\/api\/messages\/\d+$/],
    ["POST", /^\/api\/conversations\/\d+\/call$/],
    ["POST", /^\/api\/servers\/\d+\/channels\/\d+\/voice$/],
    ["POST", /^\/api\/friends$/],
    ["POST", /^\/api\/friends\/\d+\/accept$/],
    ["PUT", /^\/api\/messages\/\d+\/reactions\/[^/]+$/],
    ["POST", /^\/api\/servers\/\d+\/events$/],
    ["PATCH", /^\/api\/events\/\d+$/],
  ];
  const servers: [string, RegExp][] = [
    ["POST", /^\/api\/servers$/],
    ["POST", /^\/api\/servers\/\d+\/join$/],
    ["POST", /^\/api\/invites\/[^/]+\/accept$/],
  ];
  const hit = (list: [string, RegExp][], method: string, url: string) => list.some(([m, re]) => m === method && re.test(url));

  app.addHook("preHandler", async (req) => {
    const user = req.user;
    if (!user?.isKid) return;
    const url = req.url.split("?")[0]!;
    if (hit(chat, req.method, url)) ctx.family.assertCanChat(user.id);
    if (hit(servers, req.method, url) && !ctx.family.rules(user.id).canJoinServers) {
      throw new HttpError(403, "Ask a parent: your account can't join chat servers yet");
    }
    const sending = (req.method === "POST" && /^\/api\/conversations\/(\d+)\/messages$/.exec(url)) || (req.method === "PATCH" && /^\/api\/messages\/\d+$/.test(url));
    if (sending && !req.isMultipart()) {
      const body = req.body as { body?: unknown; keyVersion?: unknown } | undefined;
      const rules = ctx.family.rules(user.id);
      if (rules.profanityFilter && typeof body?.body === "string" && !body.keyVersion && findBlockedWords(body.body, rules.blockedWords).length) {
        const cid = Array.isArray(sending) ? Number(sending[1]) : undefined;
        if (cid) ctx.family.alert(user.id, "profanity", { conversationId: cid });
        throw new HttpError(400, "That message has a word your family filter blocks");
      }
    }
  });
}
