import path from "node:path";
import type { Channel, PlayTogether as PlayTogetherInvite } from "@dendrop/shared";
import type { Context } from "./app.js";
import { now } from "./db.js";
import { cleanChannelName, isModerator, ServerRepo } from "./servers.js";
import { removeVoiceWhenEmpty } from "./temp-voice.js";

interface Row {
  server_id: number;
  game: string;
  voice_channel_id: number | null;
}

interface Group {
  serverId: number;
  /** The title in lowercase, so "Stardew Valley" and "stardew valley" are one game. */
  game: string;
  title: string;
  players: number[];
  /** Someone with a LootDen kid profile is playing it, and kid profiles only have kid-safe games. */
  kidSafe: boolean;
}

/** Who can see the channel: everyone, or (a grown-up game in a server with kids) only the grown-ups. */
type Access = { locked: false } | { locked: true; memberIds: number[] };

/** A voice channel name for a game: "playing-stardew-valley". */
export function playChannelName(title: string): string {
  try {
    return cleanChannelName(`playing-${title}`.slice(0, 32));
  } catch {
    return "playing-together";
  }
}

/**
 * Voice channels that open by themselves when people play together. When two or more members
 * of a server are playing the same game (LootDen's Playing now), that server gets a voice
 * channel for the game and the players are asked if they'd like to join it. It stays while
 * anyone's still playing, and goes once everyone has stopped and nobody's left talking in it.
 *
 * Only people who share what they're playing count. Kids don't see grown-ups' game names, so in
 * a server with kid accounts a grown-up game's channel is locked to the grown-ups; a game a kid
 * profile is playing is kid-safe and open to everyone. Owners and admins can turn it off for
 * their server, and a channel they delete stays gone until everyone has stopped playing.
 */
export class PlayTogether {
  private readonly servers: ServerRepo;
  private readonly uploads: string;
  /** Who's been asked to join each channel, so nobody's asked twice. */
  private readonly asked = new Map<number, Set<number>>();
  /** The access each channel was last given, to change it only when it needs to. */
  private readonly access = new Map<number, string>();

  constructor(private readonly ctx: Context) {
    this.servers = new ServerRepo(ctx.db, ctx.users);
    this.uploads = path.join(ctx.config.dataDir, "uploads");
    ctx.lootden.onPlayingChanged.push(() => this.sync());
    // Again after every check, to tidy up channels people have since left.
    ctx.lootden.afterPoll.push(async () => this.sync());
  }

  /** Who's playing what, by server, among servers that have this on. */
  private groups(): Map<string, Group> {
    const { db, users, lootden } = this.ctx;
    const playing = new Map(
      lootden
        .nowPlaying()
        .filter((p) => p.title !== "a game" && users.byId(p.userId)?.shareActivity)
        .map((p) => [p.userId, p]),
    );
    const out = new Map<string, Group>();
    if (!playing.size) return out;
    const ids = [...playing.keys()];
    const rows = db
      .prepare(
        `SELECT m.server_id, m.user_id FROM server_members m JOIN servers s ON s.id = m.server_id
          WHERE s.play_together = 1 AND m.user_id IN (${ids.map(() => "?").join(", ")}) ORDER BY m.server_id, m.user_id`,
      )
      .all(...ids) as { server_id: number; user_id: number }[];
    for (const r of rows) {
      const p = playing.get(r.user_id)!;
      const game = p.title.trim().toLowerCase();
      const key = `${r.server_id}\n${game}`;
      let g = out.get(key);
      if (!g) out.set(key, (g = { serverId: r.server_id, game, title: p.title.trim(), players: [], kidSafe: false }));
      g.players.push(r.user_id);
      if (p.kidProfile) g.kidSafe = true;
    }
    for (const g of out.values()) {
      // A kid account can't be shown a grown-up game, so it isn't counted for one.
      if (!g.kidSafe) g.players = g.players.filter((id) => !users.byId(id)?.isKid);
    }
    return out;
  }

  /** null when it can't be kept from a kid (a kid who's an admin there sees every channel). */
  private accessFor(g: Group): Access | null {
    if (g.kidSafe) return { locked: false };
    const kids = this.servers.members(g.serverId).filter((m) => this.ctx.users.byId(m.user.id)?.isKid);
    if (!kids.length) return { locked: false };
    if (kids.some((k) => isModerator(k.role))) return null;
    const kidIds = new Set(kids.map((k) => k.user.id));
    return { locked: true, memberIds: this.servers.memberIds(g.serverId).filter((id) => !kidIds.has(id)) };
  }

  sync(): void {
    const { db } = this.ctx;
    const groups = this.groups();
    const rows = db.prepare("SELECT server_id, game, voice_channel_id FROM play_together_channels").all() as unknown as Row[];

    // Everyone stopped (or the server turned it off): take the channel away once it's empty.
    for (const r of rows) {
      if (groups.get(`${r.server_id}\n${r.game}`)?.players.length) continue;
      if (!removeVoiceWhenEmpty(this.ctx, this.servers, this.uploads, r.voice_channel_id)) continue;
      db.prepare("DELETE FROM play_together_channels WHERE server_id = ? AND game = ?").run(r.server_id, r.game);
      if (r.voice_channel_id) this.forget(r.voice_channel_id);
    }

    for (const g of groups.values()) {
      const row = rows.find((r) => r.server_id === g.serverId && r.game === g.game);
      if (!row && g.players.length < 2) continue;
      if (row && (!g.players.length || row.voice_channel_id === null)) continue;
      const access = this.accessFor(g);
      let channel = row?.voice_channel_id ? this.servers.channelById(row.voice_channel_id) : undefined;
      if (row && !channel) {
        // A moderator deleted it: leave it be until everyone has stopped.
        db.prepare("UPDATE play_together_channels SET voice_channel_id = NULL WHERE server_id = ? AND game = ?").run(g.serverId, g.game);
        this.forget(row.voice_channel_id!);
        continue;
      }
      if (!access) continue;
      if (!channel) {
        channel = this.open(g, access);
        if (!channel) continue;
      } else if (this.access.get(channel.id) !== JSON.stringify(access)) {
        this.servers.updateChannel(g.serverId, channel.id, access.locked ? access : { locked: false, memberIds: [] });
        this.access.set(channel.id, JSON.stringify(access));
        this.ctx.serverChanged?.(g.serverId);
      }
      this.invite(g, channel, access);
    }
  }

  private open(g: Group, access: Access): Channel | undefined {
    let channel: Channel;
    try {
      channel = this.servers.createChannel(g.serverId, {
        name: playChannelName(g.title),
        kind: "voice",
        topic: `🎮 For playing ${g.title.slice(0, 120)} together. It goes when everyone's stopped.`,
        ...(access.locked ? access : {}),
      });
    } catch {
      return undefined; // Channel limit reached.
    }
    this.ctx.db
      .prepare(
        `INSERT INTO play_together_channels (server_id, game, voice_channel_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, game) DO UPDATE SET voice_channel_id = excluded.voice_channel_id`,
      )
      .run(g.serverId, g.game, channel.id, now());
    this.access.set(channel.id, JSON.stringify(access));
    this.ctx.serverChanged?.(g.serverId);
    return channel;
  }

  /** Asks players who haven't been asked yet (and aren't in it already) to join. */
  private invite(g: Group, channel: Channel, access: Access): void {
    const { gateway, family } = this.ctx;
    let asked = this.asked.get(channel.id);
    if (!asked) this.asked.set(channel.id, (asked = new Set()));
    // Someone who stopped and starts again is asked again.
    for (const id of asked) if (!g.players.includes(id)) asked.delete(id);
    const invite: PlayTogetherInvite = { serverId: g.serverId, channelId: channel.id, game: g.title, userIds: g.players };
    const inChannel = new Set(this.voiceMembers(channel.id));
    for (const id of g.players) {
      if (asked.has(id) || inChannel.has(id) || !gateway.isOnline(id)) continue;
      if (access.locked && !access.memberIds.includes(id)) continue;
      try {
        family.assertCanChat(id); // A kid whose chat time is over isn't asked.
      } catch {
        continue;
      }
      asked.add(id);
      gateway.send([id], { type: "play.together", invite });
    }
  }

  private voiceMembers(channelId: number): number[] {
    return this.ctx.voiceMembers?.(channelId) ?? [];
  }

  private forget(channelId: number): void {
    this.asked.delete(channelId);
    this.access.delete(channelId);
  }
}
