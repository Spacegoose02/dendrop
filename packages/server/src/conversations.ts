import { EVERYONE_RE, LIMITS, MENTION_RE, type Attachment, type ReplyRef, type MessageButton, type Conversation, type ForwardRef, type MessageInPlace, type MessagePlace, type ConversationE2ee, type Message, type MessageEdit, type NudgeKind, type ReadState, type ThreadRef, type UnreadCount, type WrappedKey } from "@dendrop/shared";
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
  dm_key: string | null;
  created_at: string;
  last_message_at: string | null;
}

/** The dm_key of someone's notes to self: a 1:1 conversation with only them in it. */
const notesKey = (userId: number) => `${userId}:${userId}`;
/** Whether a dm_key is a notes-to-self key (both halves the same person). */
const isNotesKey = (key: string | null): boolean => {
  if (!key) return false;
  const [a, b] = key.split(":");
  return a === b;
};

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
  reply_to_id: number | null;
  mentions_everyone: number;
  forwarded: string | null;
}

/** Extras for a new message: what it replies to, and who it pings. */
export interface SendOptions {
  /** The message this one answers (same conversation). */
  replyToId?: unknown;
  /** false: don't ping the author of the message being answered. */
  replyPing?: unknown;
  /** Encrypted messages only: the server can't read them, so the client says who they ping. */
  mentions?: unknown;
  mentionsEveryone?: unknown;
  /** Whether the author may ping @everyone here (checked by the caller). */
  canMentionEveryone?: boolean;
  /** Forwarding: the message being passed on (the author must be able to see it). */
  forwardOf?: unknown;
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

/** A reply's view of the message it answers. */
function replyRef(p: MessageRow): ReplyRef {
  const deleted = !!p.deleted_at;
  return {
    id: p.id,
    authorId: p.author_id,
    body: deleted ? "" : p.key_version ? p.body : p.body.slice(0, LIMITS.replyExcerpt),
    keyVersion: deleted ? null : p.key_version,
    deleted,
    webhookName: p.webhook_name,
  };
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
      isNotes: !r.is_group && isNotesKey(r.dm_key),
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

  /** In a 1:1 DM, the other person; undefined for groups, channels, threads and notes to self. */
  dmPartner(conversationId: number, me: number): number | undefined {
    const r = this.db.prepare("SELECT dm_key FROM conversations WHERE id = ?").get(conversationId) as { dm_key: string | null } | undefined;
    if (!r?.dm_key || isNotesKey(r.dm_key)) return undefined;
    const [a, b] = r.dm_key.split(":").map(Number);
    return a === me ? b : b === me ? a : undefined;
  }

  /** The id of the 1:1 DM between two people, if they have one. */
  openDmIfExists(a: number, b: number): number | undefined {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    return (this.db.prepare("SELECT id FROM conversations WHERE dm_key = ?").get(key) as { id: number } | undefined)?.id;
  }

  /** Whether a conversation is someone's notes to self. */
  isNotes(conversationId: number): boolean {
    const r = this.db.prepare("SELECT is_group, dm_key FROM conversations WHERE id = ?").get(conversationId) as { is_group: number; dm_key: string | null } | undefined;
    return !!r && !r.is_group && isNotesKey(r.dm_key);
  }

  /**
   * Your notes to self: a private chat with only you in it, for jotting things down and passing
   * links and files between your devices. Made the first time it's opened.
   */
  openNotes(me: number): { conversation: Conversation; created: boolean } {
    const key = notesKey(me);
    const existing = this.db.prepare("SELECT id FROM conversations WHERE dm_key = ?").get(key) as { id: number } | undefined;
    if (existing) return { conversation: this.get(existing.id, me)!, created: false };
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db.prepare("INSERT INTO conversations (is_group, dm_key, created_by, created_at) VALUES (0, ?, ?, ?)").run(key, me, t);
      const cid = Number(res.lastInsertRowid);
      this.db.prepare("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)").run(cid, me, t);
      return cid;
    });
    return { conversation: this.get(id, me)!, created: true };
  }

  /** The 1:1 conversation between two friends, made the first time it's needed. Yourself: your notes. */
  openDm(me: number, other: number): { conversation: Conversation; created: boolean } {
    if (me === other) return this.openNotes(me);
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
    const mentions = new Map<number, number[]>();
    for (const x of this.db.prepare(`SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${marks}) ORDER BY rowid`).all(...ids) as { message_id: number; user_id: number }[]) {
      mentions.set(x.message_id, [...(mentions.get(x.message_id) ?? []), x.user_id]);
    }
    const replyIds = [...new Set(rows.flatMap((r) => (r.reply_to_id ? [r.reply_to_id] : [])))];
    const replies = new Map(
      (replyIds.length
        ? (this.db.prepare(`SELECT * FROM messages WHERE id IN (${replyIds.map(() => "?").join(",")})`).all(...replyIds) as unknown as MessageRow[])
        : []
      ).map((p): [number, ReplyRef] => [p.id, replyRef(p)]),
    );
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
      replyTo: r.deleted_at || !r.reply_to_id ? null : (replies.get(r.reply_to_id) ?? null),
      mentions: r.deleted_at ? [] : (mentions.get(r.id) ?? []),
      mentionsEveryone: !r.deleted_at && !!r.mentions_everyone,
      forwarded: r.forwarded ? (JSON.parse(r.forwarded) as ForwardRef) : null,
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
    opts: SendOptions = {},
  ): Message {
    if (files.length > LIMITS.attachmentsPerMessage) throw new HttpError(400, `Up to ${LIMITS.attachmentsPerMessage} files per message`);
    const version = this.checkCrypto(conversationId, keyVersion, body);
    const text = version ? (body as string) : cleanBody(body, files.length > 0);
    const forwarded = this.forwardSource(authorId, opts.forwardOf);
    // A forward passes words on; it isn't a reply and pings nobody.
    const reply = forwarded ? null : this.replyTarget(conversationId, opts.replyToId);
    const pings = forwarded
      ? { ids: [], everyone: false }
      : this.pings(conversationId, authorId, version ? null : text, opts, reply && opts.replyPing !== false && !reply.webhook_name ? reply.author_id : null);
    const id = tx(this.db, () => {
      const t = now();
      const res = this.db
        .prepare(
          "INSERT INTO messages (conversation_id, author_id, body, created_at, key_version, webhook_id, webhook_name, buttons, reply_to_id, mentions_everyone, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          conversationId,
          authorId,
          text,
          t,
          version,
          webhook?.id ?? null,
          webhook?.name ?? null,
          buttons?.length ? JSON.stringify(buttons) : null,
          reply?.id ?? null,
          pings.everyone ? 1 : 0,
          forwarded ? JSON.stringify(forwarded) : null,
        );
      const mid = Number(res.lastInsertRowid);
      this.saveMentions(mid, pings.ids);
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

  /** The original of a forward: a message the forwarder can see, that isn't deleted. */
  private forwardSource(userId: number, forwardOf: unknown): ForwardRef | null {
    if (forwardOf === undefined || forwardOf === null || forwardOf === "") return null;
    const n = Number(forwardOf);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad forwardOf");
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(n) as MessageRow | undefined;
    if (!r || !this.isMember(r.conversation_id, userId)) throw new HttpError(404, "The message you're forwarding isn't there");
    if (r.deleted_at) throw new HttpError(409, "The message you're forwarding was deleted");
    // Forwarding a forward keeps the first author.
    if (r.forwarded) return JSON.parse(r.forwarded) as ForwardRef;
    const author = r.webhook_name ? null : this.users.byId(r.author_id);
    return { authorId: author ? author.id : null, authorName: r.webhook_name ?? author?.displayName ?? "Someone", createdAt: r.created_at };
  }

  /** Where a message lives, named for this person (a DM is named after the other person). */
  place(conversationId: number, viewerId: number): MessagePlace {
    const base = { conversationId, serverId: null, serverName: null, channelId: null, threadId: null };
    const th = this.db
      .prepare(
        `SELECT t.id AS thread_id, t.title, ch.id AS channel_id, ch.name AS channel_name, sv.id AS server_id, sv.name AS server_name
         FROM channel_threads t JOIN server_channels ch ON ch.id = t.channel_id JOIN servers sv ON sv.id = ch.server_id WHERE t.conversation_id = ?`,
      )
      .get(conversationId) as { thread_id: number; title: string; channel_id: number; channel_name: string; server_id: number; server_name: string } | undefined;
    if (th) return { ...base, kind: "thread", name: th.title, serverId: th.server_id, serverName: th.server_name, channelId: th.channel_id, threadId: th.thread_id };
    const ch = this.db
      .prepare("SELECT ch.id, ch.name, sv.id AS server_id, sv.name AS server_name FROM server_channels ch JOIN servers sv ON sv.id = ch.server_id WHERE ch.conversation_id = ?")
      .get(conversationId) as { id: number; name: string; server_id: number; server_name: string } | undefined;
    if (ch) return { ...base, kind: "channel", name: ch.name, serverId: ch.server_id, serverName: ch.server_name, channelId: ch.id };
    const c = this.get(conversationId, viewerId);
    if (c?.isNotes) return { ...base, kind: "dm", name: "Notes to self" };
    if (c?.isGroup) return { ...base, kind: "group", name: c.name ?? c.members.filter((m) => m.id !== viewerId).map((m) => m.displayName).join(", ") };
    const other = c?.members.find((m) => m.id !== viewerId);
    return { ...base, kind: "dm", name: other?.displayName ?? "Direct message" };
  }

  private inPlace(rows: (MessageRow & { saved_at?: string })[], viewerId: number): MessageInPlace[] {
    const messages = this.withAttachments(rows);
    const places = new Map<number, MessagePlace>();
    return messages.map((m, i) => {
      if (!places.has(m.conversationId)) places.set(m.conversationId, this.place(m.conversationId, viewerId));
      const savedAt = rows[i]!.saved_at;
      const u = m.webhook ? undefined : this.users.byId(m.authorId);
      return { message: m, place: places.get(m.conversationId)!, author: u ? toPublic(u) : null, ...(savedAt ? { savedAt } : {}) };
    });
  }

  /** Your saved messages, newest saved first: only ones still there and in chats you're still in. */
  saved(userId: number): MessageInPlace[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, s.created_at AS saved_at FROM saved_messages s JOIN messages m ON m.id = s.message_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = s.user_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`,
      )
      .all(userId, LIMITS.savedMessages) as unknown as (MessageRow & { saved_at: string })[];
    return this.inPlace(rows, userId);
  }

  /** Saves or unsaves a message. Returns whether anything changed. */
  setSaved(userId: number, messageId: number, saved: boolean): boolean {
    if (!saved) return Number(this.db.prepare("DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?").run(userId, messageId).changes) > 0;
    const r = this.db.prepare("SELECT conversation_id, deleted_at FROM messages WHERE id = ?").get(messageId) as { conversation_id: number; deleted_at: string | null } | undefined;
    if (!r || r.deleted_at || !this.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such message");
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM saved_messages WHERE user_id = ?").get(userId) as { n: number }).n;
    if (count >= LIMITS.savedMessages) throw new HttpError(409, `You can keep up to ${LIMITS.savedMessages} saved messages. Unsave some first.`);
    return Number(this.db.prepare("INSERT OR IGNORE INTO saved_messages (user_id, message_id, created_at) VALUES (?, ?, ?)").run(userId, messageId, now()).changes) > 0;
  }

  /**
   * The mentions inbox: messages that pinged you (by name, as a reply, or @everyone) in chats
   * you're in, newest first. `before` pages further back.
   */
  mentionsOf(userId: number, before?: number, limit = 30): MessageInPlace[] {
    const n = Math.max(1, Math.min(limit, 50));
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         WHERE m.deleted_at IS NULL AND m.author_id != ? AND m.id < ?
           AND (m.mentions_everyone = 1 OR EXISTS (SELECT 1 FROM message_mentions x WHERE x.message_id = m.id AND x.user_id = ?))
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(userId, userId, before ?? Number.MAX_SAFE_INTEGER, userId, n) as unknown as MessageRow[];
    return this.inPlace(rows, userId);
  }

  /** The message a reply answers: in the same conversation, and not deleted. */
  private replyTarget(conversationId: number, replyToId: unknown): MessageRow | null {
    if (replyToId === undefined || replyToId === null || replyToId === "") return null;
    const n = Number(replyToId);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad replyToId");
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ?").get(n, conversationId) as MessageRow | undefined;
    if (!r) throw new HttpError(404, "The message you're replying to isn't here");
    if (r.deleted_at) throw new HttpError(409, "The message you're replying to was deleted");
    return r;
  }

  /**
   * Who a message pings: <@id> tokens in plain text, or the list an encrypted message's client
   * sends, kept to people in the conversation (never the author). @everyone only counts for
   * people allowed to use it. `replyAuthor` is pinged too, unless it's the author.
   */
  private pings(conversationId: number, authorId: number, text: string | null, opts: SendOptions, replyAuthor: number | null): { ids: number[]; everyone: boolean } {
    let wanted: number[];
    let everyone: boolean;
    if (text !== null) {
      wanted = [...text.matchAll(MENTION_RE)].map((m) => Number(m[1]));
      everyone = EVERYONE_RE.test(text);
    } else {
      if (opts.mentions !== undefined && opts.mentions !== null && !Array.isArray(opts.mentions)) throw new HttpError(400, "mentions is a list of user ids");
      wanted = ((opts.mentions as unknown[] | undefined) ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      everyone = opts.mentionsEveryone === true;
    }
    if (replyAuthor !== null) wanted.push(replyAuthor);
    const members = new Set(this.memberIds(conversationId));
    const ids = [...new Set(wanted)].filter((id) => id !== authorId && members.has(id)).slice(0, LIMITS.mentionsPerMessage);
    return { ids, everyone: everyone && opts.canMentionEveryone === true };
  }

  private saveMentions(messageId: number, ids: number[]): void {
    this.db.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(messageId);
    const add = this.db.prepare("INSERT INTO message_mentions (message_id, user_id) VALUES (?, ?)");
    for (const id of ids) add.run(messageId, id);
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
    // Reading up to (or past) where someone marked it unread clears the mark.
    this.db.prepare("UPDATE conversation_members SET unread_from = NULL WHERE conversation_id = ? AND user_id = ? AND unread_from <= ?").run(conversationId, userId, messageId);
    return Number(res.changes) > 0 ? messageId : null;
  }

  /** Marks a conversation unread from a message on, for this person only (read receipts stay). */
  markUnread(conversationId: number, userId: number, messageId: number): void {
    const msg = this.db.prepare("SELECT id FROM messages WHERE id = ? AND conversation_id = ?").get(messageId, conversationId);
    if (!msg) throw new HttpError(404, "No such message");
    this.db.prepare("UPDATE conversation_members SET unread_from = ? WHERE conversation_id = ? AND user_id = ?").run(messageId, conversationId, userId);
  }

  /**
   * Unread messages from others in each of someone's conversations (DMs, groups, channels and
   * threads), counting from where they last read or marked unread. Only conversations with any.
   */
  unread(userId: number, conversationId?: number): UnreadCount[] {
    const rows = this.db
      .prepare(
        `SELECT cm.conversation_id AS cid,
           (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
              WHERE m.conversation_id = cm.conversation_id AND m.id > r.since AND m.deleted_at IS NULL
                AND (m.author_id != cm.user_id OR m.webhook_id IS NOT NULL) LIMIT 100)) AS n,
           (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = cm.conversation_id AND m.id > r.since AND m.deleted_at IS NULL AND m.author_id != cm.user_id
                AND (m.mentions_everyone = 1 OR EXISTS (SELECT 1 FROM message_mentions x WHERE x.message_id = m.id AND x.user_id = cm.user_id))) AS pings
         FROM conversation_members cm
         JOIN (SELECT conversation_id, user_id,
                 CASE WHEN unread_from IS NOT NULL THEN MIN(COALESCE(last_read_message_id, 0), unread_from - 1) ELSE COALESCE(last_read_message_id, 0) END AS since
               FROM conversation_members) r ON r.conversation_id = cm.conversation_id AND r.user_id = cm.user_id
         WHERE cm.user_id = ? ${conversationId ? "AND cm.conversation_id = ?" : ""}`,
      )
      .all(...(conversationId ? [userId, conversationId] : [userId])) as { cid: number; n: number; pings: number }[];
    return rows.filter((r) => r.n > 0 || conversationId).map((r) => ({ conversationId: r.cid, count: Number(r.n), mentions: Number(r.pings) }));
  }

  private own(messageId: number, userId: number): MessageRow {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!r || !this.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such message");
    if (r.author_id !== userId || r.webhook_name) throw new HttpError(403, "You can only change your own messages");
    if (r.deleted_at) throw new HttpError(409, "That message was deleted");
    return r;
  }

  edit(messageId: number, userId: number, body: unknown, keyVersion: number | null = null, opts: SendOptions = {}): Message {
    const r = this.own(messageId, userId);
    if (r.nudge || this.fun.polls([messageId]).size || this.fun.games([messageId]).size) throw new HttpError(400, "Polls, games and nudges can't be edited");
    const version = this.checkCrypto(r.conversation_id, keyVersion, body);
    const hasFiles = !!this.db.prepare("SELECT 1 FROM attachments WHERE message_id = ?").get(messageId);
    // An encrypted message's files are described inside its ciphertext, so a plain edit would lose them.
    if (!version && r.key_version) throw new HttpError(400, "Edits of an encrypted message must be encrypted");
    const text = version ? (body as string) : cleanBody(body, hasFiles);
    // A reply keeps pinging whoever it pinged before; the words' pings are worked out again.
    const reply = r.reply_to_id ? (this.db.prepare("SELECT author_id FROM messages WHERE id = ?").get(r.reply_to_id) as { author_id: number } | undefined) : undefined;
    const keptReplyPing = reply && this.db.prepare("SELECT 1 FROM message_mentions WHERE message_id = ? AND user_id = ?").get(messageId, reply.author_id) ? reply.author_id : null;
    const pings = this.pings(r.conversation_id, userId, version ? null : text, opts, keptReplyPing);
    tx(this.db, () => {
      const at = now();
      // Keep the version being replaced, as stored (still encrypted if it was), then drop the
      // oldest past the cap.
      this.db
        .prepare("INSERT INTO message_edits (message_id, body, key_version, written_at, replaced_at) VALUES (?, ?, ?, ?, ?)")
        .run(messageId, r.body, r.key_version, r.edited_at ?? r.created_at, at);
      this.db
        .prepare("DELETE FROM message_edits WHERE message_id = ? AND id NOT IN (SELECT id FROM message_edits WHERE message_id = ? ORDER BY id DESC LIMIT ?)")
        .run(messageId, messageId, LIMITS.editHistory);
      this.db.prepare("UPDATE messages SET body = ?, edited_at = ?, key_version = ?, mentions_everyone = ? WHERE id = ?").run(text, at, version, pings.everyone ? 1 : 0, messageId);
      this.saveMentions(messageId, pings.ids);
    });
    return this.message(messageId)!;
  }

  /**
   * A message's earlier versions, oldest first, for anyone who can see the message. Encrypted
   * ones come back as ciphertext with their key version, for the reader's app to open.
   */
  edits(messageId: number, userId: number): MessageEdit[] {
    const r = this.db.prepare("SELECT conversation_id, deleted_at FROM messages WHERE id = ?").get(messageId) as { conversation_id: number; deleted_at: string | null } | undefined;
    if (!r || !this.isMember(r.conversation_id, userId)) throw new HttpError(404, "No such message");
    if (r.deleted_at) return [];
    return (
      this.db.prepare("SELECT body, key_version, written_at, replaced_at FROM message_edits WHERE message_id = ? ORDER BY id").all(messageId) as {
        body: string;
        key_version: number | null;
        written_at: string;
        replaced_at: string;
      }[]
    ).map((e) => ({ body: e.body, keyVersion: e.key_version, writtenAt: e.written_at, replacedAt: e.replaced_at }));
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
      this.db.prepare("UPDATE messages SET body = '', key_version = NULL, buttons = NULL, mentions_everyone = 0, deleted_at = ? WHERE id = ?").run(now(), messageId);
      this.db.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(messageId);
      // Deleting takes the earlier versions too.
      this.db.prepare("DELETE FROM message_edits WHERE message_id = ?").run(messageId);
      return ids;
    });
    return { message: this.message(messageId)!, removedFiles };
  }
}
