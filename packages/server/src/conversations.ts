import { LIMITS, type Attachment, type MessageButton, type Conversation, type ConversationE2ee, type Message, type NudgeKind, type ReadState, type ThreadRef, type WrappedKey } from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import { ExpressionRepo } from "./expressions.js";
import { FunRepo } from "./fun.js";
import { guardianIds } from "./family.js";
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
  key_version: number | null;
  webhook_id: number | null;
  webhook_name: string | null;
  buttons: string | null;
  nudge: string | null;
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

const B64 = /^[A-Za-z0-9_-]+$/;
/** An encrypted message body: base64url IV and ciphertext. */
const isCiphertext = (s: unknown): s is string =>
  typeof s === "string" && s.length <= LIMITS.encryptedBodyLength && /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(s);
/** A wrapped conversation key: base64url ephemeral public key, IV and ciphertext. */
export const isWrappedKey = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 400 && s.split(".").length === 3 && s.split(".").every((p) => B64.test(p));

export function cleanBody(body: unknown, allowEmpty = false): string {
  if (body === undefined && allowEmpty) return "";
  if (typeof body !== "string") throw new HttpError(400, "A message needs text");
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text && !allowEmpty) throw new HttpError(400, "A message needs text");
  if (text.length > LIMITS.messageLength) throw new HttpError(400, `Messages can be up to ${LIMITS.messageLength} characters`);
  return text;
}

export class ConversationRepo {
  private readonly expressions: ExpressionRepo;
  readonly fun: FunRepo;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly friends: FriendRepo,
  ) {
    this.expressions = new ExpressionRepo(db);
    this.fun = new FunRepo(db);
  }

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
      e2ee: this.e2ee(r.id),
      guardians: guardianIds(this.db, r.id).flatMap((id) => {
        const u = this.users.byId(id);
        return u ? [toPublic(u)] : [];
      }),
    };
  }

  /**
   * Who gets a copy of each conversation key: the members, and the parents of any kids in it
   * (see family.ts). Parents can only fetch messages while an alert about the chat is open.
   */
  keyHolderIds(conversationId: number): number[] {
    return [...this.memberIds(conversationId), ...guardianIds(this.db, conversationId)];
  }

  /** The newest key version (0 for none). */
  keyVersion(conversationId: number): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM conversation_keys WHERE conversation_id = ?").get(conversationId) as { v: number | null };
    return Number(r.v ?? 0);
  }

  e2ee(conversationId: number): ConversationE2ee | null {
    const version = this.keyVersion(conversationId);
    if (!version) return null;
    const have = new Set(
      (
        this.db
          .prepare(
            `SELECT k.user_id FROM conversation_keys k JOIN users u ON u.id = k.user_id
             WHERE k.conversation_id = ? AND k.version = ? AND k.recipient_key = u.public_key`,
          )
          .all(conversationId, version) as { user_id: number }[]
      ).map((r) => r.user_id),
    );
    return { version, missing: this.keyHolderIds(conversationId).filter((id) => !have.has(id)) };
  }

  /** The copies of this conversation's keys that `userId` can open with their current key. */
  wrappedKeys(conversationId: number, userId: number): WrappedKey[] {
    return this.db
      .prepare(
        `SELECT k.version, k.wrapped FROM conversation_keys k JOIN users u ON u.id = k.user_id
         WHERE k.conversation_id = ? AND k.user_id = ? AND k.recipient_key = u.public_key ORDER BY k.version`,
      )
      .all(conversationId, userId) as unknown as WrappedKey[];
  }

  /**
   * Adds the next key version, encrypted to every member's current public key. The client
   * makes and wraps the key; the server only checks it covers everyone, with up-to-date keys.
   */
  addKey(conversationId: number, by: number, version: unknown, keys: unknown): void {
    if (!keys || typeof keys !== "object") throw new HttpError(400, "keys is { userId: { publicKey, wrapped } }");
    const given = keys as Record<string, { publicKey?: unknown; wrapped?: unknown } | undefined>;
    // Members and kids' parents. Parents always have keys (linking needs them), but check anyway.
    const members = this.keyHolderIds(conversationId).map((id) => this.users.byId(id)!);
    const waiting = members.filter((u) => !u.publicKey);
    if (waiting.length) throw new HttpError(409, `${waiting.map((u) => u.displayName).join(", ")} hasn't set up encryption yet`);
    if (Object.keys(given).length !== members.length) throw new HttpError(400, "The key has to be wrapped for every member and every kid's parent");
    for (const u of members) {
      const k = given[String(u.id)];
      if (!k || !isWrappedKey(k.wrapped)) throw new HttpError(400, "The key has to be wrapped for every member and every kid's parent");
      if (k.publicKey !== u.publicKey) throw new HttpError(409, "Someone's encryption key changed; reload and try again");
    }
    tx(this.db, () => {
      if (version !== this.keyVersion(conversationId) + 1) throw new HttpError(409, "Someone just made a new key; reload and try again");
      const add = this.db.prepare(
        "INSERT INTO conversation_keys (conversation_id, version, user_id, recipient_key, wrapped, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const t = now();
      for (const u of members) add.run(conversationId, version, u.id, u.publicKey, given[String(u.id)]!.wrapped as string, by, t);
    });
  }

  /**
   * Checks a message's encryption against the conversation: once it has a key, messages must be
   * encrypted with the newest version, so an old or tampered client can't send in the clear.
   */
  private checkCrypto(conversationId: number, keyVersion: number | null | undefined, body: unknown): number | null {
    const latest = this.keyVersion(conversationId);
    if (keyVersion === null || keyVersion === undefined) {
      if (latest) throw new HttpError(409, "This conversation is end-to-end encrypted; update the app to send here");
      return null;
    }
    if (!latest || keyVersion !== latest) throw new HttpError(409, "The conversation key changed; reload and try again");
    if (!isCiphertext(body)) throw new HttpError(400, "That isn't an encrypted message");
    return keyVersion;
  }

  /** Conversations `userId` is in, most recently active first. */
  list(userId: number): Conversation[] {
    const ids = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = ? AND c.kind = 'dm' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
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
    const reactions = this.expressions.reactions(ids);
    const marks = ids.map(() => "?").join(",");
    const pinned = new Set((this.db.prepare(`SELECT message_id FROM message_pins WHERE message_id IN (${marks})`).all(...ids) as { message_id: number }[]).map((p) => p.message_id));
    const threads = new Map(
      (
        this.db
          .prepare(
            `SELECT t.id, t.parent_message_id, t.conversation_id, t.title, c.last_message_at,
               (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = t.conversation_id AND x.deleted_at IS NULL) AS n
             FROM channel_threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.parent_message_id IN (${marks})`,
          )
          .all(...ids) as { id: number; parent_message_id: number; conversation_id: number; title: string; last_message_at: string | null; n: number }[]
      ).map((t): [number, ThreadRef] => [
        t.parent_message_id,
        { id: t.id, conversationId: t.conversation_id, title: t.title, messageCount: Number(t.n), lastMessageAt: t.last_message_at },
      ]),
    );
    const polls = this.fun.polls(ids);
    const games = this.fun.games(ids);
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      authorId: r.author_id,
      body: r.deleted_at ? "" : r.body,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deleted: !!r.deleted_at,
      keyVersion: r.deleted_at ? null : r.key_version,
      attachments: r.deleted_at ? [] : files.filter((f) => f.message_id === r.id).map(toAttachment),
      webhook: r.webhook_name ? { id: r.webhook_id, name: r.webhook_name } : null,
      buttons: r.deleted_at || !r.buttons ? null : (JSON.parse(r.buttons) as MessageButton[]),
      reactions: r.deleted_at ? [] : (reactions.get(r.id) ?? []),
      // A thread outlives the message it was started from.
      thread: threads.get(r.id) ?? null,
      pinned: pinned.has(r.id),
      poll: r.deleted_at ? null : (polls.get(r.id) ?? null),
      game: r.deleted_at ? null : (games.get(r.id) ?? null),
      nudge: r.deleted_at ? null : ((r.nudge as NudgeKind | null) ?? null),
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

  /** A file in a conversation, for someone allowed to see it without being a member. */
  attachmentIn(id: string, conversationId: number): Attachment | undefined {
    const a = this.db.prepare("SELECT * FROM attachments WHERE id = ? AND conversation_id = ?").get(id, conversationId) as AttachmentRow | undefined;
    return a && toAttachment(a);
  }

  /**
   * Posts a message. `webhook` posts it as an incoming webhook (whose maker is the author on
   * record): it's shown under the webhook's name and doesn't move the maker's read marker.
   */
  send(
    conversationId: number,
    authorId: number,
    body: unknown,
    files: NewAttachment[] = [],
    keyVersion: number | null = null,
    webhook: { id: number | null; name: string } | null = null,
    buttons: MessageButton[] | null = null,
  ): Message {
    if (files.length > LIMITS.attachmentsPerMessage) throw new HttpError(400, `Up to ${LIMITS.attachmentsPerMessage} files per message`);
    const version = this.checkCrypto(conversationId, keyVersion, body);
    const text = version ? (body as string) : cleanBody(body, files.length > 0);
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db
        .prepare("INSERT INTO messages (conversation_id, author_id, body, created_at, key_version, webhook_id, webhook_name, buttons) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(conversationId, authorId, text, t, version, webhook?.id ?? null, webhook?.name ?? null, buttons?.length ? JSON.stringify(buttons) : null);
      const mid = Number(res.lastInsertRowid);
      const add = this.db.prepare(
        "INSERT INTO attachments (id, message_id, conversation_id, name, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const f of files) add.run(f.id, mid, conversationId, f.name, f.size, f.contentType, t);
      this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(t, conversationId);
      // Sending counts as reading everything up to here.
      if (!webhook) this.db.prepare("UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?").run(mid, conversationId, authorId);
      return mid;
    });
    return this.message(id)!;
  }

  /**
   * Posts a poll, game or nudge. A poll's question is its body, under the usual rules (encrypted
   * once the chat has a key). Games and nudges carry no words, so their body is empty and plain
   * even in an encrypted chat. `add` stores the poll or game, in the same transaction.
   */
  sendCard(
    conversationId: number,
    authorId: number,
    card: { body: unknown; keyVersion: number | null; nudge?: NudgeKind; add?: (messageId: number) => void },
  ): Message {
    const words = card.body !== "";
    const version = words ? this.checkCrypto(conversationId, card.keyVersion, card.body) : null;
    const text = !words ? "" : version ? (card.body as string) : cleanBody(card.body);
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db
        .prepare("INSERT INTO messages (conversation_id, author_id, body, created_at, key_version, nudge) VALUES (?, ?, ?, ?, ?, ?)")
        .run(conversationId, authorId, text, t, version, card.nudge ?? null);
      const mid = Number(res.lastInsertRowid);
      card.add?.(mid);
      this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(t, conversationId);
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
    if (r.author_id !== userId || r.webhook_name) throw new HttpError(403, "You can only change your own messages");
    if (r.deleted_at) throw new HttpError(409, "That message was deleted");
    return r;
  }

  edit(messageId: number, userId: number, body: unknown, keyVersion: number | null = null): Message {
    const r = this.own(messageId, userId);
    if (r.nudge || this.fun.polls([messageId]).size || this.fun.games([messageId]).size) throw new HttpError(400, "Polls, games and nudges can't be edited");
    const version = this.checkCrypto(r.conversation_id, keyVersion, body);
    const hasFiles = !!this.db.prepare("SELECT 1 FROM attachments WHERE message_id = ?").get(messageId);
    // An encrypted message's files are described inside its ciphertext, so a plain edit would lose them.
    if (!version && r.key_version) throw new HttpError(400, "Edits of an encrypted message must be encrypted");
    this.db
      .prepare("UPDATE messages SET body = ?, edited_at = ?, key_version = ? WHERE id = ?")
      .run(version ? (body as string) : cleanBody(body, hasFiles), now(), version, messageId);
    return this.message(messageId)!;
  }

  /** Changes a bot message's buttons (null or [] removes them). The caller checks it's the bot's. */
  setButtons(messageId: number, buttons: MessageButton[] | null): Message {
    this.db.prepare("UPDATE messages SET buttons = ? WHERE id = ?").run(buttons?.length ? JSON.stringify(buttons) : null, messageId);
    return this.message(messageId)!;
  }

  /**
   * Deletes the text and files but keeps the row, so the history shows "message deleted" in
   * place. Returns the ids of the files to remove from disk. Moderators (checked by the caller)
   * can delete anyone's message.
   */
  delete(messageId: number, userId: number, asModerator = false): { message: Message; removedFiles: string[] } {
    if (asModerator) {
      const r = this.db.prepare("SELECT deleted_at FROM messages WHERE id = ?").get(messageId) as { deleted_at: string | null } | undefined;
      if (!r) throw new HttpError(404, "No such message");
      if (r.deleted_at) throw new HttpError(409, "That message was deleted");
    } else this.own(messageId, userId);
    const removedFiles = tx(this.db, () => {
      const ids = (this.db.prepare("SELECT id FROM attachments WHERE message_id = ?").all(messageId) as { id: string }[]).map((r) => r.id);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
      this.expressions.clearReactions(messageId);
      this.db.prepare("DELETE FROM message_pins WHERE message_id = ?").run(messageId);
      this.db.prepare("UPDATE messages SET body = '', key_version = NULL, buttons = NULL, deleted_at = ? WHERE id = ?").run(now(), messageId);
      return ids;
    });
    return { message: this.message(messageId)!, removedFiles };
  }
}
