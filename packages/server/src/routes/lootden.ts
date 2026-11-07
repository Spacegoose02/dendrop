import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ChannelRef } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { LootdenExtras } from "../lootden-extras.js";
import { isModerator, ServerRepo } from "../servers.js";

/** LootDen being down or refusing is LootDen's error, not ours: 502 with what it said. */
const viaLootden = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, (err as Error).message);
  }
};

/** The LootDen link: the super admin's settings, and what people are playing. */
export function lootdenRoutes(app: FastifyInstance, ctx: Context): void {
  const extras = new LootdenExtras(ctx);
  const servers = new ServerRepo(ctx.db, ctx.users);
  ctx.lootden.start();
  app.addHook("onClose", async () => ctx.lootden.stop());

  const superAdmin = (req: FastifyRequest) => {
    if (!requireUser(req).isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
  };

  app.get("/api/admin/lootden", async (req) => {
    superAdmin(req);
    return ctx.lootden.status();
  });

  /** { url, token }: link LootDen (token left out keeps the saved one); { url: "" } unlinks it. */
  app.put<{ Body: { url?: unknown; token?: unknown } }>("/api/admin/lootden", async (req) => {
    superAdmin(req);
    return ctx.lootden.save(req.body ?? {});
  });

  /**
   * { gameNights, screenshots }: a { serverId, channelId } text channel each, or null to stop.
   * Only in servers where the super admin is the owner or an admin.
   */
  app.put<{ Body: { gameNights?: unknown; screenshots?: unknown } }>("/api/admin/lootden/channels", async (req) => {
    superAdmin(req);
    const me = requireUser(req);
    const before = ctx.lootden.stored().screenshots;
    ctx.lootden.setChannels(req.body ?? {}, (ref: ChannelRef) => {
      if (!isModerator(servers.role(ref.serverId, me.id))) throw new HttpError(403, "Pick a server you're the owner or an admin of");
      const c = servers.channelById(ref.channelId);
      if (!c || c.serverId !== ref.serverId) throw new HttpError(404, "No such channel");
      if (c.kind !== "text") throw new HttpError(400, "Pick a text channel");
      return { serverId: ref.serverId, channelId: ref.channelId };
    });
    if (JSON.stringify(before) !== JSON.stringify(ctx.lootden.stored().screenshots)) extras.resetScreenshots();
    extras.soon();
    await ctx.lootden.poll();
    return ctx.lootden.status();
  });

  /** Asks LootDen again now, for the admin page's "Check now". */
  app.post("/api/admin/lootden/check", async (req) => {
    superAdmin(req);
    await ctx.lootden.poll();
    return ctx.lootden.status();
  });

  // ---- Game links -------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/lootden/games/:id", async (req) => {
    const me = requireUser(req);
    return viaLootden(() => extras.game(req.params.id, me));
  });

  app.get<{ Params: { id: string } }>("/api/lootden/games/:id/cover", async (req, reply) => {
    const me = requireUser(req);
    const { type, bytes } = await viaLootden(() => extras.cover(req.params.id, me));
    return reply.header("content-type", type).header("cache-control", "private, max-age=86400").header("x-content-type-options", "nosniff").send(bytes);
  });

  app.get("/api/lootden/pcs", async (req) => {
    const me = requireUser(req);
    return viaLootden(() => extras.pcs(me));
  });

  /** Send to PC: { device }. */
  app.post<{ Params: { id: string }; Body: { device?: unknown } }>("/api/lootden/games/:id/send", async (req) => {
    const me = requireUser(req);
    await viaLootden(() => extras.send(req.params.id, req.body?.device, me));
    return { ok: true };
  });

  /** What the people you can see are playing, by user id. */
  app.get("/api/activities", async (req) => ctx.lootden.visibleTo(requireUser(req)));
}
