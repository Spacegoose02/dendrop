import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { ServerRepo } from "../servers.js";
import { toMe, type UserRecord } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/**
 * Bots, from both sides.
 *
 * People (signed in): make and manage their bots (/api/bots), add them to servers they run
 * (/api/servers/:id/bots), and click bots' buttons (/api/messages/:id/buttons/:buttonId).
 *
 * Bots (Authorization: Bot <token>): the bot API under /api/bot/v1. A session cookie never
 * counts there, and a bot token counts nowhere else.
 */
export function botRoutes(app: FastifyInstance, ctx: Context): void {
  const { bots, gateway } = ctx;
  const servers = new ServerRepo(ctx.db, ctx.users);
  /** Open bot gateway connections, to close when a token is reset or the bot deleted. */
  const sockets = new Map<number, Set<WebSocket>>();
  const disconnect = (botId: number) => {
    for (const ws of sockets.get(botId) ?? []) ws.close(4401, "The bot's token changed");
    sockets.delete(botId);
  };

  bots.start();
  app.addHook("onClose", async () => {
    bots.stop();
    for (const set of sockets.values()) for (const ws of set) ws.close(1001, "Server shutting down");
  });

  // ---- For people -------------------------------------------------------------------

  app.get("/api/bots", async (req) => {
    const me = requireUser(req);
    return { bots: bots.list(me), canMake: bots.canMake(me) };
  });

  app.post<{ Body: { username?: unknown; displayName?: unknown; description?: unknown } }>("/api/bots", async (req) => bots.create(requireUser(req), req.body ?? {}));

  app.patch<{ Params: { id: string }; Body: { displayName?: unknown; description?: unknown; eventsUrl?: unknown; isPublic?: unknown; readsMessages?: unknown } }>(
    "/api/bots/:id",
    async (req) => {
      const botId = id(req.params.id);
      const bot = bots.update(requireUser(req), botId, req.body ?? {});
      // Its name shows in member lists.
      for (const sid of serversOf(botId)) ctx.serverChanged?.(sid);
      return bot;
    },
  );

  /** A new token; the old one stops working and its gateway connections close. */
  app.post<{ Params: { id: string } }>("/api/bots/:id/token", async (req) => {
    const botId = id(req.params.id);
    const out = bots.resetToken(requireUser(req), botId);
    disconnect(botId);
    return out;
  });

  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (req) => {
    const botId = id(req.params.id);
    const left = bots.delete(requireUser(req), botId);
    disconnect(botId);
    for (const sid of left) ctx.serverChanged?.(sid);
    return { ok: true };
  });

  const serversOf = (userId: number) =>
    (ctx.db.prepare("SELECT server_id FROM server_members WHERE user_id = ?").all(userId) as { server_id: number }[]).map((r) => r.server_id);

  /** The bots in a server, and the ones you could add. Owner and admins only. */
  app.get<{ Params: { id: string } }>("/api/servers/:id/bots", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    bots.assertModerator(sid, me);
    return { bots: bots.inServer(sid, me), addable: bots.addable(me, sid), canMake: bots.canMake(me) };
  });

  app.post<{ Params: { id: string }; Body: { botId?: unknown } }>("/api/servers/:id/bots", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    bots.assertModerator(sid, me);
    bots.addToServer(me, sid, id(req.body?.botId));
    ctx.serverChanged?.(sid);
    return { bots: bots.inServer(sid, me), addable: bots.addable(me, sid), canMake: bots.canMake(me) };
  });

  app.delete<{ Params: { id: string; botId: string } }>("/api/servers/:id/bots/:botId", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    const botId = id(req.params.botId);
    bots.assertModerator(sid, me);
    if (!ctx.users.byId(botId)?.isBot || !servers.role(sid, botId)) throw new HttpError(404, "That bot isn't in this server");
    servers.removeMember(sid, botId);
    gateway.send([botId], { type: "server.removed", serverId: sid });
    ctx.serverChanged?.(sid);
    return { bots: bots.inServer(sid, me), addable: bots.addable(me, sid), canMake: bots.canMake(me) };
  });

  /** Clicks a button on a bot's message. Answers with the bot's reply, which only you see. */
  app.post<{ Params: { id: string; buttonId: string } }>("/api/messages/:id/buttons/:buttonId", async (req) => {
    return bots.click(requireUser(req), id(req.params.id), req.params.buttonId);
  });

  // ---- For bots ---------------------------------------------------------------------

  const requireBot = (req: FastifyRequest): UserRecord => {
    const bot = bots.resolve(req.headers.authorization);
    if (!bot) throw new HttpError(401, "Send the bot's token as: Authorization: Bot <token>");
    return bot;
  };

  app.get("/api/bot/v1/me", async (req) => {
    return bots.me(requireBot(req).id);
  });

  /** The servers the bot is in, each with the channels it can see. */
  app.get("/api/bot/v1/servers", async (req) => servers.list(requireBot(req).id));

  app.get<{ Params: { channelId: string }; Querystring: { before?: string; limit?: string } }>("/api/bot/v1/channels/:channelId/messages", async (req) => {
    const bot = requireBot(req);
    return bots.messages(bot, id(req.params.channelId), req.query.before ? id(req.query.before) : undefined, req.query.limit ? Number(req.query.limit) : undefined);
  });

  /** { content, buttons? }: posts in a text channel the bot is in. */
  app.post<{ Params: { channelId: string }; Body: { content?: unknown; buttons?: unknown } }>("/api/bot/v1/channels/:channelId/messages", async (req) =>
    bots.send(requireBot(req), id(req.params.channelId), req.body ?? {}),
  );

  /** { content?, buttons? }: changes one of the bot's messages. buttons null or [] takes them away. */
  app.patch<{ Params: { id: string }; Body: { content?: unknown; buttons?: unknown } }>("/api/bot/v1/messages/:id", async (req) =>
    bots.edit(requireBot(req), id(req.params.id), req.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>("/api/bot/v1/messages/:id", async (req) => {
    bots.remove(requireBot(req), id(req.params.id));
    return { ok: true };
  });

  /** { content }: answers a click; only the person who clicked sees it. */
  app.post<{ Params: { id: string }; Body: { content?: unknown } }>("/api/bot/v1/interactions/:id/reply", async (req) => {
    bots.reply(requireBot(req), id(req.params.id), req.body?.content);
    return { ok: true };
  });

  /** The bot gateway: the bot's events over a WebSocket. Only "ping" is listened to. */
  app.get("/api/bot/v1/gateway", { websocket: true }, (socket, req) => {
    const bot = bots.resolve(req.headers.authorization);
    // Browsers can't set this header on a WebSocket, so a page can't open one with someone's cookie.
    if (!bot) {
      socket.close(4401, "Send the bot's token as: Authorization: Bot <token>");
      return;
    }
    let set = sockets.get(bot.id);
    if (!set) sockets.set(bot.id, (set = new Set()));
    set.add(socket);
    const off = bots.connect(bot.id, (e) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    });
    socket.send(JSON.stringify({ type: "ready", user: toMe(bot) }));
    socket.on("message", (raw) => {
      try {
        if ((JSON.parse(String(raw)) as { type?: string })?.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      } catch {
        // Not JSON; ignored.
      }
    });
    socket.on("close", () => {
      off();
      sockets.get(bot.id)?.delete(socket);
    });
  });
}
