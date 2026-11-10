import type { FastifyInstance } from "fastify";
import { LIMITS, type RailItem } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { ConversationRepo } from "../conversations.js";
import { HttpError } from "../errors.js";
import { FriendRepo } from "../friends.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * Checks a server list layout from a client and keeps only servers this person is in, each once.
 * Folders need a short id and a name; an empty folder is dropped.
 */
export function cleanRail(input: unknown, mine: Set<number>): RailItem[] {
  if (!Array.isArray(input)) throw new HttpError(400, "rail is a list");
  const seen = new Set<number>();
  const folderIds = new Set<string>();
  const out: RailItem[] = [];
  const take = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isInteger(n) || !mine.has(n) || seen.has(n)) return null;
    seen.add(n);
    return n;
  };
  for (const raw of input.slice(0, 500)) {
    const item = raw as Record<string, unknown> | null;
    if (item?.type === "server") {
      const n = take(item.id);
      if (n !== null) out.push({ type: "server", id: n });
      continue;
    }
    if (item?.type !== "folder") throw new HttpError(400, "Each item is a server or a folder");
    const fid = String(item.id ?? "");
    if (!/^[\w-]{1,40}$/.test(fid) || folderIds.has(fid)) throw new HttpError(400, "Each folder needs its own short id");
    folderIds.add(fid);
    if (folderIds.size > LIMITS.railFolders) throw new HttpError(400, `Up to ${LIMITS.railFolders} folders`);
    const name = typeof item.name === "string" ? item.name.trim().slice(0, LIMITS.folderName) : "";
    const color = typeof item.color === "string" && COLOR_RE.test(item.color) ? item.color.toLowerCase() : null;
    if (!Array.isArray(item.serverIds)) throw new HttpError(400, "A folder's serverIds is a list");
    const serverIds = item.serverIds.map(take).filter((n): n is number => n !== null);
    if (serverIds.length) out.push({ type: "folder", id: fid, name, color, serverIds });
  }
  return out;
}

/** Saved messages, the mentions inbox, and your server list's folders. */
export function inboxRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, users, gateway } = ctx;
  const convos = new ConversationRepo(db, users, new FriendRepo(db, users));
  const myServers = (userId: number) =>
    new Set((db.prepare("SELECT server_id FROM server_members WHERE user_id = ?").all(userId) as { server_id: number }[]).map((r) => r.server_id));

  app.get("/api/saved", async (req) => convos.saved(requireUser(req).id));

  app.put<{ Params: { id: string } }>("/api/saved/:id", async (req) => {
    const me = requireUser(req);
    const messageId = id(req.params.id);
    if (convos.setSaved(me.id, messageId, true)) gateway.send([me.id], { type: "saved.updated", messageId, saved: true });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/saved/:id", async (req) => {
    const me = requireUser(req);
    const messageId = id(req.params.id);
    if (convos.setSaved(me.id, messageId, false)) gateway.send([me.id], { type: "saved.updated", messageId, saved: false });
    return { ok: true };
  });

  app.get<{ Querystring: { before?: string; limit?: string } }>("/api/mentions", async (req) => {
    const me = requireUser(req);
    return convos.mentionsOf(me.id, req.query.before ? id(req.query.before) : undefined, req.query.limit ? Number(req.query.limit) || undefined : undefined);
  });

  /** Your server list's layout. Servers you've left drop out of it as it's read. */
  app.get("/api/me/rail", async (req) => {
    const me = requireUser(req);
    const r = db.prepare("SELECT rail FROM users WHERE id = ?").get(me.id) as { rail: string | null } | undefined;
    if (!r?.rail) return [];
    try {
      return cleanRail(JSON.parse(r.rail), myServers(me.id));
    } catch {
      return [];
    }
  });

  app.put<{ Body: { rail?: unknown } }>("/api/me/rail", async (req) => {
    const me = requireUser(req);
    const rail = cleanRail(req.body?.rail, myServers(me.id));
    db.prepare("UPDATE users SET rail = ? WHERE id = ?").run(JSON.stringify(rail), me.id);
    gateway.send([me.id], { type: "rail.updated", rail });
    return rail;
  });
}
