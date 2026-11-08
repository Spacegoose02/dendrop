import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

/**
 * The couples kit (see couples.ts and docs/COUPLES.md). Every route answers 404 to kid accounts,
 * and for anything but a 1:1 DM the caller is in.
 */
export function couplesRoutes(app: FastifyInstance, ctx: Context): void {
  const { couples, config } = ctx;
  const uploads = path.join(config.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  couples.start();

  type P = { Params: { cid: string } };
  type PI = { Params: { cid: string; item: string } };

  app.get<P>("/api/couples/:cid", async (req) => couples.get(id(req.params.cid), requireUser(req).id));
  app.post<P>("/api/couples/:cid/invite", async (req) => couples.invite(id(req.params.cid), requireUser(req).id));
  app.post<P>("/api/couples/:cid/accept", async (req) => couples.accept(id(req.params.cid), requireUser(req).id));
  /** Declines, cancels or turns it off, deleting everything in it. */
  app.delete<P>("/api/couples/:cid", async (req) => couples.turnOff(id(req.params.cid), requireUser(req).id));

  /**
   * Adds an item: JSON { kind, body, keyVersion, deliverAt? }, or for a view-once photo,
   * multipart with those fields and one encrypted file.
   */
  app.post<P>("/api/couples/:cid/items", async (req) => {
    const me = requireUser(req);
    const cid = id(req.params.cid);
    if (!req.isMultipart()) {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return couples.add(cid, me.id, { kind: b.kind, body: b.body, keyVersion: b.keyVersion, deliverAt: b.deliverAt });
    }
    // Checked before taking the upload, so a kid or a stranger can't fill the disk.
    couples.get(cid, me.id);
    const fields: Record<string, string> = {};
    let file: { id: string; size: number } | undefined;
    try {
      for await (const part of req.parts({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 } })) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value);
          continue;
        }
        const fileId = randomBytes(16).toString("hex");
        const dest = path.join(uploads, fileId);
        file = { id: fileId, size: 0 };
        await pipeline(part.file, createWriteStream(dest, { flags: "wx" }));
        if (part.file.truncated) throw new HttpError(413, `Photos can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
        file.size = statSync(dest).size;
      }
      return couples.add(cid, me.id, { kind: fields.kind, body: fields.body, keyVersion: Number(fields.keyVersion) }, file);
    } catch (err) {
      if (file) rmSync(path.join(uploads, file.id), { force: true });
      const code = (err as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, `Photos can be up to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
      if (code === "FST_FILES_LIMIT") throw new HttpError(400, "One photo at a time");
      throw err;
    }
  });

  app.patch<PI & { Body: { body?: unknown; keyVersion?: unknown } }>("/api/couples/:cid/items/:item", async (req) =>
    couples.edit(id(req.params.cid), requireUser(req).id, id(req.params.item), req.body ?? {}),
  );

  app.delete<PI>("/api/couples/:cid/items/:item", async (req) => {
    couples.remove(id(req.params.cid), requireUser(req).id, id(req.params.item));
    return { ok: true };
  });

  app.put<PI & { Body: { vote?: unknown } }>("/api/couples/:cid/items/:item/vote", async (req) =>
    couples.vote(id(req.params.cid), requireUser(req).id, id(req.params.item), req.body?.vote ?? null),
  );

  /** A view-once photo's encrypted bytes. Works once, for the person it was sent to; then it's deleted. */
  app.get<PI>("/api/couples/:cid/items/:item/photo", async (req, reply) => {
    const me = requireUser(req);
    const cid = id(req.params.cid);
    const item = id(req.params.item);
    const file = couples.openPhoto(cid, me.id, item);
    let data: Buffer;
    try {
      data = readFileSync(path.join(uploads, file));
    } finally {
      couples.photoOpened(cid, item, file);
    }
    return reply
      .header("content-type", "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "no-store")
      .send(data);
  });
}
