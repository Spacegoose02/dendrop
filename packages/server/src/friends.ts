import type { Friend } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { toPublic, type UserRepo } from "./users.js";

interface Row {
  user_a: number;
  user_b: number;
  requester_id: number;
  accepted_at: string | null;
  created_at: string;
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
      state: r.accepted_at ? "friends" : r.requester_id === me ? "outgoing" : "incoming",
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

  areFriends(x: number, y: number): boolean {
    return !!this.row(x, y)?.accepted_at;
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
      this.db.prepare("UPDATE friendships SET accepted_at = ? WHERE user_a = ? AND user_b = ?").run(now(), a, b);
    }
    return this.view(me, other)!;
  }

  /** Removes a friend, declines a request or cancels one. */
  remove(me: number, other: number): boolean {
    const [a, b] = pair(me, other);
    return Number(this.db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b).changes) > 0;
  }
}
