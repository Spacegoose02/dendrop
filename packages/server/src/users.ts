import { liveStatus, type CustomStatus, type Me, type PublicUser } from "@dendrop/shared";
import { now, type Db } from "./db.js";

export interface UserRecord {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  oidcSubject: string | null;
  googleSubject: string | null;
  googleEmail: string | null;
  /** The parent who made this kid account under theirs. */
  managedBy: number | null;
  isSuperAdmin: boolean;
  readReceipts: boolean;
  shareActivity: boolean;
  publicKey: string | null;
  keyBackup: string | null;
  canCreateServers: boolean;
  nameColor: string | null;
  textColor: string | null;
  avatarFile: string | null;
  avatarType: string | null;
  bannerFile: string | null;
  bannerType: string | null;
  bannerColor: string | null;
  bio: string;
  pronouns: string;
  /** Their custom status, even if it has expired (toPublic drops expired ones). */
  status: CustomStatus | null;
  /** Linked to at least one parent. */
  isKid: boolean;
  /** A bot account (see bots.ts): no password, never in DMs. */
  isBot: boolean;
  /** A super admin switched the couples kit on for them (see couplesAllowed). */
  couplesKit: boolean;
  createdAt: string;
}

interface Row {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  oidc_subject: string | null;
  google_subject: string | null;
  google_email: string | null;
  managed_by: number | null;
  is_super_admin: number;
  read_receipts: number;
  share_activity: number;
  public_key: string | null;
  key_backup: string | null;
  can_create_servers: number;
  name_color: string | null;
  text_color: string | null;
  avatar_file: string | null;
  avatar_type: string | null;
  banner_file: string | null;
  banner_type: string | null;
  banner_color: string | null;
  bio: string;
  pronouns: string;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: string | null;
  is_kid: number;
  is_bot: number;
  couples_kit: number;
  created_at: string;
}

const fromRow = (r: Row): UserRecord => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  email: r.email,
  passwordHash: r.password_hash,
  oidcSubject: r.oidc_subject,
  googleSubject: r.google_subject,
  googleEmail: r.google_email,
  managedBy: r.managed_by,
  isSuperAdmin: !!r.is_super_admin,
  readReceipts: !!r.read_receipts,
  shareActivity: !!r.share_activity,
  publicKey: r.public_key,
  keyBackup: r.key_backup,
  canCreateServers: !!r.can_create_servers,
  nameColor: r.name_color,
  textColor: r.text_color,
  avatarFile: r.avatar_file,
  avatarType: r.avatar_type,
  bannerFile: r.banner_file,
  bannerType: r.banner_type,
  bannerColor: r.banner_color,
  bio: r.bio,
  pronouns: r.pronouns,
  status: r.status_text !== null ? { emoji: r.status_emoji, text: r.status_text, expiresAt: r.status_expires_at } : null,
  isKid: !!r.is_kid,
  isBot: !!r.is_bot,
  couplesKit: !!r.couples_kit,
  createdAt: r.created_at,
});

/** Where a profile picture or banner is served. The file name changes with the picture, so it caches forever. */
export const pictureUrl = (userId: number, file: string | null): string | null => (file ? `/api/users/${userId}/pictures/${file}` : null);

export const toPublic = (u: UserRecord): PublicUser => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  publicKey: u.publicKey,
  nameColor: u.nameColor,
  textColor: u.textColor,
  avatar: pictureUrl(u.id, u.avatarFile),
  status: liveStatus(u.status),
  ...(u.isBot ? { isBot: true } : {}),
});
/**
 * Whether someone can use the couples kit: super admins, and accounts a super admin switched it
 * on for. Never a kid account or a bot, whatever the switch says.
 */
export const couplesAllowed = (u: Pick<UserRecord, "isKid" | "isBot" | "isSuperAdmin" | "couplesKit">): boolean =>
  !u.isKid && !u.isBot && (u.isSuperAdmin || u.couplesKit);

export const toMe = (u: UserRecord): Me => ({
  ...toPublic(u),
  email: u.email,
  isSuperAdmin: u.isSuperAdmin,
  readReceipts: u.readReceipts,
  shareActivity: u.shareActivity,
  canCreateServers: u.isSuperAdmin || u.canCreateServers,
  isKid: u.isKid,
  managedBy: u.isKid ? u.managedBy : null,
  couplesKit: couplesAllowed(u),
});

/** Every user column, plus whether they're a kid account. */
const SELECT = "SELECT users.*, EXISTS (SELECT 1 FROM family_links f WHERE f.kid_id = users.id) AS is_kid FROM users";

export interface NewUser {
  username: string;
  displayName: string;
  email?: string | null;
  passwordHash?: string | null;
  oidcSubject?: string | null;
  isSuperAdmin?: boolean;
  isBot?: boolean;
  managedBy?: number | null;
}

export class UserRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
  }

  byId(id: number): UserRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return r && fromRow(r);
  }

  byUsername(username: string): UserRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE username = ?`).get(username) as Row | undefined;
    return r && fromRow(r);
  }

  byEmail(email: string): UserRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE email = ? ORDER BY id LIMIT 1`).get(email) as Row | undefined;
    return r && fromRow(r);
  }

  byOidcSubject(sub: string): UserRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE oidc_subject = ?`).get(sub) as Row | undefined;
    return r && fromRow(r);
  }

  byGoogleSubject(sub: string): UserRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE google_subject = ?`).get(sub) as Row | undefined;
    return r && fromRow(r);
  }

  /** People (not bots), oldest first, for the admin's account list. */
  all(): UserRecord[] {
    return (this.db.prepare(`${SELECT} WHERE is_bot = 0 ORDER BY id`).all() as unknown as Row[]).map(fromRow);
  }

  /** Links or unlinks (null) a sign-in. */
  setSignIn(id: number, provider: "tinyauth" | "google", subject: string | null, email: string | null = null): UserRecord {
    if (provider === "tinyauth") this.db.prepare("UPDATE users SET oidc_subject = ? WHERE id = ?").run(subject, id);
    else this.db.prepare("UPDATE users SET google_subject = ?, google_email = ? WHERE id = ?").run(subject, subject ? email : null, id);
    return this.byId(id)!;
  }

  setManagedBy(id: number, parentId: number | null): UserRecord {
    this.db.prepare("UPDATE users SET managed_by = ? WHERE id = ?").run(parentId, id);
    return this.byId(id)!;
  }

  create(u: NewUser): UserRecord {
    const res = this.db
      .prepare(
        "INSERT INTO users (username, display_name, email, password_hash, oidc_subject, is_super_admin, is_bot, managed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(u.username, u.displayName, u.email ?? null, u.passwordHash ?? null, u.oidcSubject ?? null, u.isSuperAdmin ? 1 : 0, u.isBot ? 1 : 0, u.managedBy ?? null, now());
    return this.byId(Number(res.lastInsertRowid))!;
  }

  setCouplesKit(id: number, on: boolean): UserRecord {
    this.db.prepare("UPDATE users SET couples_kit = ? WHERE id = ?").run(on ? 1 : 0, id);
    return this.byId(id)!;
  }

  setCanCreateServers(id: number, allowed: boolean): UserRecord {
    this.db.prepare("UPDATE users SET can_create_servers = ? WHERE id = ?").run(allowed ? 1 : 0, id);
    return this.byId(id)!;
  }

  setKeys(id: number, publicKey: string, keyBackup: string): UserRecord {
    this.db.prepare("UPDATE users SET public_key = ?, key_backup = ? WHERE id = ?").run(publicKey, keyBackup, id);
    return this.byId(id)!;
  }

  /** Sets (or clears, with null) the profile picture or banner. Returns the old file to delete. */
  setPicture(id: number, kind: "avatar" | "banner", file: string | null, type: string | null): string | null {
    const old = this.byId(id);
    if (kind === "avatar") this.db.prepare("UPDATE users SET avatar_file = ?, avatar_type = ? WHERE id = ?").run(file, type, id);
    else this.db.prepare("UPDATE users SET banner_file = ?, banner_type = ? WHERE id = ?").run(file, type, id);
    return (kind === "avatar" ? old?.avatarFile : old?.bannerFile) ?? null;
  }

  setProfile(id: number, patch: { bio?: string; pronouns?: string; bannerColor?: string | null; status?: CustomStatus | null }): UserRecord {
    if (patch.bio !== undefined) this.db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(patch.bio, id);
    if (patch.pronouns !== undefined) this.db.prepare("UPDATE users SET pronouns = ? WHERE id = ?").run(patch.pronouns, id);
    if (patch.bannerColor !== undefined) this.db.prepare("UPDATE users SET banner_color = ? WHERE id = ?").run(patch.bannerColor && patch.bannerColor.toLowerCase(), id);
    if (patch.status !== undefined) {
      const st = patch.status;
      this.db.prepare("UPDATE users SET status_emoji = ?, status_text = ?, status_expires_at = ? WHERE id = ?").run(st?.emoji ?? null, st ? st.text : null, st?.expiresAt ?? null, id);
    }
    return this.byId(id)!;
  }

  update(
    id: number,
    patch: {
      displayName?: string;
      oidcSubject?: string;
      isSuperAdmin?: boolean;
      passwordHash?: string;
      readReceipts?: boolean;
      shareActivity?: boolean;
      /** null clears it back to the theme's color. */
      nameColor?: string | null;
      textColor?: string | null;
    },
  ): UserRecord {
    if (patch.nameColor !== undefined) this.db.prepare("UPDATE users SET name_color = ? WHERE id = ?").run(patch.nameColor && patch.nameColor.toLowerCase(), id);
    if (patch.textColor !== undefined) this.db.prepare("UPDATE users SET text_color = ? WHERE id = ?").run(patch.textColor && patch.textColor.toLowerCase(), id);
    if (patch.readReceipts !== undefined) this.db.prepare("UPDATE users SET read_receipts = ? WHERE id = ?").run(patch.readReceipts ? 1 : 0, id);
    if (patch.shareActivity !== undefined) this.db.prepare("UPDATE users SET share_activity = ? WHERE id = ?").run(patch.shareActivity ? 1 : 0, id);
    if (patch.displayName !== undefined) this.db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(patch.displayName, id);
    if (patch.oidcSubject !== undefined) this.db.prepare("UPDATE users SET oidc_subject = ? WHERE id = ?").run(patch.oidcSubject, id);
    if (patch.isSuperAdmin !== undefined) this.db.prepare("UPDATE users SET is_super_admin = ? WHERE id = ?").run(patch.isSuperAdmin ? 1 : 0, id);
    if (patch.passwordHash !== undefined) this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(patch.passwordHash, id);
    return this.byId(id)!;
  }
}
