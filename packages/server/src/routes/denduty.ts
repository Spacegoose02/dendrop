import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ChannelRef } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { isModerator, ServerRepo } from "../servers.js";

/** The Den Duty link: the super admin's settings, and kids' chores lines. */
export function dendutyRoutes(app: FastifyInstance, ctx: Context): void {
  const servers = new ServerRepo(ctx.db, ctx.users);
  ctx.denduty.start();
  app.addHook("onClose", async () => ctx.denduty.stop());

  const superAdmin = (req: FastifyRequest) => {
    if (!requireUser(req).isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
  };

  app.get("/api/admin/denduty", async (req) => {
    superAdmin(req);
    return ctx.denduty.status();
  });

  /** { url, homeId, token }: link Den Duty (token left out keeps the saved one); { url: "" } unlinks it. */
  app.put<{ Body: { url?: unknown; homeId?: unknown; token?: unknown } }>("/api/admin/denduty", async (req) => {
    superAdmin(req);
    return ctx.denduty.save(req.body ?? {});
  });

  /** { family, parents }: a { serverId, channelId } text channel each, or null to stop. Only in servers the super admin runs. */
  app.put<{ Body: { family?: unknown; parents?: unknown } }>("/api/admin/denduty/channels", async (req) => {
    superAdmin(req);
    const me = requireUser(req);
    ctx.denduty.setChannels(req.body ?? {}, (ref: ChannelRef) => {
      if (!isModerator(servers.role(ref.serverId, me.id))) throw new HttpError(403, "Pick a server you're the owner or an admin of");
      const c = servers.channelById(ref.channelId);
      if (!c || c.serverId !== ref.serverId) throw new HttpError(404, "No such channel");
      if (c.kind !== "text") throw new HttpError(400, "Pick a text channel");
      return { serverId: ref.serverId, channelId: ref.channelId };
    });
    return ctx.denduty.status();
  });

  /** { kidId, userId }: which Dendrop kid account a Den Duty kid is; userId null for none, "auto" to match by name. */
  app.put<{ Body: { kidId?: unknown; userId?: unknown } }>("/api/admin/denduty/kids", async (req) => {
    superAdmin(req);
    ctx.denduty.pick(req.body ?? {});
    await ctx.denduty.poll();
    return ctx.denduty.status();
  });

  app.post("/api/admin/denduty/check", async (req) => {
    superAdmin(req);
    await ctx.denduty.poll();
    return ctx.denduty.status();
  });

  /** Chores today for you and your kids, by user id. */
  app.get("/api/chores", async (req) => ctx.denduty.visibleTo(requireUser(req)));
}
