import type { Me, PublicUser } from "@dendrop/shared";
import { now, type Db } from "./db.js";

export interface UserRecord {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  oidcSubject: string | null;
  isSuperAdmin: boolean;
  readReceipts: boolean;
  shareActivity: boolean;
  publicKey: string | null;
  keyBackup: string | null;
  canCreateServers: boolean;
  nameColor: string | null;
  textColor: string | null;
  /** Linked to at least one parent. */
  isKid: boolean;
  createdAt: string;
}

interface Row {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  oidc_subject: string | null;
  is_super_admin: number;
  read_receipts: number;
  share_activity: number;
  public_key: string | null;
  key_backup: string | null;
  can_create_servers: number;
  name_color: string | null;
  text_color: string | null;
  is_kid: number;
  created_at: string;
}

const fromRow = (r: Row): UserRecord => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  email: r.email,
  passwordHash: r.password_hash,
  oidcSubject: r.oidc_subject,
  isSuperAdmin: !!r.is_super_admin,
  readReceipts: !!r.read_receipts,
  shareActivity: !!r.share_activity,
  publicKey: r.public_key,
  keyBackup: r.key_backup,
  canCreateServers: !!r.can_create_servers,
  nameColor: r.name_color,
  textColor: r.text_color,
  isKid: !!r.is_kid,
  createdAt: r.created_at,
});

export const toPublic = (u: UserRecord): PublicUser => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  publicKey: u.publicKey,
  nameColor: u.nameColor,
  textColor: u.textColor,
});
export const toMe = (u: UserRecord): Me => ({
  ...toPublic(u),
  email: u.email,
  isSuperAdmin: u.isSuperAdmin,
  readReceipts: u.readReceipts,
  shareActivity: u.shareActivity,
  canCreateServers: u.isSuperAdmin || u.canCreateServers,
  isKid: u.isKid,
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

  create(u: NewUser): UserRecord {
    const res = this.db
      .prepare(
        "INSERT INTO users (username, display_name, email, password_hash, oidc_subject, is_super_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(u.username, u.displayName, u.email ?? null, u.passwordHash ?? null, u.oidcSubject ?? null, u.isSuperAdmin ? 1 : 0, now());
    return this.byId(Number(res.lastInsertRowid))!;
  }

  setCanCreateServers(id: number, allowed: boolean): UserRecord {
    this.db.prepare("UPDATE users SET can_create_servers = ? WHERE id = ?").run(allowed ? 1 : 0, id);
    return this.byId(id)!;
  }

  setKeys(id: number, publicKey: string, keyBackup: string): UserRecord {
    this.db.prepare("UPDATE users SET public_key = ?, key_backup = ? WHERE id = ?").run(publicKey, keyBackup, id);
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
