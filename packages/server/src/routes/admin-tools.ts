import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerPermission } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { HealthService } from "../health.js";
import { ServerRepo } from "../servers.js";

/** Permissions that make someone a moderator, who can read the server's audit log. */
const MOD_PERMISSIONS: ServerPermission[] = ["viewAuditLog", "manageServer", "manageChannels", "manageRoles", "manageAutomod", "kickMembers", "banMembers", "timeoutMembers", "deleteMessages"];

const optionalId = (v: unknown): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/** The audit logs (a server's, and the instance's), backups, and the server's health. */
export function adminToolRoutes(app: FastifyInstance, ctx: Context): void {
  const servers = new ServerRepo(ctx.db, ctx.users);
  const health = new HealthService(ctx);
  const superAdmin = (req: FastifyRequest) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
    return me;
  };
  type LogQuery = { before?: string; action?: string; userId?: string };
  const filters = (q: LogQuery) => ({
    before: optionalId(q.before),
    action: typeof q.action === "string" && /^[a-z0-9.]{1,40}$/.test(q.action) ? q.action : undefined,
    userId: optionalId(q.userId),
  });

  // ---- Audit log -------------------------------------------------------------------

  /** Who did what in a server, newest first, 50 at a time. ?before=<id>&action=member&userId=<id>. */
  app.get<{ Params: { id: string }; Querystring: LogQuery }>("/api/servers/:id/audit", async (req) => {
    const me = requireUser(req);
    const sid = optionalId(req.params.id)!;
    const role = servers.role(sid, me.id);
    if (!role) throw new HttpError(404, "No such server");
    if (!MOD_PERMISSIONS.some((p) => servers.can(sid, me.id, p, role))) throw new HttpError(403, "Only moderators can see the audit log");
    return ctx.audit.list(sid, filters(req.query));
  });

  /** What super admins did to the instance. */
  app.get<{ Querystring: LogQuery }>("/api/admin/audit", async (req) => {
    superAdmin(req);
    return ctx.audit.list(null, filters(req.query));
  });

  // ---- Server health -------------------------------------------------------------

  /** CPU, memory, disks, storage and connections, right now. */
  app.get("/api/admin/health", async (req, reply) => {
    superAdmin(req);
    void reply.header("cache-control", "no-store");
    return health.snapshot();
  });

  // ---- Backups ---------------------------------------------------------------------

  app.get("/api/admin/backups", async (req) => {
    superAdmin(req);
    return ctx.backups.status();
  });

  /** Makes a backup now and answers when it's done. */
  app.post("/api/admin/backups", async (req) => {
    superAdmin(req);
    await ctx.backups.create();
    return ctx.backups.status();
  });

  /** { everyHours?, keep?, includeUploads? } */
  app.put<{ Body: Record<string, unknown> }>("/api/admin/backups/settings", async (req) => {
    superAdmin(req);
    ctx.backups.save(req.body ?? {});
    return ctx.backups.status();
  });

  app.get<{ Params: { name: string } }>("/api/admin/backups/:name", async (req, reply) => {
    superAdmin(req);
    const file = ctx.backups.file(req.params.name);
    return reply
      .header("content-type", "application/gzip")
      .header("content-disposition", `attachment; filename="${req.params.name}"`)
      .header("cache-control", "no-store")
      .send(createReadStream(file));
  });

  app.delete<{ Params: { name: string } }>("/api/admin/backups/:name", async (req) => {
    superAdmin(req);
    ctx.backups.delete(req.params.name);
    return ctx.backups.status();
  });

  /** Copies a backup to <data>/restore.tar.gz: it's restored the next time the container starts. */
  app.post<{ Params: { name: string } }>("/api/admin/backups/:name/restore", async (req) => {
    const me = superAdmin(req);
    await ctx.backups.stageRestore(req.params.name);
    ctx.audit.write(me, { serverId: null, action: "backup.restore", targetName: req.params.name, details: "on the next restart" });
    return { ok: true };
  });
}
