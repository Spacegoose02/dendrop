import type { PublicUser } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { toPublic, type UserRepo } from "./users.js";

/**
 * Who blocked whom. A block works both ways for friend requests and the 1:1 DM (neither side
 * can start or send), and one way for groups and channels: the blocker's apps hide the blocked
 * person's messages. The blocked person isn't told.
 */
export class BlockRepo {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
  ) {}

  /** Whether `blocker` blocked `blocked`. */
  has(blocker: number, blocked: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").get(blocker, blocked);
  }

  /** Whether either of the two blocked the other. */
  between(a: number, b: number): boolean {
    return this.has(a, b) || this.has(b, a);
  }

  list(me: number): PublicUser[] {
    const rows = this.db.prepare("SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at").all(me) as { blocked_id: number }[];
    return rows.flatMap((r) => {
      const u = this.users.byId(r.blocked_id);
      return u ? [toPublic(u)] : [];
    });
  }

  /** Returns false if they were already blocked. */
  block(me: number, other: number): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").run(me, other, now()).changes) > 0;
  }

  unblock(me: number, other: number): boolean {
    return Number(this.db.prepare("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").run(me, other).changes) > 0;
  }
}
