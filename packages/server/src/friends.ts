import type { Friend } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { toPublic, type UserRepo } from "./users.js";

interface Row {
  user_a: number;
  user_b: number;
  requester_id: number;
  accepted_at: string | null;
  created_at: string;
  held_for_parent: number;
}

const pair = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);

export class FriendRepo {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
  ) {}

  private row(x: number, y: number): Row | undefined {
    const [a, b] = pair(x, y);
    return this.db.prepare("SELECT * FROM friendships WHERE user_a = ? AND user_b = ?").get(a, b) as Row | undefined;
  }

  /** How `other` looks from `me`'s side, or undefined when there's no friendship or request. */
  view(me: number, other: number): Friend | undefined {
    const r = this.row(me, other);
    const user = this.users.byId(other);
    if (!r || !user) return undefined;
    return {
      user: toPublic(user),
      state: r.accepted_at ? (r.held_for_parent ? "held" : "friends") : r.requester_id === me ? "outgoing" : "incoming",
      since: r.accepted_at ?? r.created_at,
    };
  }

  list(me: number): Friend[] {
    const rows = this.db.prepare("SELECT * FROM friendships WHERE user_a = ? OR user_b = ?").all(me, me) as unknown as Row[];
    return rows
      .map((r) => this.view(me, r.user_a === me ? r.user_b : r.user_a))
      .filter((f): f is Friend => !!f)
      .sort((x, y) => x.user.displayName.localeCompare(y.user.displayName));
  }

  /** Friends who can chat: accepted, and not waiting for a kid's parent to approve. */
  areFriends(x: number, y: number): boolean {
    const r = this.row(x, y);
    return !!r?.accepted_at && !r.held_for_parent;
  }

  /**
   * Sends a friend request, or accepts one when the other person already asked.
   * Returns the friendship as `me` sees it.
   */
  request(me: number, other: number): Friend {
    if (me === other) throw new Error("You can't add yourself");
    const existing = this.row(me, other);
    if (!existing) {
      const [a, b] = pair(me, other);
      this.db.prepare("INSERT INTO friendships (user_a, user_b, requester_id, created_at) VALUES (?, ?, ?, ?)").run(a, b, me, now());
    } else if (!existing.accepted_at && existing.requester_id !== me) {
      this.accept(me, other);
    }
    return this.view(me, other)!;
  }

  accept(me: number, other: number): Friend {
    const r = this.row(me, other);
    if (!r || r.requester_id === me) throw new Error("There's no friend request from them");
    if (!r.accepted_at) {
      const [a, b] = pair(me, other);
      this.db.prepare("UPDATE friendships SET accepted_at = ?, held_for_parent = ? WHERE user_a = ? AND user_b = ?").run(now(), this.needsParent(a, b) ? 1 : 0, a, b);
    }
    return this.view(me, other)!;
  }

  /** Whether a kid in this pair has parents who approve new friends (their own parents don't count). */
  private needsParent(a: number, b: number): boolean {
    const waits = (kid: number, other: number) =>
      !!this.db
        .prepare(
          `SELECT 1 FROM kid_rules r WHERE r.kid_id = ? AND r.approve_friends = 1
           AND NOT EXISTS (SELECT 1 FROM family_links f WHERE f.kid_id = ? AND f.parent_id = ?)`,
        )
        .get(kid, kid, other);
    return waits(a, b) || waits(b, a);
  }

  /** Removes a friend, declines a request or cancels one. */
  remove(me: number, other: number): boolean {
    const [a, b] = pair(me, other);
    return Number(this.db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b).changes) > 0;
  }
}
