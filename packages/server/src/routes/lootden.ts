import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";

/** The LootDen link: the super admin's settings, and what people are playing. */
export function lootdenRoutes(app: FastifyInstance, ctx: Context): void {
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

  /** Asks LootDen again now, for the admin page's "Check now". */
  app.post("/api/admin/lootden/check", async (req) => {
    superAdmin(req);
    await ctx.lootden.poll();
    return ctx.lootden.status();
  });

  /** What the people you can see are playing, by user id. */
  app.get("/api/activities", async (req) => ctx.lootden.visibleTo(requireUser(req)));
}
