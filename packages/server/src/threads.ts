import { LIMITS, type PinnedMessage, type Thread } from "@dendrop/shared";
import type { ConversationRepo } from "./conversations.js";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { ServerRepo } from "./servers.js";

interface ThreadRow {
  id: number;
  channel_id: number;
  conversation_id: number;
  parent_message_id: number | null;
  title: string;
  tags: string;
  closed: number;
  created_by: number | null;
  created_at: string;
  server_id: number;
  channel_kind: string;
  channel_tags: string;
  last_message_at: string | null;
}

const SELECT = `SELECT t.*, c.server_id, c.kind AS channel_kind, c.tags AS channel_tags, v.last_message_at
  FROM channel_threads t JOIN server_channels c ON c.id = t.channel_id JOIN conversations v ON v.id = t.conversation_id`;

/** A thread title: one line of text. */
export function cleanTitle(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "A thread needs a title");
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) throw new HttpError(400, "A thread needs a title");
  if (s.length > LIMITS.threadTitle) throw new HttpError(400, `Titles can be up to ${LIMITS.threadTitle} characters`);
  return s;
}

/** A title made from the message a thread starts from: its first line, shortened. */
function titleFrom(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^<a?:[\w-]+:\d+>$/.test(l));
  if (!line) return "Thread";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * Threads off channel messages, forum posts, and the pinned board.
 *
 * A thread is a conversation of kind 'thread' whose members are always its channel's members
 * (ServerRepo.syncChannel keeps them in step), so the DM message, file, typing and read-marker
 * code guards threads too, and automod and timeouts follow the channel (see the
 * channel_conversations view).
 */
export class ThreadRepo {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerRepo,
    private readonly convos: ConversationRepo,
  ) {}

  private row(threadId: number): ThreadRow | undefined {
    return this.db.prepare(`${SELECT} WHERE t.id = ?`).get(threadId) as ThreadRow | undefined;
  }

  private rowFor(conversationId: number): ThreadRow | undefined {
    return this.db.prepare(`${SELECT} WHERE t.conversation_id = ?`).get(conversationId) as ThreadRow | undefined;
  }

  private toThread(r: ThreadRow): Thread {
    const first = this.db
      .prepare("SELECT body FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1")
      .get(r.conversation_id) as { body: string } | undefined;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND deleted_at IS NULL").get(r.conversation_id) as { n: number };
    const allowed = JSON.parse(r.channel_tags) as string[];
    return {
      id: r.id,
      serverId: r.server_id,
      channelId: r.channel_id,
      conversationId: r.conversation_id,
      title: r.title,
      parentMessageId: r.parent_message_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      closed: !!r.closed,
      // Tags the forum no longer has are left out.
      tags: (JSON.parse(r.tags) as string[]).filter((t) => allowed.includes(t)),
      messageCount: Number(n.n),
      lastMessageAt: r.last_message_at,
      preview: first ? first.body.slice(0, 200) : "",
    };
  }

  /** The thread a conversation is, if it is one. */
  forConversation(conversationId: number): Thread | undefined {
    const r = this.rowFor(conversationId);
    return r && this.toThread(r);
  }

  /** A thread someone can see, or a 404. */
  get(threadId: number, viewerId: number): Thread {
    const r = this.row(threadId);
    if (!r || !this.convos.isMember(r.conversation_id, viewerId)) throw new HttpError(404, "No such thread");
    return this.toThread(r);
  }

  /** Everyone who can see a thread (its channel's members). */
  memberIds(thread: Thread): number[] {
    return this.convos.memberIds(thread.conversationId);
  }

  /** A channel's threads, most recently active first. Open ones only unless `closed`. */
  list(serverId: number, channelId: number, viewerId: number, closed = false): Thread[] {
    const c = this.servers.channelById(channelId);
    if (!c || c.serverId !== serverId || !this.convos.isMember(c.conversationId, viewerId)) throw new HttpError(404, "No such channel");
    const rows = this.db
      .prepare(`${SELECT} WHERE t.channel_id = ? ${closed ? "" : "AND t.closed = 0"} ORDER BY COALESCE(v.last_message_at, t.created_at) DESC, t.id DESC LIMIT 200`)
      .all(channelId) as unknown as ThreadRow[];
    return rows.map((r) => this.toThread(r));
  }

  private insert(channelId: number, title: string, parentMessageId: number | null, by: number, tags: string[]): number {
    const c = this.servers.channelById(channelId)!;
    return tx(this.db, () => {
      const t = now();
      const conv = this.db.prepare("INSERT INTO conversations (is_group, kind, name, created_by, created_at) VALUES (1, 'thread', ?, ?, ?)").run(title, by, t);
      const cid = Number(conv.lastInsertRowid);
      const res = this.db
        .prepare("INSERT INTO channel_threads (channel_id, conversation_id, parent_message_id, title, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(channelId, cid, parentMessageId, title, JSON.stringify(tags), by, t);
      this.servers.syncMembers(cid, new Set(this.convos.memberIds(c.conversationId)));
      return Number(res.lastInsertRowid);
    });
  }

  /**
   * Starts a thread off a channel message, or returns the one it already has. Anyone who can see
   * the channel can. The title defaults to the start of the message.
   */
  startFromMessage(messageId: number, userId: number, title: unknown): { thread: Thread; created: boolean } {
    const m = this.convos.message(messageId);
    if (!m || !this.convos.isMember(m.conversationId, userId)) throw new HttpError(404, "No such message");
    const channel = this.servers.channelForConversation(m.conversationId);
    if (!channel) {
      if (this.rowFor(m.conversationId)) throw new HttpError(400, "Threads can't have threads; reply in this one instead");
      throw new HttpError(400, "Threads are for server channels");
    }
    const existing = this.db.prepare("SELECT id FROM channel_threads WHERE parent_message_id = ?").get(messageId) as { id: number } | undefined;
    if (existing) return { thread: this.toThread(this.row(existing.id)!), created: false };
    if (m.deleted) throw new HttpError(409, "That message was deleted");
    if (m.keyVersion) throw new HttpError(400, "Encrypted messages can't have threads");
    const name = title === undefined || title === null || title === "" ? titleFrom(m.body) : cleanTitle(title);
    const id = this.insert(channel.id, name, messageId, userId, []);
    return { thread: this.toThread(this.row(id)!), created: true };
  }

  /** Checks a forum post's tags against its forum's list. */
  private cleanPostTags(channelTags: string[], v: unknown): string[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new HttpError(400, "tags is a list of the forum's tags");
    const out = [...new Set(v)];
    for (const t of out) if (typeof t !== "string" || !channelTags.includes(t)) throw new HttpError(400, `This forum has no tag called ${String(t)}`);
    if (out.length > LIMITS.tagsPerPost) throw new HttpError(400, `A post can have up to ${LIMITS.tagsPerPost} tags`);
    return channelTags.filter((t) => out.includes(t));
  }

  /** Makes an empty forum post. The caller posts its first message (through automod). */
  createPost(serverId: number, channelId: number, userId: number, input: { title?: unknown; tags?: unknown }): Thread {
    const c = this.servers.channelById(channelId);
    if (!c || c.serverId !== serverId || !this.convos.isMember(c.conversationId, userId)) throw new HttpError(404, "No such channel");
    if (c.kind !== "forum") throw new HttpError(400, "Posts go in forum channels; start a thread from a message instead");
    const title = cleanTitle(input.title);
    const tags = this.cleanPostTags(c.tags, input.tags);
    return this.toThread(this.row(this.insert(c.id, title, null, userId, tags))!);
  }

  /** Removes a post whose first message didn't make it (automod blocked it, say). */
  discard(threadId: number): void {
    const r = this.row(threadId);
    if (r) this.db.prepare("DELETE FROM conversations WHERE id = ?").run(r.conversation_id);
  }

  /** Who runs a channel's threads: Manage channels, and on a stage its hosts (Manage events) too. */
  private canManage(r: ThreadRow, userId: number): boolean {
    return this.servers.can(r.server_id, userId, "manageChannels") || (r.channel_kind === "stage" && this.servers.can(r.server_id, userId, "manageEvents"));
  }

  /** Renames, closes or reopens, or retags a thread: its starter or someone who can manage channels. */
  update(threadId: number, userId: number, patch: { title?: unknown; closed?: unknown; tags?: unknown }): Thread {
    const r = this.row(threadId);
    if (!r || !this.convos.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such thread");
    if (r.created_by !== userId && !this.canManage(r, userId)) throw new HttpError(403, "Only whoever started it, or someone who can manage channels, can change a thread");
    const title = patch.title === undefined ? r.title : cleanTitle(patch.title);
    if (patch.closed !== undefined && typeof patch.closed !== "boolean") throw new HttpError(400, "closed is true or false");
    // A moderator's close sticks: the starter can't reopen it.
    if (patch.closed === false && r.closed && !this.canManage(r, userId)) throw new HttpError(403, "Only someone who can manage channels can reopen a thread");
    const closed = typeof patch.closed === "boolean" ? patch.closed : !!r.closed;
    if (patch.tags !== undefined && r.channel_kind !== "forum") throw new HttpError(400, "Only forum posts have tags");
    const tags = patch.tags === undefined ? r.tags : JSON.stringify(this.cleanPostTags(JSON.parse(r.channel_tags) as string[], patch.tags));
    tx(this.db, () => {
      this.db.prepare("UPDATE channel_threads SET title = ?, closed = ?, tags = ? WHERE id = ?").run(title, closed ? 1 : 0, tags, threadId);
      this.db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(title, r.conversation_id);
    });
    return this.toThread(this.row(threadId)!);
  }

  /** Deletes a thread and its messages (moderators). Returns it and the files to remove from disk. */
  delete(threadId: number, userId: number): { thread: Thread; files: string[]; memberIds: number[] } {
    const r = this.row(threadId);
    if (!r || !this.convos.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such thread");
    if (!this.canManage(r, userId) && !this.servers.can(r.server_id, userId, "deleteMessages")) {
      throw new HttpError(403, "You need Manage channels or Delete messages to delete a thread");
    }
    const thread = this.toThread(r);
    const memberIds = this.convos.memberIds(r.conversation_id);
    const files = tx(this.db, () => {
      const ids = (this.db.prepare("SELECT id FROM attachments WHERE conversation_id = ?").all(r.conversation_id) as { id: string }[]).map((a) => a.id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(r.conversation_id);
      return ids;
    });
    return { thread, files, memberIds };
  }

  /**
   * Why someone can't post in a conversation right now, or null: forum channels take posts, not
   * messages, and closed threads are read only except for people who can manage channels.
   */
  postBlocked(conversationId: number, userId: number): string | null {
    const c = this.servers.channelForConversation(conversationId);
    if (c?.kind === "forum") return "Forums hold posts: start a new post instead";
    const r = c ? undefined : this.rowFor(conversationId);
    if (r?.closed && !this.canManage(r, userId)) return "This thread is closed";
    return null;
  }

  // ---- The pinned board ---------------------------------------------------------------

  /** Where a message lives in a server: its channel, and its thread if it's in one. */
  private placeOf(messageId: number): { serverId: number; channelId: number; threadId: number | null; conversationId: number } | undefined {
    const r = this.db
      .prepare("SELECT v.server_id, v.channel_id, v.thread_id, v.conversation_id FROM messages m JOIN channel_conversations v ON v.conversation_id = m.conversation_id WHERE m.id = ?")
      .get(messageId) as { server_id: number; channel_id: number; thread_id: number | null; conversation_id: number } | undefined;
    return r && { serverId: r.server_id, channelId: r.channel_id, threadId: r.thread_id, conversationId: r.conversation_id };
  }

  /** Pins or unpins a message: people with Pin messages (and the owner and admins). */
  setPinned(messageId: number, userId: number, pinned: boolean): { serverId: number; channelId: number; conversationId: number } {
    const place = this.placeOf(messageId);
    if (!place || !this.convos.isMember(place.conversationId, userId)) throw new HttpError(404, "No such message");
    // Stage hosts (Manage events) can pin in their stage's chat, say the movie's link.
    const stageHost = this.servers.channelById(place.channelId)?.kind === "stage" && this.servers.can(place.serverId, userId, "manageEvents");
    if (!stageHost && !this.servers.can(place.serverId, userId, "pinMessages")) throw new HttpError(403, "You need Pin messages to do that");
    if (!pinned) {
      if (!Number(this.db.prepare("DELETE FROM message_pins WHERE message_id = ?").run(messageId).changes)) throw new HttpError(404, "That message isn't pinned");
      return place;
    }
    const m = this.convos.message(messageId)!;
    if (m.deleted) throw new HttpError(409, "That message was deleted");
    if (m.pinned) return place;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM message_pins WHERE conversation_id = ?").get(place.conversationId) as { n: number };
    if (Number(n.n) >= LIMITS.pinsPerChannel) throw new HttpError(400, `A channel or thread can have up to ${LIMITS.pinsPerChannel} pins; unpin one first`);
    this.db.prepare("INSERT INTO message_pins (message_id, conversation_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)").run(messageId, place.conversationId, userId, now());
    return place;
  }

  /**
   * A server's pinned board as one member sees it: pins in the channels and threads they can see,
   * newest first, optionally from one channel (and its threads) only.
   */
  board(serverId: number, viewerId: number, channelId?: number): PinnedMessage[] {
    if (!this.servers.role(serverId, viewerId)) throw new HttpError(404, "No such server");
    const rows = this.db
      .prepare(
        `SELECT p.message_id, p.pinned_by, p.pinned_at, v.channel_id, v.thread_id, t.title
         FROM message_pins p
         JOIN channel_conversations v ON v.conversation_id = p.conversation_id
         JOIN conversation_members cm ON cm.conversation_id = p.conversation_id AND cm.user_id = ?
         LEFT JOIN channel_threads t ON t.id = v.thread_id
         WHERE v.server_id = ? ${channelId ? "AND v.channel_id = ?" : ""}
         ORDER BY p.pinned_at DESC, p.message_id DESC LIMIT 500`,
      )
      .all(...[viewerId, serverId, ...(channelId ? [channelId] : [])]) as {
      message_id: number;
      pinned_by: number | null;
      pinned_at: string;
      channel_id: number;
      thread_id: number | null;
      title: string | null;
    }[];
    return rows.flatMap((r) => {
      const message = this.convos.message(r.message_id);
      if (!message) return [];
      return [{ message, channelId: r.channel_id, threadId: r.thread_id, threadTitle: r.title, pinnedBy: r.pinned_by, pinnedAt: r.pinned_at }];
    });
  }
}
