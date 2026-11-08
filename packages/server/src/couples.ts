import { rmSync } from "node:fs";
import path from "node:path";
import { COUPLES_KINDS, COUPLES_LIMITS, LIMITS, type CouplesItem, type CouplesKind, type CouplesKit, type CouplesKitState, type CouplesSpicyPack } from "@dendrop/shared";
import { SPICY_PACK } from "./couples-spicy.js";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import { guardianIds } from "./family.js";
import type { Gateway } from "./gateway.js";
import { couplesAllowed, type UserRepo } from "./users.js";

/**
 * The couples kit: private extras for a 1:1 DM between two adults (a Yes / No / Maybe list,
 * questions, prompt cards, a date night spinner, view-once photos, love notes and countdowns).
 *
 * The rules that keep it adults-only and private:
 * - Only a 1:1 DM, only when neither person is a kid account, and only once the chat is end-to-end
 *   encrypted. Both people have to say yes before it turns on, and either can turn it off, which
 *   deletes everything in it.
 * - Everything in it is ciphertext. It lives in its own tables, never in the message history, so
 *   nothing a parent can open through a kid's alert (messages, kept deletions) ever includes it.
 * - If either person is later linked to a parent, every kit they're in is deleted straight away,
 *   before the parent gets any key.
 * - Votes are kept private: the other person only ever learns a mutual match, or both answers to
 *   a question once both have answered.
 */

interface KitRow {
  conversation_id: number;
  invited_by: number;
  created_at: string;
  accepted_at: string | null;
}

interface ItemRow {
  id: number;
  conversation_id: number;
  kind: CouplesKind;
  author_id: number;
  body: string;
  key_version: number;
  file: string | null;
  file_size: number | null;
  deliver_at: string | null;
  notified_at: string | null;
  opened_at: string | null;
  created_at: string;
  updated_at: string;
}

/** An encrypted body: base64url IV and ciphertext, like a message. */
const isCiphertext = (s: unknown): s is string =>
  typeof s === "string" && s.length <= LIMITS.encryptedBodyLength && /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(s);

const IDEA_VOTES = new Set(["yes", "no", "maybe"]);
/** Kinds either person can change after adding (the rest are deleted and added again). */
const EDITABLE = new Set<CouplesKind>(["card", "spinner", "countdown"]);

export class CouplesService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly gateway: Gateway,
    private readonly uploads: string,
    /** Wakes the phones of people with nothing open (set by the push service). */
    private readonly notify: (userIds: number[]) => void = () => {},
  ) {}

  /** Delivers scheduled love notes, every 20 seconds. */
  start(): void {
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ---- Who can have one --------------------------------------------------------------

  private memberIds(cid: number): number[] {
    return (this.db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id").all(cid) as { user_id: number }[]).map(
      (r) => r.user_id,
    );
  }

  /**
   * The two people in a 1:1 DM that `userId` is in. Throws 404 for anything else, and for kid
   * accounts, so the kit doesn't exist as far as a kid can tell.
   */
  private pair(cid: number, userId: number): [number, number] {
    const me = this.users.byId(userId);
    // Hidden unless a super admin switched it on for you; never there for kid accounts.
    if (!me || !couplesAllowed(me)) throw new HttpError(404, "Not found");
    const c = this.db.prepare("SELECT kind, is_group, dm_key FROM conversations WHERE id = ?").get(cid) as
      | { kind: string; is_group: number; dm_key: string | null }
      | undefined;
    const members = this.memberIds(cid);
    if (!c || c.kind !== "dm" || c.is_group || !c.dm_key || members.length !== 2 || !members.includes(userId)) throw new HttpError(404, "No such conversation");
    const other = members.find((id) => id !== userId)!;
    return [userId, other];
  }

  /**
   * Whether this DM can have a kit: the other person is an adult account the kit is switched on
   * for too (the caller already is), and no kid's parents are guardians of the chat.
   */
  private eligible(cid: number, other: number): boolean {
    const them = this.users.byId(other);
    return !!them && couplesAllowed(them) && guardianIds(this.db, cid).length === 0;
  }

  /** Why this DM can't have a kit right now, or null. */
  private unavailable(cid: number, other: number): string | null {
    if (!this.eligible(cid, other)) return "The couples kit is only for chats between two adult accounts.";
    if (!this.keyVersion(cid)) return "Turn on end-to-end encryption in this chat first (it turns on once you've both set it up and sent a message).";
    return null;
  }

  private keyVersion(cid: number): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM conversation_keys WHERE conversation_id = ?").get(cid) as { v: number | null };
    return Number(r.v ?? 0);
  }

  private kitRow(cid: number): KitRow | undefined {
    return this.db.prepare("SELECT * FROM couples_kits WHERE conversation_id = ?").get(cid) as KitRow | undefined;
  }

  private state(k: KitRow | undefined): CouplesKitState {
    return !k ? "off" : k.accepted_at ? "on" : "invited";
  }

  /** Throws unless the kit is on and still allowed. Returns the other person's id. */
  private requireOn(cid: number, userId: number): number {
    const [, other] = this.pair(cid, userId);
    if (this.state(this.kitRow(cid)) !== "on") throw new HttpError(404, "The couples kit isn't on in this chat");
    const why = this.unavailable(cid, other);
    if (why) throw new HttpError(403, why);
    return other;
  }

  // ---- The kit -------------------------------------------------------------------------

  /** Your view of a conversation's kit. */
  get(cid: number, userId: number, at = new Date()): CouplesKit {
    const [, other] = this.pair(cid, userId);
    const k = this.kitRow(cid);
    const state = this.state(k);
    const unavailable = this.unavailable(cid, other);
    return {
      conversationId: cid,
      state,
      invitedBy: k?.invited_by ?? null,
      eligible: this.eligible(cid, other),
      unavailable,
      items: state === "on" && !unavailable ? this.items(cid, userId, at) : [],
      spicy: { mine: this.spicyOn(cid, userId), partner: this.spicyOn(cid, other) },
    };
  }

  // ---- Spicy mode -------------------------------------------------------------------------

  private spicyOn(cid: number, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM couples_spicy WHERE conversation_id = ? AND user_id = ?").get(cid, userId);
  }

  /** Switches spicy mode on or off for yourself. The pack only comes once both have it on. */
  setSpicy(cid: number, userId: number, on: unknown): CouplesKit {
    this.requireOn(cid, userId);
    if (typeof on !== "boolean") throw new HttpError(400, "on is true or false");
    if (on) this.db.prepare("INSERT OR IGNORE INTO couples_spicy (conversation_id, user_id, created_at) VALUES (?, ?, ?)").run(cid, userId, now());
    else this.db.prepare("DELETE FROM couples_spicy WHERE conversation_id = ? AND user_id = ?").run(cid, userId);
    this.changed(cid);
    return this.get(cid, userId);
  }

  /** The spicy pack, for the two people in a kit once both have switched spicy mode on. */
  spicyPack(cid: number, userId: number): CouplesSpicyPack {
    const other = this.requireOn(cid, userId);
    if (!this.spicyOn(cid, userId) || !this.spicyOn(cid, other)) throw new HttpError(403, "Spicy mode is on only once you've both switched it on");
    return SPICY_PACK;
  }

  /** Asks the other person to turn the kit on. */
  invite(cid: number, userId: number): CouplesKit {
    const [, other] = this.pair(cid, userId);
    const why = this.unavailable(cid, other);
    if (why) throw new HttpError(403, why);
    const k = this.kitRow(cid);
    if (k && this.state(k) === "on") return this.get(cid, userId);
    // Both asked: that's a yes from both.
    if (k && k.invited_by === other) return this.accept(cid, userId);
    if (!k) this.db.prepare("INSERT INTO couples_kits (conversation_id, invited_by, created_at) VALUES (?, ?, ?)").run(cid, userId, now());
    this.changed(cid);
    return this.get(cid, userId);
  }

  /** The other person says yes. */
  accept(cid: number, userId: number): CouplesKit {
    const [, other] = this.pair(cid, userId);
    const why = this.unavailable(cid, other);
    if (why) throw new HttpError(403, why);
    const k = this.kitRow(cid);
    if (!k) throw new HttpError(404, "Nobody has asked to turn on the couples kit here");
    if (k.accepted_at) return this.get(cid, userId);
    if (k.invited_by === userId) throw new HttpError(409, "The other person has to say yes");
    this.db.prepare("UPDATE couples_kits SET accepted_at = ? WHERE conversation_id = ?").run(now(), cid);
    this.changed(cid);
    return this.get(cid, userId);
  }

  /** Declines, cancels, or turns the kit off: everything in it is deleted, photos included. */
  turnOff(cid: number, userId: number): CouplesKit {
    this.pair(cid, userId);
    this.wipe([cid]);
    this.changed(cid);
    return this.get(cid, userId);
  }

  /**
   * Deletes every kit `userId` is in. Called when the account is linked to a parent, before the
   * parent is given any conversation key.
   */
  wipeFor(userId: number): void {
    const cids = (
      this.db
        .prepare("SELECT k.conversation_id FROM couples_kits k JOIN conversation_members m ON m.conversation_id = k.conversation_id WHERE m.user_id = ?")
        .all(userId) as { conversation_id: number }[]
    ).map((r) => r.conversation_id);
    this.wipe(cids);
    for (const cid of cids) this.changed(cid);
  }

  private wipe(cids: number[]): void {
    if (!cids.length) return;
    const files = tx(this.db, () => {
      const out: string[] = [];
      for (const cid of cids) {
        out.push(
          ...(this.db.prepare("SELECT file FROM couples_items WHERE conversation_id = ? AND file IS NOT NULL").all(cid) as { file: string }[]).map((r) => r.file),
        );
        this.db.prepare("DELETE FROM couples_kits WHERE conversation_id = ?").run(cid);
      }
      return out;
    });
    this.removeFiles(files);
  }

  private removeFiles(files: string[]): void {
    for (const f of files) rmSync(path.join(this.uploads, f), { force: true });
  }

  // ---- Items ---------------------------------------------------------------------------

  private items(cid: number, userId: number, at: Date): CouplesItem[] {
    const rows = this.db.prepare("SELECT * FROM couples_items WHERE conversation_id = ? ORDER BY id").all(cid) as unknown as ItemRow[];
    const visible = rows.filter((r) => this.visibleTo(r, userId, at));
    if (!visible.length) return [];
    const votes = this.db
      .prepare(`SELECT item_id, user_id, vote FROM couples_votes WHERE item_id IN (${visible.map(() => "?").join(",")})`)
      .all(...visible.map((r) => r.id)) as { item_id: number; user_id: number; vote: string }[];
    return visible.map((r) => this.view(r, userId, votes.filter((v) => v.item_id === r.id)));
  }

  /** A love note stays hidden from the other person until its time. */
  private visibleTo(r: ItemRow, userId: number, at: Date): boolean {
    return r.author_id === userId || !r.deliver_at || Date.parse(r.deliver_at) <= at.getTime();
  }

  private view(r: ItemRow, userId: number, votes: { user_id: number; vote: string }[]): CouplesItem {
    const mine = votes.find((v) => v.user_id === userId)?.vote ?? null;
    const theirs = votes.find((v) => v.user_id !== userId)?.vote ?? null;
    let match: CouplesItem["match"] = null;
    let answers: CouplesItem["answers"] = null;
    if (r.kind === "idea" && mine && theirs) {
      // Only a match is ever shown: a "no" (or a lone yes) looks exactly like not having voted.
      if (mine === "yes" && theirs === "yes") match = "yes";
      else if (mine !== "no" && theirs !== "no") match = "maybe";
    }
    if (r.kind === "question" && mine !== null && theirs !== null) answers = Object.fromEntries(votes.map((v) => [v.user_id, Number(v.vote)]));
    return {
      id: r.id,
      conversationId: r.conversation_id,
      kind: r.kind,
      authorId: r.author_id,
      body: r.opened_at ? "" : r.body,
      keyVersion: r.key_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      myVote: r.kind === "idea" || r.kind === "question" ? mine : null,
      match,
      partnerAnswered: r.kind === "question" && theirs !== null,
      answers,
      opened: !!r.opened_at,
      fileSize: r.opened_at ? null : r.file_size,
      deliverAt: r.deliver_at,
    };
  }

  private row(cid: number, itemId: number): ItemRow {
    const r = this.db.prepare("SELECT * FROM couples_items WHERE id = ? AND conversation_id = ?").get(itemId, cid) as ItemRow | undefined;
    if (!r) throw new HttpError(404, "No such item");
    return r;
  }

  private checkBody(cid: number, body: unknown, keyVersion: unknown): number {
    const latest = this.keyVersion(cid);
    if (keyVersion !== latest) throw new HttpError(409, "The conversation key changed; reload and try again");
    if (!isCiphertext(body)) throw new HttpError(400, "That isn't an encrypted couples kit item");
    return latest;
  }

  /**
   * Adds an item. Photos come with their encrypted file (already saved under `file`); notes can
   * have a delivery time up to a year ahead.
   */
  add(
    cid: number,
    userId: number,
    input: { kind?: unknown; body?: unknown; keyVersion?: unknown; deliverAt?: unknown },
    file?: { id: string; size: number },
  ): CouplesItem {
    const other = this.requireOn(cid, userId);
    const kind = input.kind as CouplesKind;
    if (!COUPLES_KINDS.includes(kind)) throw new HttpError(400, "Unknown kind");
    if ((kind === "photo") !== !!file) throw new HttpError(400, kind === "photo" ? "A view-once photo needs its picture" : "Only photos have files");
    const version = this.checkBody(cid, input.body, input.keyVersion);
    let deliverAt: string | null = null;
    if (input.deliverAt !== undefined && input.deliverAt !== null && input.deliverAt !== "") {
      if (kind !== "note") throw new HttpError(400, "Only love notes can be scheduled");
      const t = typeof input.deliverAt === "string" ? Date.parse(input.deliverAt) : NaN;
      if (!Number.isFinite(t)) throw new HttpError(400, "deliverAt is a date and time");
      if (t > Date.now() + COUPLES_LIMITS.noteDays * 86_400_000) throw new HttpError(400, `Love notes can be scheduled up to ${COUPLES_LIMITS.noteDays} days ahead`);
      if (t > Date.now()) deliverAt = new Date(t).toISOString();
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM couples_items WHERE conversation_id = ?").get(cid) as { n: number }).n;
    if (count >= COUPLES_LIMITS.itemsPerKit) throw new HttpError(400, `A couples kit can hold up to ${COUPLES_LIMITS.itemsPerKit} things`);
    const t = now();
    const res = this.db
      .prepare(
        `INSERT INTO couples_items (conversation_id, kind, author_id, body, key_version, file, file_size, deliver_at, notified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(cid, kind, userId, input.body as string, version, file?.id ?? null, file?.size ?? null, deliverAt, deliverAt ? null : t, t, t);
    const item = this.row(cid, Number(res.lastInsertRowid));
    // A note sent straight away pops up for the other person now; a scheduled one at its time.
    this.changed(cid, kind === "note" && !deliverAt ? { to: other, from: userId } : undefined);
    if (kind === "note" && !deliverAt) this.notify([other].filter((u) => !this.gateway.isOnline(u)));
    return this.view(item, userId, []);
  }

  /** Changes a card, spinner or countdown that you added. */
  edit(cid: number, userId: number, itemId: number, input: { body?: unknown; keyVersion?: unknown }): CouplesItem {
    this.requireOn(cid, userId);
    const r = this.row(cid, itemId);
    if (!EDITABLE.has(r.kind)) throw new HttpError(400, "That can't be changed; delete it and add it again");
    const version = this.checkBody(cid, input.body, input.keyVersion);
    // The author on record stays (the encryption is bound to them), so an edit is re-encrypted as them.
    if (r.author_id !== userId) throw new HttpError(403, "Only whoever added it can change it");
    this.db.prepare("UPDATE couples_items SET body = ?, key_version = ?, updated_at = ? WHERE id = ?").run(input.body as string, version, now(), itemId);
    this.changed(cid);
    return this.view(this.row(cid, itemId), userId, []);
  }

  /** Deletes an item. Either person can, except an unsent note, which only its writer sees. */
  remove(cid: number, userId: number, itemId: number, at = new Date()): void {
    this.requireOn(cid, userId);
    const r = this.row(cid, itemId);
    if (!this.visibleTo(r, userId, at)) throw new HttpError(404, "No such item");
    this.db.prepare("DELETE FROM couples_items WHERE id = ?").run(itemId);
    if (r.file) this.removeFiles([r.file]);
    this.changed(cid);
  }

  /** Votes on an idea (yes / no / maybe) or answers a question (an option's number). null takes it back. */
  vote(cid: number, userId: number, itemId: number, vote: unknown): CouplesItem {
    this.requireOn(cid, userId);
    const r = this.row(cid, itemId);
    if (r.kind === "idea") {
      if (vote !== null && !IDEA_VOTES.has(vote as string)) throw new HttpError(400, "Vote yes, no or maybe");
    } else if (r.kind === "question") {
      if (vote !== null && !(Number.isInteger(vote) && (vote as number) >= 0 && (vote as number) < COUPLES_LIMITS.questionOptions)) {
        throw new HttpError(400, "Pick one of the answers");
      }
      // Once both have answered, the answers are out: they can't be changed after seeing the other's.
      const answered = (this.db.prepare("SELECT COUNT(*) AS n FROM couples_votes WHERE item_id = ?").get(itemId) as { n: number }).n;
      if (answered >= 2) throw new HttpError(409, "You've both answered this one");
    } else throw new HttpError(400, "Only ideas and questions take votes");
    if (vote === null) this.db.prepare("DELETE FROM couples_votes WHERE item_id = ? AND user_id = ?").run(itemId, userId);
    else
      this.db
        .prepare("INSERT INTO couples_votes (item_id, user_id, vote, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (item_id, user_id) DO UPDATE SET vote = excluded.vote")
        .run(itemId, userId, String(vote), now());
    this.changed(cid);
    const votes = this.db.prepare("SELECT user_id, vote FROM couples_votes WHERE item_id = ?").all(itemId) as { user_id: number; vote: string }[];
    return this.view(r, userId, votes);
  }

  /**
   * Opens a view-once photo: only the person it was sent to, only once. Returns the encrypted
   * file's name on disk; the caller sends it and then calls photoOpened to delete it.
   */
  openPhoto(cid: number, userId: number, itemId: number): string {
    this.requireOn(cid, userId);
    const r = this.row(cid, itemId);
    if (r.kind !== "photo") throw new HttpError(404, "No such photo");
    if (r.author_id === userId) throw new HttpError(403, "View-once photos can only be opened by the person they were sent to");
    if (r.opened_at || !r.file) throw new HttpError(410, "This photo was already opened");
    // Marked first, so two requests at once can't both get it.
    const res = this.db.prepare("UPDATE couples_items SET opened_at = ?, updated_at = ? WHERE id = ? AND opened_at IS NULL").run(now(), now(), itemId);
    if (Number(res.changes) === 0) throw new HttpError(410, "This photo was already opened");
    return r.file;
  }

  /** After an opened photo was sent: deletes the file and the encrypted details. */
  photoOpened(cid: number, itemId: number, file: string): void {
    this.db.prepare("UPDATE couples_items SET file = NULL, file_size = NULL, body = '' WHERE id = ?").run(itemId);
    this.removeFiles([file]);
    this.changed(cid);
  }

  // ---- Delivery ------------------------------------------------------------------------

  /** Tells people about love notes whose time has come. */
  tick(at = new Date()): void {
    const due = this.db
      .prepare("SELECT id, conversation_id, author_id FROM couples_items WHERE deliver_at IS NOT NULL AND notified_at IS NULL AND deliver_at <= ?")
      .all(at.toISOString()) as { id: number; conversation_id: number; author_id: number }[];
    for (const d of due) {
      this.db.prepare("UPDATE couples_items SET notified_at = ? WHERE id = ?").run(at.toISOString(), d.id);
      const to = this.memberIds(d.conversation_id).filter((u) => u !== d.author_id);
      this.changed(d.conversation_id, to[0] ? { to: to[0], from: d.author_id } : undefined);
      this.notify(to.filter((u) => !this.gateway.isOnline(u)));
    }
  }

  /** Tells both people to fetch their view again (each sees their own). */
  private changed(cid: number, note?: { to: number; from: number }): void {
    for (const uid of this.memberIds(cid)) {
      this.gateway.send([uid], note && note.to === uid ? { type: "couples.updated", conversationId: cid, noteFrom: note.from } : { type: "couples.updated", conversationId: cid });
    }
  }
}
