import type { FastifyInstance } from "fastify";
import { requireUser, type Context } from "../app.js";
import type { EventInput } from "../events.js";
import { HttpError } from "../errors.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/**
 * Scheduled events: listing, making and changing them, RSVPs, and starting or ending them early.
 * Events nobody may see answer 404, like private servers and locked channels.
 */
export function eventRoutes(app: FastifyInstance, ctx: Context): void {
  const { events } = ctx;

  /** Events in every server you're in, soonest first. */
  app.get("/api/events", async (req) => events.forUser(requireUser(req).id));

  app.get<{ Params: { id: string } }>("/api/servers/:id/events", async (req) => events.forServer(id(req.params.id), requireUser(req).id));

  /**
   * Makes an event (needs Manage events): { name, description?, channelId? | location?, startsAt,
   * endsAt?, repeat?: "none" | "weekly" }. You're going to the ones you make.
   */
  app.post<{ Params: { id: string }; Body: EventInput }>("/api/servers/:id/events", async (req) => {
    const me = requireUser(req);
    const sid = id(req.params.id);
    ctx.automod.assertNotTimedOut(sid, me.id);
    return events.create(sid, me, req.body ?? {});
  });

  app.get<{ Params: { eventId: string } }>("/api/events/:eventId", async (req) => events.get(id(req.params.eventId), requireUser(req).id));

  /** Changes an event: the same fields as making one. */
  app.patch<{ Params: { eventId: string }; Body: EventInput }>("/api/events/:eventId", async (req) =>
    events.update(id(req.params.eventId), requireUser(req), req.body ?? {}),
  );

  /** Cancels an event (every week of a weekly one). */
  app.delete<{ Params: { eventId: string } }>("/api/events/:eventId", async (req) => {
    events.cancel(id(req.params.eventId), requireUser(req));
    return { ok: true };
  });

  /** { status: "going" | "interested" | null }. */
  app.put<{ Params: { eventId: string }; Body: { status?: unknown } }>("/api/events/:eventId/rsvp", async (req) =>
    events.rsvp(id(req.params.eventId), requireUser(req), req.body?.status ?? null),
  );

  app.post<{ Params: { eventId: string } }>("/api/events/:eventId/start", async (req) => events.startNow(id(req.params.eventId), requireUser(req)));

  /** Ends it now. Returns next week's event for a weekly one, or { event: null }. */
  app.post<{ Params: { eventId: string } }>("/api/events/:eventId/end", async (req) => ({ event: events.endNow(id(req.params.eventId), requireUser(req)) }));
}
