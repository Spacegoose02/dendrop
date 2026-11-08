import type { FastifyInstance } from "fastify";
import { requireUser, type Context } from "../app.js";
import type { PushSubscriptionInput } from "../push.js";

/** Phone notification sign-up, for the Android app (UnifiedPush), the iPhone app (APNs) and browsers (Web Push). */
export function pushRoutes(app: FastifyInstance, ctx: Context): void {
  app.get("/api/push/config", async () => ({ vapidPublicKey: ctx.push.vapidPublicKey, apns: ctx.push.apnsInfo }));

  app.post<{ Body: PushSubscriptionInput }>("/api/push/subscriptions", async (req, reply) => {
    const me = requireUser(req);
    ctx.push.subscribe(me.id, req.body ?? {});
    return reply.code(204).send();
  });

  app.delete<{ Body: { endpoint?: unknown } }>("/api/push/subscriptions", async (req, reply) => {
    const me = requireUser(req);
    ctx.push.unsubscribe(me.id, req.body?.endpoint);
    return reply.code(204).send();
  });
}
