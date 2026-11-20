import { SCHEDULE_LIMITS, type ScheduledMessage } from "@dendrop/shared";
import { cleanBody, isCiphertext } from "./conversations.js";
import { now, type Db } from "./db.js";
import { HttpError } from "./errors.js";

/**
 * "Send later": messages waiting for their time. The routes (routes/scheduled.ts) send them
 * through the same checks as a message sent right now; this only stores and validates them.
 */

interface ScheduledRow {
  id: number;
  user_id: number;
  conversation_id: number;
  body: string;
  key_version: number | null;
  mentions: string | null;
  mentions_everyone: number;
  reply_to_id: number | null;
  send_at: string;
  created_at: string;
  error: string | null;
}

/** A scheduled message as stored, with whose it is. */
export type ScheduledRecord = ScheduledMessage & { userId: number };

const toScheduled = (r: ScheduledRow): ScheduledRecord => ({
  id: r.id,
  userId: r.user_id,
  conversationId: r.conversation_id,
  body: r.body,
  keyVersion: r.key_version,
  mentions: r.mentions ? (JSON.parse(r.mentions) as number[]) : [],
  mentionsEveryone: !!r.mentions_everyone,
  replyToId: r.reply_to_id,
  sendAt: r.send_at,
  createdAt: r.created_at,
  error: r.error,
});

/** Strips whose it is, for the API. */
export const publicScheduled = ({ userId: _, ...s }: ScheduledRecord): ScheduledMessage => s;

/** The words of a scheduled message, as given: { body, keyVersion, mentions, mentionsEveryone }. */
export interface ScheduledInput {
  body?: unknown;
  keyVersion?: unknown;
  mentions?: unknown;
  mentionsEveryone?: unknown;
  replyToId?: unknown;
  sendAt?: unknown;
}

/** When to send: an ISO date and time, from now up to a year ahead. */
export function cleanSendAt(v: unknown, at = Date.now()): string {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new HttpError(400, "sendAt is when to send it, as a date and time");
  if (t <= at) throw new HttpError(400, "Pick a time in the future");
  if (t > at + SCHEDULE_LIMITS.days * 86_400_000) throw new HttpError(400, "Messages can be scheduled up to a year ahead");
  return new Date(t).toISOString();
}

/**
 * Checks the words against the conversation: plain text in plain chats, ciphertext under the
 * newest key in encrypted ones (the app re-encrypts on edit if the key changes meanwhile).
 */
function cleanWords(input: ScheduledInput, latestKey: number): { body: string; keyVersion: number | null; mentions: number[]; mentionsEveryone: boolean } {
  const kv = input.keyVersion === undefined || input.keyVersion === null || input.keyVersion === "" ? null : Number(input.keyVersion);
  if (kv !== null && (!Number.isInteger(kv) || kv <= 0)) throw new HttpError(400, "Bad keyVersion");
  if (kv === null) {
    if (latestKey) throw new HttpError(409, "This conversation is end-to-end encrypted; update the app to send here");
    return { body: cleanBody(input.body), keyVersion: null, mentions: [], mentionsEveryone: false };
  }
  if (kv !== latestKey) throw new HttpError(409, "The conversation key changed; reload and try again");
  if (!isCiphertext(input.body)) throw new HttpError(400, "That isn't an encrypted message");
  const mentions = Array.isArray(input.mentions) ? [...new Set(input.mentions.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100) : [];
  return { body: input.body, keyVersion: kv, mentions, mentionsEveryone: input.mentionsEveryone === true };
}

const replyId = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad replyToId");
  return n;
};

export class ScheduledRepo {
  constructor(private readonly db: Db) {}

  get(id: number): ScheduledRecord | undefined {
    const r = this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id) as ScheduledRow | undefined;
    return r && toScheduled(r);
  }

  /** Yours, a 404 otherwise. */
  mine(id: number, userId: number): ScheduledRecord {
    const s = this.get(id);
    if (!s || s.userId !== userId) throw new HttpError(404, "No such scheduled message");
    return s;
  }

  /** Someone's scheduled messages, soonest first; just one conversation's when given. */
  list(userId: number, conversationId?: number): ScheduledRecord[] {
    const rows = (
      conversationId
        ? this.db.prepare("SELECT * FROM scheduled_messages WHERE user_id = ? AND conversation_id = ? ORDER BY send_at, id").all(userId, conversationId)
        : this.db.prepare("SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at, id").all(userId)
    ) as unknown as ScheduledRow[];
    return rows.map(toScheduled);
  }

  create(userId: number, conversationId: number, latestKey: number, input: ScheduledInput): ScheduledRecord {
    const sendAt = cleanSendAt(input.sendAt);
    const words = cleanWords(input, latestKey);
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ?").get(userId) as { n: number };
    if (Number(pending.n) >= SCHEDULE_LIMITS.pending) throw new HttpError(400, `You can have up to ${SCHEDULE_LIMITS.pending} scheduled messages; send or cancel some first`);
    const res = this.db
      .prepare(
        "INSERT INTO scheduled_messages (user_id, conversation_id, body, key_version, mentions, mentions_everyone, reply_to_id, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(userId, conversationId, words.body, words.keyVersion, JSON.stringify(words.mentions), words.mentionsEveryone ? 1 : 0, replyId(input.replyToId), sendAt, now());
    return this.get(Number(res.lastInsertRowid))!;
  }

  /**
   * Changes the words (send body and keyVersion together) and/or the time. Clears a send error,
   * so it tries again at its time; one whose time already passed needs a new time.
   */
  update(s: ScheduledRecord, latestKey: number, input: ScheduledInput): ScheduledRecord {
    const sendAt = input.sendAt !== undefined ? cleanSendAt(input.sendAt) : s.error ? cleanSendAt(s.sendAt) : s.sendAt;
    const words = input.body !== undefined ? cleanWords(input, latestKey) : s;
    this.db
      .prepare("UPDATE scheduled_messages SET body = ?, key_version = ?, mentions = ?, mentions_everyone = ?, send_at = ?, error = NULL WHERE id = ?")
      .run(words.body, words.keyVersion, JSON.stringify(words.mentions), words.mentionsEveryone ? 1 : 0, sendAt, s.id);
    return this.get(s.id)!;
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(id);
  }

  /** Marks one as not sent, with why. */
  fail(id: number, error: string): ScheduledRecord | undefined {
    this.db.prepare("UPDATE scheduled_messages SET error = ? WHERE id = ?").run(error.slice(0, 300), id);
    return this.get(id);
  }

  /** Those due by `at` that haven't failed, oldest first. */
  due(at: Date): ScheduledRecord[] {
    return (this.db.prepare("SELECT * FROM scheduled_messages WHERE error IS NULL AND send_at <= ? ORDER BY send_at, id").all(at.toISOString()) as unknown as ScheduledRow[]).map(
      toScheduled,
    );
  }
}
