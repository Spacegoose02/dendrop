import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { findBlockedWords, INLINE_IMAGE_TYPES, isHexColor, isUnicodeEmoji, PROFILE_LIMITS, type CustomStatus, type UserProfile } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { HttpError } from "../errors.js";
import { toMe } from "../users.js";

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

const MB = PROFILE_LIMITS.imageBytes / 1024 / 1024;

/**
 * Profiles: GET someone's profile, edit your own (bio, pronouns, banner color, custom status),
 * and upload a profile picture and banner. Kid accounts: pictures need a parent's OK
 * (KidRules.profilePictures), text goes through the family filter, and every change tells the
 * parents. Parents can clear a kid's profile.
 */
export function profileRoutes(app: FastifyInstance, ctx: Context): void {
  const { users, profiles, family, config } = ctx;
  const uploads = path.join(config.dataDir, "uploads");

  app.get<{ Params: { id: string } }>("/api/users/:id/profile", async (req): Promise<UserProfile> => {
    const me = requireUser(req);
    const p = profiles.view(me.id, id(req.params.id));
    if (!p) throw new HttpError(404, "Not found");
    return p;
  });

  app.get<{ Params: { id: string; file: string } }>("/api/users/:id/pictures/:file", async (req, reply) => {
    const me = requireUser(req);
    const file = req.params.file;
    const pic = /^[0-9a-f]{32}$/.test(file) ? profiles.picture(me.id, id(req.params.id), file) : undefined;
    if (!pic) throw new HttpError(404, "Not found");
    return reply
      .header("content-type", pic.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(pic.path));
  });

  app.patch<{ Body: Record<string, unknown> }>("/api/me/profile", async (req): Promise<UserProfile> => {
    const me = requireUser(req);
    const body = req.body ?? {};
    const patch: { bio?: string; pronouns?: string; bannerColor?: string | null; status?: CustomStatus | null } = {};
    const text = (key: "bio" | "pronouns", max: number) => {
      const v = body[key];
      if (v === undefined) return;
      if (typeof v !== "string") throw new HttpError(400, `${key} is text`);
      // Bios keep their line breaks (a few), pronouns are one line.
      const clean = key === "bio" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : v.replace(/\s+/g, " ").trim();
      if ([...clean].length > max) throw new HttpError(400, `${key === "bio" ? "About me" : "Pronouns"} can be up to ${max} characters`);
      patch[key] = clean;
    };
    text("bio", PROFILE_LIMITS.bio);
    text("pronouns", PROFILE_LIMITS.pronouns);
    if (body.bannerColor !== undefined) {
      if (body.bannerColor !== null && !isHexColor(body.bannerColor)) throw new HttpError(400, "bannerColor is a #rrggbb color or null");
      patch.bannerColor = body.bannerColor;
    }
    if (body.status !== undefined) {
      const s = body.status as { emoji?: unknown; text?: unknown; expiresAt?: unknown } | null;
      if (s === null) patch.status = null;
      else {
        if (typeof s !== "object") throw new HttpError(400, "status is { emoji, text, expiresAt } or null");
        const emoji = s.emoji === undefined || s.emoji === null || s.emoji === "" ? null : s.emoji;
        if (emoji !== null && !isUnicodeEmoji(emoji)) throw new HttpError(400, "A status emoji is one emoji");
        if (typeof s.text !== "string") throw new HttpError(400, "A status needs text");
        const t = s.text.replace(/\s+/g, " ").trim();
        if (!t && !emoji) throw new HttpError(400, "A status needs text or an emoji");
        if ([...t].length > PROFILE_LIMITS.statusText) throw new HttpError(400, `A status can be up to ${PROFILE_LIMITS.statusText} characters`);
        let expiresAt: string | null = null;
        if (s.expiresAt !== undefined && s.expiresAt !== null) {
          const at = typeof s.expiresAt === "string" ? Date.parse(s.expiresAt) : NaN;
          if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + PROFILE_LIMITS.statusDays * 86_400_000) {
            throw new HttpError(400, `A status can clear itself from now up to ${PROFILE_LIMITS.statusDays} days ahead`);
          }
          expiresAt = new Date(at).toISOString();
        }
        patch.status = { emoji, text: t, expiresAt };
      }
    }
    if (me.isKid) {
      // Profiles aren't encrypted and everyone around the kid sees them, so the server checks them.
      const rules = family.rules(me.id);
      const words = [patch.bio, patch.pronouns, patch.status?.text].filter((t): t is string => !!t).join("\n");
      if (rules.profanityFilter && words && findBlockedWords(words, rules.blockedWords).length) {
        throw new HttpError(400, "That has a word your family filter blocks");
      }
    }
    users.setProfile(me.id, patch);
    if (me.isKid && Object.keys(patch).length) family.alert(me.id, "profile", {});
    if (patch.status !== undefined) profiles.announce(me.id);
    return profiles.view(me.id, me.id)!;
  });

  /** Sets the profile picture or banner from one uploaded picture. */
  app.put<{ Params: { kind: string } }>("/api/me/:kind(avatar|banner)", async (req) => {
    const me = requireUser(req);
    const kind = req.params.kind === "banner" ? "banner" : "avatar";
    if (me.isKid && !family.rules(me.id).profilePictures) throw new HttpError(403, "Ask a parent: your account can't have a profile picture yet");
    if (!req.isMultipart()) throw new HttpError(400, "Send the picture as multipart form data");
    const part = await req.file({ limits: { fileSize: PROFILE_LIMITS.imageBytes, files: 1 } });
    if (!part) throw new HttpError(400, "Send a picture");
    const type = part.mimetype.toLowerCase();
    if (!INLINE_IMAGE_TYPES.includes(type)) {
      part.file.resume();
      throw new HttpError(400, "Use a PNG, JPEG, GIF or WebP picture");
    }
    const file = randomBytes(16).toString("hex");
    const dest = path.join(uploads, file);
    try {
      await pipeline(part.file, createWriteStream(dest, { flags: "wx" }));
      if (part.file.truncated || statSync(dest).size === 0) throw new HttpError(413, `Pictures can be up to ${MB} MB`);
    } catch (err) {
      rmSync(dest, { force: true });
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, `Pictures can be up to ${MB} MB`);
      throw err;
    }
    profiles.removeFile(users.setPicture(me.id, kind, file, type));
    if (me.isKid) family.alert(me.id, "profile", {});
    if (kind === "avatar") profiles.announce(me.id);
    return { me: toMe(users.byId(me.id)!), profile: profiles.view(me.id, me.id)! };
  });

  app.delete<{ Params: { kind: string } }>("/api/me/:kind(avatar|banner)", async (req) => {
    const me = requireUser(req);
    const kind = req.params.kind === "banner" ? "banner" : "avatar";
    profiles.removeFile(users.setPicture(me.id, kind, null, null));
    if (kind === "avatar") profiles.announce(me.id);
    return { me: toMe(users.byId(me.id)!), profile: profiles.view(me.id, me.id)! };
  });

  /** A parent clears their kid's profile: picture, banner, about me, pronouns and status. */
  app.delete<{ Params: { kidId: string } }>("/api/family/kids/:kidId/profile", async (req) => {
    const me = requireUser(req);
    const kidId = id(req.params.kidId);
    family.requireParent(me.id, kidId);
    profiles.reset(kidId);
    return profiles.view(me.id, kidId)!;
  });
}
