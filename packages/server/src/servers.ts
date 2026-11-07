import { randomBytes } from "node:crypto";
import {
  LIMITS,
  type AdminServer,
  type Channel,
  type ChatServer,
  type ChatServerSummary,
  type InvitePreview,
  type ServerCreatorRequest,
  type ServerInvite,
  type ServerMember,
  type ServerRole,
} from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import { toPublic, type UserRecord, type UserRepo } from "./users.js";

interface ServerRow {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  is_public: number;
  member_invites: number;
  play_together: number;
  icon_file: string | null;
  icon_type: string | null;
  banner_file: string | null;
  banner_type: string | null;
  created_at: string;
}

interface ChannelRow {
  id: number;
  server_id: number;
  conversation_id: number;
  kind: "text" | "voice";
  name: string;
  topic: string;
  position: number;
  locked: number;
  created_at: string;
}

interface InviteRow {
  code: string;
  server_id: number;
  created_by: number;
  for_user_id: number | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  created_at: string;
}

interface RequestRow {
  user_id: number;
  reason: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at: string | null;
}

export type ImageKind = "icon" | "banner";

const MODERATORS: ServerRole[] = ["owner", "admin"];
export const isModerator = (role: ServerRole | undefined): boolean => !!role && MODERATORS.includes(role);

function cleanText(v: unknown, max: number, what: string, allowEmpty: boolean): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} needs to be text`);
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!s && !allowEmpty) throw new HttpError(400, `${what} can't be empty`);
  if (s.length > max) throw new HttpError(400, `${what} can be up to ${max} characters`);
  return s;
}

/** Channel names are lowercase words joined with dashes, like "game-night". */
export function cleanChannelName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "A channel needs a name");
  const s = v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) throw new HttpError(400, "A channel needs a name");
  if (s.length > LIMITS.channelName) throw new HttpError(400, `Channel names can be up to ${LIMITS.channelName} characters`);
  return s;
}

/**
 * Chat servers, their members, channels and invites, and who may make servers.
 *
 * Each channel's messages live in a conversation of kind 'channel'. Its conversation_members rows
 * are exactly the people allowed to see the channel, kept in step by syncChannel, so the message,
 * file, typing and read-marker code written for DMs also guards channels.
 */
export class ServerRepo {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
  ) {}

  private depth = 0;

  /** A transaction that can be nested: inner calls join the outer one. */
  private atomic<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      return tx(this.db, fn);
    } finally {
      this.depth--;
    }
  }

  // ---- Reading ------------------------------------------------------------------

  private row(serverId: number): ServerRow | undefined {
    return this.db.prepare("SELECT * FROM servers WHERE id = ?").get(serverId) as ServerRow | undefined;
  }

  exists(serverId: number): boolean {
    return !!this.row(serverId);
  }

  role(serverId: number, userId: number): ServerRole | undefined {
    const r = this.db.prepare("SELECT role FROM server_members WHERE server_id = ? AND user_id = ?").get(serverId, userId) as
      | { role: ServerRole }
      | undefined;
    return r?.role;
  }

  memberIds(serverId: number): number[] {
    return (this.db.prepare("SELECT user_id FROM server_members WHERE server_id = ? ORDER BY user_id").all(serverId) as { user_id: number }[]).map(
      (r) => r.user_id,
    );
  }

  isPublic(serverId: number): boolean {
    return !!this.row(serverId)?.is_public;
  }

  private memberCount(serverId: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?").get(serverId) as { n: number }).n);
  }

  private summaryOf(r: ServerRow): ChatServerSummary {
    const image = (file: string | null) => (file ? `/api/servers/${r.id}/images/${file}` : null);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      iconUrl: image(r.icon_file),
      bannerUrl: image(r.banner_file),
      isPublic: !!r.is_public,
      memberCount: this.memberCount(r.id),
    };
  }

  summary(serverId: number): ChatServerSummary | undefined {
    const r = this.row(serverId);
    return r && this.summaryOf(r);
  }

  private channelRows(serverId: number): ChannelRow[] {
    return this.db.prepare("SELECT * FROM server_channels WHERE server_id = ? ORDER BY position, id").all(serverId) as unknown as ChannelRow[];
  }

  private channelRow(channelId: number): ChannelRow | undefined {
    return this.db.prepare("SELECT * FROM server_channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  }

  private access(channelId: number): number[] {
    return (this.db.prepare("SELECT user_id FROM channel_access WHERE channel_id = ? ORDER BY user_id").all(channelId) as { user_id: number }[]).map(
      (r) => r.user_id,
    );
  }

  /** Whether someone can see a channel: any member for an open one; picked people and moderators for a locked one. */
  private canSee(c: ChannelRow, userId: number, role = this.role(c.server_id, userId)): boolean {
    if (!role) return false;
    if (!c.locked || isModerator(role)) return true;
    return !!this.db.prepare("SELECT 1 FROM channel_access WHERE channel_id = ? AND user_id = ?").get(c.id, userId);
  }

  private toChannel(c: ChannelRow, showAccess: boolean): Channel {
    return {
      id: c.id,
      serverId: c.server_id,
      kind: c.kind === "voice" ? "voice" : "text",
      conversationId: c.conversation_id,
      name: c.name,
      topic: c.topic,
      position: c.position,
      locked: !!c.locked,
      memberIds: c.locked && showAccess ? this.access(c.id) : [],
    };
  }

  /** The channel a conversation belongs to, if it's a channel. */
  channelForConversation(conversationId: number): Channel | undefined {
    const c = this.db.prepare("SELECT * FROM server_channels WHERE conversation_id = ?").get(conversationId) as ChannelRow | undefined;
    return c && this.toChannel(c, false);
  }

  /** A channel by id, wherever it is, or undefined. */
  channelById(channelId: number): Channel | undefined {
    const c = this.channelRow(channelId);
    return c && this.toChannel(c, false);
  }

  isChannelConversation(conversationId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM conversations WHERE id = ? AND kind = 'channel'").get(conversationId);
  }

  members(serverId: number): ServerMember[] {
    const rows = this.db
      .prepare("SELECT user_id, role, nickname, joined_at FROM server_members WHERE server_id = ? ORDER BY joined_at, user_id")
      .all(serverId) as { user_id: number; role: ServerRole; nickname: string | null; joined_at: string }[];
    return rows.flatMap((r) => {
      const u = this.users.byId(r.user_id);
      return u ? [{ user: toPublic(u), role: r.role, nickname: r.nickname, joinedAt: r.joined_at }] : [];
    });
  }

  /** A server as one member sees it, or undefined if they aren't in it. */
  view(serverId: number, viewerId: number): ChatServer | undefined {
    const r = this.row(serverId);
    const role = r && this.role(serverId, viewerId);
    if (!r || !role) return undefined;
    const me = this.db.prepare("SELECT nickname FROM server_members WHERE server_id = ? AND user_id = ?").get(serverId, viewerId) as {
      nickname: string | null;
    };
    const mod = isModerator(role);
    return {
      ...this.summaryOf(r),
      ownerId: r.owner_id,
      myRole: role,
      nickname: me.nickname,
      memberInvites: !!r.member_invites,
      playTogether: !!r.play_together,
      channels: this.channelRows(serverId)
        .filter((c) => this.canSee(c, viewerId, role))
        .map((c) => this.toChannel(c, mod)),
      members: this.members(serverId),
      createdAt: r.created_at,
      timedOutUntil: this.timedOutUntil(serverId, viewerId),
    };
  }

  /** When someone's timeout here ends (automod.ts sets them), or null. */
  timedOutUntil(serverId: number, userId: number): string | null {
    const r = this.db.prepare("SELECT until FROM server_timeouts WHERE server_id = ? AND user_id = ? AND until > ?").get(serverId, userId, now()) as
      | { until: string }
      | undefined;
    return r?.until ?? null;
  }

  /** Servers someone is in, oldest join first. */
  list(userId: number): ChatServer[] {
    const ids = this.db.prepare("SELECT server_id FROM server_members WHERE user_id = ? ORDER BY joined_at, server_id").all(userId) as {
      server_id: number;
    }[];
    return ids.flatMap((r) => this.view(r.server_id, userId) ?? []);
  }

  /** Public servers, biggest first. Private servers are never listed. */
  directory(query: unknown): ChatServerSummary[] {
    const q = typeof query === "string" ? query.trim().slice(0, 64) : "";
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS n FROM servers s
         WHERE s.is_public = 1 AND (s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')
         ORDER BY n DESC, s.id LIMIT 100`,
      )
      .all(like, like) as unknown as ServerRow[];
    return rows.map((r) => this.summaryOf(r));
  }

  /** Every server, for super admins. Names and counts only: never channels' contents. */
  adminList(): AdminServer[] {
    const rows = this.db.prepare("SELECT * FROM servers ORDER BY id").all() as unknown as ServerRow[];
    return rows.map((r) => {
      const owner = this.users.byId(r.owner_id);
      return {
        ...this.summaryOf(r),
        owner: owner ? toPublic(owner) : null,
        channelCount: this.channelRows(r.id).length,
        createdAt: r.created_at,
      };
    });
  }

  image(serverId: number, file: string): { type: string } | undefined {
    const r = this.row(serverId);
    if (!r) return undefined;
    if (r.icon_file === file && r.icon_type) return { type: r.icon_type };
    if (r.banner_file === file && r.banner_type) return { type: r.banner_type };
    return undefined;
  }

  // ---- Making and changing servers -------------------------------------------------

  canCreate(user: UserRecord): boolean {
    return user.isSuperAdmin || user.canCreateServers;
  }

  private checkServerCount(userId: number): void {
    const n = Number((this.db.prepare("SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?").get(userId) as { n: number }).n);
    if (n >= LIMITS.serversPerUser) throw new HttpError(400, `You can be in up to ${LIMITS.serversPerUser} servers`);
  }

  create(owner: UserRecord, input: { name?: unknown; description?: unknown; isPublic?: unknown }): number {
    if (!this.canCreate(owner)) throw new HttpError(403, "You need a super admin's approval to make servers");
    const name = cleanText(input.name, LIMITS.serverName, "The server name", false);
    const description = input.description === undefined ? "" : cleanText(input.description, LIMITS.serverDescription, "The description", true);
    this.checkServerCount(owner.id);
    return this.atomic(() => {
      const t = now();
      const res = this.db
        .prepare("INSERT INTO servers (name, description, owner_id, is_public, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(name, description, owner.id, input.isPublic === true ? 1 : 0, t);
      const sid = Number(res.lastInsertRowid);
      this.db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(sid, owner.id, t);
      this.insertChannel(sid, "general", "", false, []);
      return sid;
    });
  }

  update(serverId: number, patch: { name?: unknown; description?: unknown; isPublic?: unknown; memberInvites?: unknown; playTogether?: unknown }): void {
    if (patch.name !== undefined) {
      this.db.prepare("UPDATE servers SET name = ? WHERE id = ?").run(cleanText(patch.name, LIMITS.serverName, "The server name", false), serverId);
    }
    if (patch.description !== undefined) {
      const d = cleanText(patch.description, LIMITS.serverDescription, "The description", true);
      this.db.prepare("UPDATE servers SET description = ? WHERE id = ?").run(d, serverId);
    }
    if (typeof patch.isPublic === "boolean") this.db.prepare("UPDATE servers SET is_public = ? WHERE id = ?").run(patch.isPublic ? 1 : 0, serverId);
    if (typeof patch.memberInvites === "boolean") {
      this.db.prepare("UPDATE servers SET member_invites = ? WHERE id = ?").run(patch.memberInvites ? 1 : 0, serverId);
    }
    if (typeof patch.playTogether === "boolean") {
      this.db.prepare("UPDATE servers SET play_together = ? WHERE id = ?").run(patch.playTogether ? 1 : 0, serverId);
    }
  }

  /** Sets or clears the icon or banner. Returns the old file, to remove from disk. */
  setImage(serverId: number, kind: ImageKind, file: string | null, type: string | null): string | null {
    const old = this.row(serverId)?.[`${kind}_file`] ?? null;
    this.db.prepare(`UPDATE servers SET ${kind}_file = ?, ${kind}_type = ? WHERE id = ?`).run(file, type, serverId);
    return old;
  }

  /** Deletes a server and all its channels. Returns the files to remove from disk. */
  delete(serverId: number): string[] {
    const r = this.row(serverId);
    if (!r) throw new HttpError(404, "No such server");
    return this.atomic(() => {
      const convs = this.channelRows(serverId).map((c) => c.conversation_id);
      const files: string[] = [];
      for (const cid of convs) {
        for (const a of this.db.prepare("SELECT id FROM attachments WHERE conversation_id = ?").all(cid) as { id: string }[]) files.push(a.id);
        this.db.prepare("DELETE FROM conversations WHERE id = ?").run(cid);
      }
      this.db.prepare("DELETE FROM servers WHERE id = ?").run(serverId);
      if (r.icon_file) files.push(r.icon_file);
      if (r.banner_file) files.push(r.banner_file);
      return files;
    });
  }

  // ---- Members -------------------------------------------------------------------

  isBanned(serverId: number, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?").get(serverId, userId);
  }

  /** Adds someone to a server (the caller checks they may join). */
  addMember(serverId: number, userId: number): void {
    if (this.role(serverId, userId)) return;
    if (this.isBanned(serverId, userId)) throw new HttpError(403, "You can't join this server");
    this.checkServerCount(userId);
    this.atomic(() => {
      this.db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(serverId, userId, now());
      this.syncServer(serverId);
    });
  }

  removeMember(serverId: number, userId: number, ban: { by: number } | null = null): void {
    this.atomic(() => {
      this.db.prepare("DELETE FROM server_members WHERE server_id = ? AND user_id = ?").run(serverId, userId);
      this.db
        .prepare("DELETE FROM channel_access WHERE user_id = ? AND channel_id IN (SELECT id FROM server_channels WHERE server_id = ?)")
        .run(userId, serverId);
      // Invites they made stop working when they go.
      this.db.prepare("DELETE FROM server_invites WHERE server_id = ? AND (created_by = ? OR for_user_id = ?)").run(serverId, userId, userId);
      if (ban) this.db.prepare("INSERT OR IGNORE INTO server_bans (server_id, user_id, banned_by, created_at) VALUES (?, ?, ?, ?)").run(serverId, userId, ban.by, now());
      this.syncServer(serverId);
    });
  }

  bans(serverId: number): { user: ReturnType<typeof toPublic>; createdAt: string }[] {
    const rows = this.db.prepare("SELECT user_id, created_at FROM server_bans WHERE server_id = ? ORDER BY created_at").all(serverId) as {
      user_id: number;
      created_at: string;
    }[];
    return rows.flatMap((r) => {
      const u = this.users.byId(r.user_id);
      return u ? [{ user: toPublic(u), createdAt: r.created_at }] : [];
    });
  }

  unban(serverId: number, userId: number): boolean {
    return Number(this.db.prepare("DELETE FROM server_bans WHERE server_id = ? AND user_id = ?").run(serverId, userId).changes) > 0;
  }

  setRole(serverId: number, userId: number, role: unknown): void {
    if (role !== "admin" && role !== "member") throw new HttpError(400, "role is admin or member");
    const current = this.role(serverId, userId);
    if (!current) throw new HttpError(404, "They aren't in this server");
    if (current === "owner") throw new HttpError(400, "Transfer ownership instead");
    if (role === "admin" && this.users.byId(userId)?.isBot) throw new HttpError(400, "Bots can't be admins");
    this.atomic(() => {
      this.db.prepare("UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?").run(role, serverId, userId);
      this.syncServer(serverId);
    });
  }

  /** Hands the server to another member. The old owner becomes an admin. */
  transfer(serverId: number, from: number, to: number): void {
    if (from === to) return;
    if (!this.role(serverId, to)) throw new HttpError(404, "They aren't in this server");
    if (this.users.byId(to)?.isBot) throw new HttpError(400, "A bot can't own a server");
    this.atomic(() => {
      this.db.prepare("UPDATE server_members SET role = 'admin' WHERE server_id = ? AND user_id = ?").run(serverId, from);
      this.db.prepare("UPDATE server_members SET role = 'owner' WHERE server_id = ? AND user_id = ?").run(serverId, to);
      this.db.prepare("UPDATE servers SET owner_id = ? WHERE id = ?").run(to, serverId);
      this.syncServer(serverId);
    });
  }

  setNickname(serverId: number, userId: number, nickname: unknown): void {
    const nick = nickname === null ? "" : cleanText(nickname, LIMITS.displayNameLength, "The nickname", true);
    this.db.prepare("UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?").run(nick || null, serverId, userId);
  }

  // ---- Channels ------------------------------------------------------------------

  private cleanAccess(serverId: number, ids: unknown): number[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids)) throw new HttpError(400, "memberIds is a list of user ids");
    const members = new Set(this.memberIds(serverId));
    const out = [...new Set(ids.map(Number))];
    for (const id of out) if (!members.has(id)) throw new HttpError(400, "Only server members can be picked for a channel");
    return out;
  }

  private insertChannel(serverId: number, name: string, topic: string, locked: boolean, access: number[], kind: "text" | "voice" = "text"): number {
    const t = now();
    const conv = this.db.prepare("INSERT INTO conversations (is_group, kind, name, created_at) VALUES (1, 'channel', ?, ?)").run(name, t);
    const pos = this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM server_channels WHERE server_id = ?").get(serverId) as { p: number };
    const res = this.db
      .prepare("INSERT INTO server_channels (server_id, conversation_id, kind, name, topic, position, locked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(serverId, Number(conv.lastInsertRowid), kind, name, topic, pos.p, locked ? 1 : 0, t);
    const id = Number(res.lastInsertRowid);
    const add = this.db.prepare("INSERT INTO channel_access (channel_id, user_id) VALUES (?, ?)");
    for (const u of access) add.run(id, u);
    this.syncChannel(id);
    return id;
  }

  createChannel(serverId: number, input: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown; kind?: unknown }): Channel {
    if (this.channelRows(serverId).length >= LIMITS.channelsPerServer) {
      throw new HttpError(400, `A server can have up to ${LIMITS.channelsPerServer} channels`);
    }
    const name = cleanChannelName(input.name);
    const topic = input.topic === undefined ? "" : cleanText(input.topic, LIMITS.channelTopic, "The topic", true);
    if (input.kind !== undefined && input.kind !== "text" && input.kind !== "voice") throw new HttpError(400, "A channel is text or voice");
    const access = this.cleanAccess(serverId, input.memberIds);
    const id = this.atomic(() => this.insertChannel(serverId, name, topic, input.locked === true, access, input.kind === "voice" ? "voice" : "text"));
    return this.toChannel(this.channelRow(id)!, true);
  }

  /** A channel of this server, or a 404. */
  channel(serverId: number, channelId: number): ChannelRow {
    const c = this.channelRow(channelId);
    if (!c || c.server_id !== serverId) throw new HttpError(404, "No such channel");
    return c;
  }

  updateChannel(serverId: number, channelId: number, patch: { name?: unknown; topic?: unknown; locked?: unknown; memberIds?: unknown }): void {
    const c = this.channel(serverId, channelId);
    const name = patch.name === undefined ? c.name : cleanChannelName(patch.name);
    const topic = patch.topic === undefined ? c.topic : cleanText(patch.topic, LIMITS.channelTopic, "The topic", true);
    const locked = typeof patch.locked === "boolean" ? patch.locked : !!c.locked;
    const access = patch.memberIds === undefined ? undefined : this.cleanAccess(serverId, patch.memberIds);
    this.atomic(() => {
      this.db.prepare("UPDATE server_channels SET name = ?, topic = ?, locked = ? WHERE id = ?").run(name, topic, locked ? 1 : 0, channelId);
      this.db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(name, c.conversation_id);
      if (access) {
        this.db.prepare("DELETE FROM channel_access WHERE channel_id = ?").run(channelId);
        const add = this.db.prepare("INSERT INTO channel_access (channel_id, user_id) VALUES (?, ?)");
        for (const u of access) add.run(channelId, u);
      }
      this.syncChannel(channelId);
    });
  }

  /** Puts the channels in this order. Every channel has to be listed once. */
  reorderChannels(serverId: number, ids: unknown): void {
    const current = this.channelRows(serverId).map((c) => c.id);
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids.map(Number)).size !== current.length || !ids.every((i) => current.includes(Number(i)))) {
      throw new HttpError(400, "List every channel once, in the new order");
    }
    this.atomic(() => {
      const set = this.db.prepare("UPDATE server_channels SET position = ? WHERE id = ?");
      ids.forEach((id, i) => set.run(i, Number(id)));
    });
  }

  /** Deletes a channel and its messages. Returns the files to remove from disk. */
  deleteChannel(serverId: number, channelId: number): string[] {
    const c = this.channel(serverId, channelId);
    return this.atomic(() => {
      const files = (this.db.prepare("SELECT id FROM attachments WHERE conversation_id = ?").all(c.conversation_id) as { id: string }[]).map((a) => a.id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(c.conversation_id);
      return files;
    });
  }

  /** The server a channel conversation's message belongs to, for moderation. */
  serverOfMessage(messageId: number): number | undefined {
    const r = this.db
      .prepare("SELECT c.server_id FROM messages m JOIN server_channels c ON c.conversation_id = m.conversation_id WHERE m.id = ?")
      .get(messageId) as { server_id: number } | undefined;
    return r?.server_id;
  }

  /** Makes a channel's conversation members match who can see it. Keeps read markers of those who stay. */
  private syncChannel(channelId: number): void {
    const c = this.channelRow(channelId)!;
    const want = new Set(this.memberIds(c.server_id).filter((u) => this.canSee(c, u)));
    const have = new Set(
      (this.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?").all(c.conversation_id) as { user_id: number }[]).map(
        (r) => r.user_id,
      ),
    );
    const del = this.db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?");
    for (const u of have) if (!want.has(u)) del.run(c.conversation_id, u);
    const add = this.db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)");
    const t = now();
    for (const u of want) if (!have.has(u)) add.run(c.conversation_id, u, t);
  }

  private syncServer(serverId: number): void {
    for (const c of this.channelRows(serverId)) this.syncChannel(c.id);
  }

  // ---- Invites -------------------------------------------------------------------

  private toInvite(r: InviteRow): ServerInvite {
    return {
      code: r.code,
      serverId: r.server_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      uses: r.uses,
      forUserId: r.for_user_id,
    };
  }

  private inviteRow(code: string): InviteRow | undefined {
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(code)) return undefined;
    return this.db.prepare("SELECT * FROM server_invites WHERE code = ?").get(code) as InviteRow | undefined;
  }

  /** Whether someone may make invites to this server. */
  canInvite(serverId: number, userId: number): boolean {
    const role = this.role(serverId, userId);
    return isModerator(role) || (!!role && !!this.row(serverId)?.member_invites);
  }

  createInvite(serverId: number, by: number, input: { maxUses?: unknown; expiresInHours?: unknown }, forUserId: number | null = null): ServerInvite {
    const maxUses = input.maxUses === undefined || input.maxUses === null ? null : Number(input.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) throw new HttpError(400, "maxUses is 1 to 1000, or null");
    const hours = input.expiresInHours === undefined ? 24 * 7 : input.expiresInHours === null ? null : Number(input.expiresInHours);
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) throw new HttpError(400, "expiresInHours is up to a year, or null");
    const code = randomBytes(9).toString("base64url");
    const expires = hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString();
    this.db
      .prepare("INSERT INTO server_invites (code, server_id, created_by, for_user_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(code, serverId, by, forUserId, maxUses, expires, now());
    return this.toInvite(this.inviteRow(code)!);
  }

  /** An invite for one friend. Reuses one that's still waiting. */
  inviteFriend(serverId: number, by: number, userId: number): { invite: ServerInvite; isNew: boolean } {
    if (this.role(serverId, userId)) throw new HttpError(409, "They're already in this server");
    if (this.isBanned(serverId, userId)) throw new HttpError(403, "They're banned from this server");
    const existing = this.db
      .prepare("SELECT * FROM server_invites WHERE server_id = ? AND for_user_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(serverId, userId, now()) as InviteRow | undefined;
    if (existing) return { invite: this.toInvite(existing), isNew: false };
    return { invite: this.createInvite(serverId, by, { maxUses: 1, expiresInHours: 24 * 30 }, userId), isNew: true };
  }

  /** A server's invites: all of them for moderators, your own for everyone else. Friend invites aren't links, so they're left out. */
  invites(serverId: number, viewerId: number): ServerInvite[] {
    this.pruneInvites();
    const mod = isModerator(this.role(serverId, viewerId));
    const rows = (
      mod
        ? this.db.prepare("SELECT * FROM server_invites WHERE server_id = ? AND for_user_id IS NULL ORDER BY created_at").all(serverId)
        : this.db.prepare("SELECT * FROM server_invites WHERE server_id = ? AND for_user_id IS NULL AND created_by = ? ORDER BY created_at").all(serverId, viewerId)
    ) as unknown as InviteRow[];
    return rows.map((r) => this.toInvite(r));
  }

  private pruneInvites(): void {
    this.db.prepare("DELETE FROM server_invites WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now());
  }

  /** The invite if it can still be used by this person, else undefined (a friend invite is private to its friend). */
  private usable(code: string, userId: number): InviteRow | undefined {
    const r = this.inviteRow(code);
    if (!r) return undefined;
    if (r.expires_at && r.expires_at <= now()) return undefined;
    if (r.max_uses !== null && r.uses >= r.max_uses) return undefined;
    if (r.for_user_id !== null && r.for_user_id !== userId) return undefined;
    return r;
  }

  preview(code: string, viewerId: number): InvitePreview | undefined {
    const r = this.usable(code, viewerId);
    const server = r && this.summary(r.server_id);
    if (!r || !server) return undefined;
    const by = this.users.byId(r.created_by);
    return { code: r.code, server, invitedBy: by ? toPublic(by) : null, expiresAt: r.expires_at, joined: !!this.role(r.server_id, viewerId) };
  }

  /** Joins through an invite. Returns the server id. */
  accept(code: string, userId: number): number {
    return this.atomic(() => {
      const r = this.usable(code, userId);
      if (!r) throw new HttpError(404, "That invite has expired or doesn't exist");
      if (this.role(r.server_id, userId)) return r.server_id;
      this.addMember(r.server_id, userId);
      if (r.for_user_id !== null) this.db.prepare("DELETE FROM server_invites WHERE code = ?").run(code);
      else this.db.prepare("UPDATE server_invites SET uses = uses + 1 WHERE code = ?").run(code);
      return r.server_id;
    });
  }

  /** Friend invites waiting for someone. */
  pendingFor(userId: number): InvitePreview[] {
    this.pruneInvites();
    const codes = this.db.prepare("SELECT code FROM server_invites WHERE for_user_id = ? ORDER BY created_at DESC").all(userId) as { code: string }[];
    return codes.flatMap((c) => this.preview(c.code, userId) ?? []);
  }

  /** Revokes a link (its maker or a moderator), or declines a friend invite (its friend). */
  deleteInvite(code: string, userId: number): number {
    const r = this.inviteRow(code);
    if (!r) throw new HttpError(404, "No such invite");
    const allowed = r.created_by === userId || r.for_user_id === userId || isModerator(this.role(r.server_id, userId));
    if (!allowed) throw new HttpError(404, "No such invite");
    this.db.prepare("DELETE FROM server_invites WHERE code = ?").run(code);
    return r.server_id;
  }

  // ---- Permission to make servers ---------------------------------------------------

  private toRequest(r: RequestRow): ServerCreatorRequest | undefined {
    const u = this.users.byId(r.user_id);
    return u && { user: toPublic(u), reason: r.reason, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at };
  }

  creatorRequest(userId: number): ServerCreatorRequest | null {
    const r = this.db.prepare("SELECT * FROM server_creator_requests WHERE user_id = ?").get(userId) as RequestRow | undefined;
    return (r && this.toRequest(r)) ?? null;
  }

  /** Asks to make servers. Asking again after a denial reopens the request. */
  requestCreator(user: UserRecord, reason: unknown): ServerCreatorRequest {
    if (this.canCreate(user)) throw new HttpError(409, "You can already make servers");
    const text = reason === undefined ? "" : cleanText(reason, 500, "The reason", true);
    this.db
      .prepare(
        `INSERT INTO server_creator_requests (user_id, reason, status, created_at) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, status = 'pending', created_at = excluded.created_at, decided_at = NULL, decided_by = NULL`,
      )
      .run(user.id, text, now());
    return this.creatorRequest(user.id)!;
  }

  creatorRequests(): ServerCreatorRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM server_creator_requests ORDER BY status = 'pending' DESC, created_at DESC LIMIT 200")
      .all() as unknown as RequestRow[];
    return rows.flatMap((r) => this.toRequest(r) ?? []);
  }

  /** A super admin allows or stops someone making servers. Works with or without a request. */
  decideCreator(userId: number, allowed: boolean, by: number): ServerCreatorRequest {
    if (!this.users.byId(userId)) throw new HttpError(404, "No such user");
    this.atomic(() => {
      this.users.setCanCreateServers(userId, allowed);
      const t = now();
      this.db
        .prepare(
          `INSERT INTO server_creator_requests (user_id, reason, status, created_at, decided_at, decided_by) VALUES (?, '', ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
        )
        .run(userId, allowed ? "approved" : "denied", t, t, by);
    });
    return this.creatorRequest(userId)!;
  }
}
