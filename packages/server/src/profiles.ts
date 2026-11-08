import { rmSync } from "node:fs";
import path from "node:path";
import type { UserProfile } from "@dendrop/shared";
import type { Db } from "./db.js";
import type { Gateway } from "./gateway.js";
import { toPublic, type UserRepo } from "./users.js";

/**
 * Profiles: pictures, banners, bios, pronouns and custom statuses.
 *
 * Who can see someone's profile (and their picture): themselves, anyone they're friends with or
 * have a friend request with, anyone they share a chat or a server with, and their family. To
 * everyone else they don't exist (404). Kids' profiles follow their parents' rules: pictures need
 * a parent's OK, and their text goes through the family filter (see routes/profiles.ts).
 */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly uploads: string,
  ) {}

  /** Everyone who can see `userId`'s profile, not counting them. */
  audience(userId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = ?1 OR user_b = ?1
         UNION
         SELECT b.user_id FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
           WHERE a.user_id = ?1 AND b.user_id != ?1
         UNION
         SELECT b.user_id FROM server_members a JOIN server_members b ON b.server_id = a.server_id
           WHERE a.user_id = ?1 AND b.user_id != ?1
         UNION
         SELECT parent_id FROM family_links WHERE kid_id = ?1
         UNION
         SELECT kid_id FROM family_links WHERE parent_id = ?1`,
      )
      .all(userId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  canSee(viewerId: number, userId: number): boolean {
    if (viewerId === userId) return true;
    const [a, b] = viewerId < userId ? [viewerId, userId] : [userId, viewerId];
    return !!this.db
      .prepare(
        `SELECT 1 WHERE
           EXISTS (SELECT 1 FROM friendships WHERE user_a = ?1 AND user_b = ?2)
           OR EXISTS (SELECT 1 FROM conversation_members x JOIN conversation_members y ON y.conversation_id = x.conversation_id WHERE x.user_id = ?1 AND y.user_id = ?2)
           OR EXISTS (SELECT 1 FROM server_members x JOIN server_members y ON y.server_id = x.server_id WHERE x.user_id = ?1 AND y.user_id = ?2)
           OR EXISTS (SELECT 1 FROM family_links WHERE (kid_id = ?1 AND parent_id = ?2) OR (kid_id = ?2 AND parent_id = ?1))`,
      )
      .get(a, b);
  }

  /** `userId`'s profile as `viewerId` sees it, or undefined when they can't. */
  view(viewerId: number, userId: number): UserProfile | undefined {
    const u = this.users.byId(userId);
    if (!u || !this.canSee(viewerId, userId)) return undefined;
    const [a, b] = viewerId < userId ? [viewerId, userId] : [userId, viewerId];
    const friend = this.db.prepare("SELECT accepted_at FROM friendships WHERE user_a = ? AND user_b = ? AND held_for_parent = 0").get(a, b) as
      | { accepted_at: string | null }
      | undefined;
    const mutual = this.db
      .prepare(
        `SELECT s.id, s.name FROM servers s
         JOIN server_members x ON x.server_id = s.id AND x.user_id = ?
         JOIN server_members y ON y.server_id = s.id AND y.user_id = ?
         ORDER BY s.name COLLATE NOCASE`,
      )
      .all(viewerId, userId) as { id: number; name: string }[];
    return {
      user: toPublic(u),
      bio: u.bio,
      pronouns: u.pronouns,
      banner: u.bannerFile ? `/api/users/${u.id}/pictures/${u.bannerFile}` : null,
      bannerColor: u.bannerColor,
      createdAt: u.createdAt,
      friendsSince: viewerId === userId ? null : (friend?.accepted_at ?? null),
      mutualServers: viewerId === userId ? [] : mutual.map((m) => ({ id: Number(m.id), name: m.name })),
      isKid: u.isKid,
    };
  }

  /** A picture of `userId`'s that `viewerId` may load, or undefined. */
  picture(viewerId: number, userId: number, file: string): { type: string; path: string } | undefined {
    const u = this.users.byId(userId);
    if (!u || !this.canSee(viewerId, userId)) return undefined;
    if (u.avatarFile === file && u.avatarType) return { type: u.avatarType, path: path.join(this.uploads, file) };
    if (u.bannerFile === file && u.bannerType) return { type: u.bannerType, path: path.join(this.uploads, file) };
    return undefined;
  }

  /** Tells the person and everyone who can see them how they look now. */
  announce(userId: number): void {
    const u = this.users.byId(userId);
    if (!u) return;
    this.gateway.send([userId, ...this.audience(userId)], { type: "user.updated", user: toPublic(u) });
  }

  removeFile(file: string | null): void {
    if (file) rmSync(path.join(this.uploads, file), { force: true });
  }

  /** Takes a kid's picture and banner down (their parent turned profile pictures off). */
  takeDownPictures(userId: number): void {
    const u = this.users.byId(userId);
    if (!u || (!u.avatarFile && !u.bannerFile)) return;
    this.removeFile(this.users.setPicture(userId, "avatar", null, null));
    this.removeFile(this.users.setPicture(userId, "banner", null, null));
    this.announce(userId);
  }

  /** Clears everything on a profile: a parent's reset for a kid. */
  reset(userId: number): void {
    this.removeFile(this.users.setPicture(userId, "avatar", null, null));
    this.removeFile(this.users.setPicture(userId, "banner", null, null));
    this.users.setProfile(userId, { bio: "", pronouns: "", bannerColor: null, status: null });
    this.announce(userId);
  }
}
