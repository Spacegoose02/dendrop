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
  createdAt: r.created_at,
});

export const toPublic = (u: UserRecord): PublicUser => ({ id: u.id, username: u.username, displayName: u.displayName });
export const toMe = (u: UserRecord): Me => ({ ...toPublic(u), email: u.email, isSuperAdmin: u.isSuperAdmin });

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
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r && fromRow(r);
  }

  byUsername(username: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Row | undefined;
    return r && fromRow(r);
  }

  byEmail(email: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ? ORDER BY id LIMIT 1").get(email) as Row | undefined;
    return r && fromRow(r);
  }

  byOidcSubject(sub: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE oidc_subject = ?").get(sub) as Row | undefined;
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

  update(id: number, patch: { displayName?: string; oidcSubject?: string; isSuperAdmin?: boolean; passwordHash?: string }): UserRecord {
    if (patch.displayName !== undefined) this.db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(patch.displayName, id);
    if (patch.oidcSubject !== undefined) this.db.prepare("UPDATE users SET oidc_subject = ? WHERE id = ?").run(patch.oidcSubject, id);
    if (patch.isSuperAdmin !== undefined) this.db.prepare("UPDATE users SET is_super_admin = ? WHERE id = ?").run(patch.isSuperAdmin ? 1 : 0, id);
    if (patch.passwordHash !== undefined) this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(patch.passwordHash, id);
    return this.byId(id)!;
  }
}
