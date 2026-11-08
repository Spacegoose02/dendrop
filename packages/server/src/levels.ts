import { randomInt } from "node:crypto";
import { LEVEL_RULES, levelOf, type LeaderboardEntry } from "@dendrop/shared";
import type { Db } from "./db.js";
import type { Gateway } from "./gateway.js";
import type { ServerRepo } from "./servers.js";
import type { UserRecord } from "./users.js";

/**
 * Server levels: members earn LEVEL_RULES.xpMin to xpMax XP for a message in a text channel (or a thread or forum post), at
 * most once per cooldown so spamming doesn't pay. Levels give raccoon ranks (RACCOON_RANKS).
 * Bots and webhooks never earn XP. A server's owner and admins can turn levels off.
 */
export class LevelService {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerRepo,
    private readonly gateway: Gateway,
    /** Sends the server's members its new state; set once the server routes are up. */
    private readonly changed: (serverId: number) => void,
  ) {}

  /** Gives XP for a message just posted. Returns the new level if it went up. */
  award(conversationId: number, user: UserRecord, at = new Date()): number | undefined {
    if (user.isBot) return undefined;
    // Threads and forum posts count as their channel's chat.
    const channel = this.servers.channelOrThreadChannel(conversationId);
    if (!channel || channel.kind === "voice" || !this.servers.levelsOn(channel.serverId)) return undefined;
    const sid = channel.serverId;
    if (!this.servers.role(sid, user.id)) return undefined;
    const row = this.db.prepare("SELECT xp, last_award_at FROM server_xp WHERE server_id = ? AND user_id = ?").get(sid, user.id) as
      | { xp: number; last_award_at: string | null }
      | undefined;
    if (row?.last_award_at && at.getTime() - Date.parse(row.last_award_at) < LEVEL_RULES.cooldownSeconds * 1000) return undefined;
    const before = Number(row?.xp ?? 0);
    const after = before + randomInt(LEVEL_RULES.xpMin, LEVEL_RULES.xpMax + 1);
    this.db
      .prepare(
        `INSERT INTO server_xp (server_id, user_id, xp, last_award_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, user_id) DO UPDATE SET xp = excluded.xp, last_award_at = excluded.last_award_at`,
      )
      .run(sid, user.id, after, at.toISOString());
    const was = levelOf(before);
    const is = levelOf(after);
    if (is.level <= was.level) return undefined;
    this.gateway.send([user.id], { type: "level.up", serverId: sid, level: is.level, rank: is.rank, rankUp: is.rank.level !== was.rank.level });
    // Everyone's member list shows levels, so send the new state on a level up (not every message).
    this.changed(sid);
    return is.level;
  }

  /** The top of the server, most XP first. */
  leaderboard(serverId: number, limit = 100): LeaderboardEntry[] {
    const rows = this.db
      .prepare(
        `SELECT x.user_id, x.xp FROM server_xp x JOIN users u ON u.id = x.user_id
         WHERE x.server_id = ? AND x.xp > 0 AND u.is_bot = 0 ORDER BY x.xp DESC, x.user_id LIMIT ?`,
      )
      .all(serverId, limit) as { user_id: number; xp: number }[];
    return rows.map((r) => ({ userId: r.user_id, xp: Number(r.xp) }));
  }

  /** Sets everyone's XP back to zero, or one person's. */
  reset(serverId: number, userId?: number): void {
    if (userId === undefined) this.db.prepare("DELETE FROM server_xp WHERE server_id = ?").run(serverId);
    else this.db.prepare("DELETE FROM server_xp WHERE server_id = ? AND user_id = ?").run(serverId, userId);
  }

  /** For tests and imports: sets someone's XP directly. */
  setXp(serverId: number, userId: number, xp: number): void {
    this.db
      .prepare(
        `INSERT INTO server_xp (server_id, user_id, xp, last_award_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, user_id) DO UPDATE SET xp = excluded.xp, last_award_at = NULL`,
      )
      .run(serverId, userId, xp, null);
  }
}
