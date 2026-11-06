import { LIMITS, type Attachment, type Conversation, type Message, type ReadState } from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { FriendRepo } from "./friends.js";
import { toPublic, type UserRepo } from "./users.js";


interface ConversationRow {
  id: number;
  is_group: number;
  name: string | null;
  created_at: string;
  last_message_at: string | null;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  author_id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: number;
  name: string;
  size: number;
  content_type: string;
}

/** A file received for a new message, already written to the uploads folder under `id`. */
export interface NewAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

const toAttachment = (a: AttachmentRow): Attachment => ({
  id: a.id,
  name: a.name,
  size: a.size,
  contentType: a.content_type,
  url: `/api/attachments/${a.id}/${encodeURIComponent(a.name)}`,
});

export function cleanBody(body: unknown, allowEmpty = false): string {
  if (body === undefined && allowEmpty) return "";
  if (typeof body !== "string") throw new HttpError(400, "A message needs text");
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text && !allowEmpty) throw new HttpError(400, "A message needs text");
  if (text.length > LIMITS.messageLength) throw new HttpError(400, `Messages can be up to ${LIMITS.messageLength} characters`);
  return text;
}

export class ConversationRepo {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly friends: FriendRepo,
  ) {}

  memberIds(conversationId: number): number[] {
    return (this.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id").all(conversationId) as {
      user_id: number;
    }[]).map((r) => r.user_id);
  }

  isMember(conversationId: number, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?").get(conversationId, userId);
  }

  /**
   * Who has read how far. People with read receipts off share nothing, and see nothing:
   * pass the viewer to apply that.
   */
  reads(conversationId: number, viewerId?: number): ReadState[] {
    if (viewerId !== undefined && !this.users.byId(viewerId)?.readReceipts) return [];
    const rows = this.db
      .prepare(
        `SELECT m.user_id, m.last_read_message_id FROM conversation_members m JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = ? AND u.read_receipts = 1`,
      )
      .all(conversationId) as { user_id: number; last_read_message_id: number | null }[];
    return rows.map((r) => ({ userId: r.user_id, messageId: r.last_read_message_id }));
  }

  get(conversationId: number, viewerId?: number): Conversation | undefined {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
    if (!r) return undefined;
    return {
      reads: this.reads(r.id, viewerId),
      id: r.id,
      isGroup: !!r.is_group,
      name: r.name,
      members: this.memberIds(r.id).flatMap((id) => {
        const u = this.users.byId(id);
        return u ? [toPublic(u)] : [];
      }),
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
    };
  }

  /** Conversations `userId` is in, most recently active first. */
  list(userId: number): Conversation[] {
    const ids = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      )
      .all(userId) as { id: number }[];
    return ids.map((r) => this.get(r.id, userId)!).filter(Boolean);
  }

  /** The 1:1 conversation between two friends, made the first time it's needed. */
  openDm(me: number, other: number): { conversation: Conversation; created: boolean } {
    if (me === other) throw new HttpError(400, "You can't message yourself");
    if (!this.friends.areFriends(me, other)) throw new HttpError(403, "You can only message friends");
    const key = me < other ? `${me}:${other}` : `${other}:${me}`;
    const existing = this.db.prepare("SELECT id FROM conversations WHERE dm_key = ?").get(key) as { id: number } | undefined;
    if (existing) return { conversation: this.get(existing.id, me)!, created: false };
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db.prepare("INSERT INTO conversations (is_group, dm_key, created_by, created_at) VALUES (0, ?, ?, ?)").run(key, me, t);
      const cid = Number(res.lastInsertRowid);
      const add = this.db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)");
      add.run(cid, me, t);
      add.run(cid, other, t);
      return cid;
    });
    return { conversation: this.get(id, me)!, created: true };
  }

  /** A group DM with some of the creator's friends. */
  createGroup(me: number, memberIds: number[], name?: string | null): Conversation {
    const others = [...new Set(memberIds.map(Number))].filter((id) => id !== me);
    if (others.length < 1) throw new HttpError(400, "Pick at least one friend");
    if (others.length + 1 > LIMITS.groupMembers) throw new HttpError(400, `Group chats can have up to ${LIMITS.groupMembers} people`);
    for (const id of others) if (!this.friends.areFriends(me, id)) throw new HttpError(403, "You can only add friends to a group chat");
    const cleanName = typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : null;
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db.prepare("INSERT INTO conversations (is_group, name, created_by, created_at) VALUES (1, ?, ?, ?)").run(cleanName, me, t);
      const cid = Number(res.lastInsertRowid);
      const add = this.db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)");
      for (const uid of [me, ...others]) add.run(cid, uid, t);
      return cid;
    });
    return this.get(id, me)!;
  }

  /** Messages, newest page first, returned oldest to newest. `before` pages further back. */
  messages(conversationId: number, before?: number, limit: number = LIMITS.pageSize): Message[] {
    const n = Math.max(1, Math.min(limit, 100));
    const rows = (
      before
        ? this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(conversationId, before, n)
        : this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, n)
    ) as unknown as MessageRow[];
    return this.withAttachments(rows.reverse());
  }

  private withAttachments(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const files = this.db
      .prepare(`SELECT * FROM attachments WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`)
      .all(...ids) as unknown as AttachmentRow[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      authorId: r.author_id,
      body: r.deleted_at ? "" : r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted: !!r.deleted_at,
      attachments: r.deleted_at ? [] : files.filter((f) => f.message_id === r.id).map(toAttachment),
    }));
  }

  message(id: number): Message | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    return r && this.withAttachments([r])[0];
  }

  /** The stored file for a download, if `userId` is in its conversation. */
  attachment(id: string, userId: number): (Attachment & { messageId: number }) | undefined {
    const a = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as (AttachmentRow & { conversation_id: number }) | undefined;
    if (!a || !this.isMember(a.conversation_id, userId)) return undefined;
    return { ...toAttachment(a), messageId: a.message_id };
  }

  send(conversationId: number, authorId: number, body: unknown, files: NewAttachment[] = []): Message {
    if (files.length > LIMITS.attachmentsPerMessage) throw new HttpError(400, `Up to ${LIMITS.attachmentsPerMessage} files per message`);
    const text = cleanBody(body, files.length > 0);
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db
        .prepare("INSERT INTO messages (conversation_id, author_id, body, created_at) VALUES (?, ?, ?, ?)")
        .run(conversationId, authorId, text, t);
      const mid = Number(res.lastInsertRowid);
      const add = this.db.prepare(
        "INSERT INTO attachments (id, message_id, conversation_id, name, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const f of files) add.run(f.id, mid, conversationId, f.name, f.size, f.contentType, t);
      this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(t, conversationId);
      // Sending counts as reading everything up to here.
      this.db.prepare("UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?").run(mid, conversationId, authorId);
      return mid;
    });
    return this.message(id)!;
  }

  /** Moves someone's read marker forward (never back). Returns the new marker if it moved. */
  markRead(conversationId: number, userId: number, messageId: number): number | null {
    const msg = this.db.prepare("SELECT id FROM messages WHERE id = ? AND conversation_id = ?").get(messageId, conversationId);
    if (!msg) throw new HttpError(404, "No such message");
    const res = this.db
      .prepare(
        `UPDATE conversation_members SET last_read_message_id = ?
         WHERE conversation_id = ? AND user_id = ? AND (last_read_message_id IS NULL OR last_read_message_id < ?)`,
      )
      .run(messageId, conversationId, userId, messageId);
    return Number(res.changes) > 0 ? messageId : null;
  }

  private own(messageId: number, userId: number): MessageRow {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!r || !this.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such message");
    if (r.author_id !== userId) throw new HttpError(403, "You can only change your own messages");
    if (r.deleted_at) throw new HttpError(409, "That message was deleted");
    return r;
  }

  edit(messageId: number, userId: number, body: unknown): Message {
    this.own(messageId, userId);
    const hasFiles = !!this.db.prepare("SELECT 1 FROM attachments WHERE message_id = ?").get(messageId);
    this.db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(cleanBody(body, hasFiles), now(), messageId);
    return this.message(messageId)!;
  }

  /**
   * Deletes the text and files but keeps the row, so the history shows "message deleted" in
   * place. Returns the ids of the files to remove from disk.
   */
  delete(messageId: number, userId: number): { message: Message; removedFiles: string[] } {
    this.own(messageId, userId);
    const removedFiles = tx(this.db, () => {
      const ids = (this.db.prepare("SELECT id FROM attachments WHERE message_id = ?").all(messageId) as { id: string }[]).map((r) => r.id);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
      this.db.prepare("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?").run(now(), messageId);
      return ids;
    });
    return { message: this.message(messageId)!, removedFiles };
  }
}
