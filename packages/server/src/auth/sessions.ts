import { now, type Db } from "../db.js";
import type { UserRecord, UserRepo } from "../users.js";
import { newSecret, sha256 } from "./crypto.js";

export const SESSION_COOKIE = "dendrop_session";
const SESSION_DAYS = 30;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
  ) {}

  create(userId: number, userAgent?: string): { token: string; maxAgeSeconds: number } {
    const token = newSecret("dds");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now(), expires, userAgent?.slice(0, 200) ?? null);
    return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
  }

  /** Signs someone out everywhere, except the session given (after a password change). */
  endAllFor(userId: number, keepToken?: string): void {
    if (keepToken) this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha256(keepToken));
    else this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  end(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** The signed-in user for a session token, or undefined when it is unknown or expired. */
  resolve(token: string | undefined): UserRecord | undefined {
    if (!token) return undefined;
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.end(token);
      return undefined;
    }
    return this.users.byId(row.user_id);
  }
}
