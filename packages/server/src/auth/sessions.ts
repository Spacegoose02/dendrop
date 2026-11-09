import { now, type Db } from "../db.js";
import type { UserRecord, UserRepo } from "../users.js";
import { newSecret, sha256 } from "./crypto.js";

export const SESSION_COOKIE = "dendrop_session";
/**
 * How long a sign-in lasts without being used. Every visit pushes the end back (at most once a
 * day), so a phone or PC that opens Dendrop now and then stays signed in for good, and one left
 * in a drawer for three months has to sign in again.
 */
export const SESSION_DAYS = 90;
const RENEW_AFTER_MS = 86400_000;

export interface ResolvedSession {
  user: UserRecord;
  /** Set when the sign-in was just extended: send the cookie again with this lifetime. */
  renewedMaxAgeSeconds?: number;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
  ) {}

  create(userId: number, userAgent?: string): { token: string; maxAgeSeconds: number } {
    const token = newSecret("dds");
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now(), expiresFrom(Date.now()), userAgent?.slice(0, 200) ?? null);
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
    return this.resolveAndRenew(token)?.user;
  }

  /**
   * Like resolve, and slides the session's end forward when it was last extended over a day ago,
   * so people who keep using Dendrop are never signed out by surprise.
   */
  resolveAndRenew(token: string | undefined): ResolvedSession | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(hash) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.end(token);
      return undefined;
    }
    const user = this.users.byId(row.user_id);
    if (!user) return undefined;
    const fresh = expiresFrom(Date.now());
    if (Date.parse(fresh) - Date.parse(row.expires_at) < RENEW_AFTER_MS) return { user };
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(fresh, hash);
    return { user, renewedMaxAgeSeconds: SESSION_DAYS * 86400 };
  }
}

const expiresFrom = (ms: number) => new Date(ms + SESSION_DAYS * 86400_000).toISOString();
