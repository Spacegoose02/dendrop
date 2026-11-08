import {
  CUSTOM_EMOJI_RE,
  EXPRESSION_LIMITS,
  findBlockedWords,
  isEmojiName,
  isUnicodeEmoji,
  type CustomEmoji,
  type Reaction,
  type ServerSound,
  type Sticker,
} from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";

interface EmojiRow {
  id: number;
  server_id: number;
  name: string;
  file: string;
  content_type: string;
  animated: number;
  created_by: number | null;
  created_at: string;
}

interface StickerRow extends EmojiRow {
  description: string;
  emoji: string;
}

interface SoundRow {
  id: number;
  server_id: number;
  name: string;
  emoji: string;
  volume: number;
  file: string;
  content_type: string;
  created_by: number | null;
  created_at: string;
}

const toSound = (r: SoundRow): ServerSound => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  emoji: r.emoji,
  volume: r.volume,
  url: `/api/sounds/${r.id}`,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

interface ReactionRow {
  message_id: number;
  user_id: number;
  emoji: string;
  custom_name: string | null;
  custom_animated: number;
}

const toEmoji = (r: EmojiRow): CustomEmoji => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  animated: !!r.animated,
  url: `/api/emojis/${r.id}`,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const toSticker = (r: StickerRow): Sticker => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  description: r.description,
  emoji: r.emoji,
  animated: !!r.animated,
  url: `/api/stickers/${r.id}`,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** The picture types emoji and stickers can be, found from the bytes (never trusting the upload's type). */
export type PictureType = "image/png" | "image/gif" | "image/webp" | "image/jpeg";

/**
 * What a picture really is, and whether it moves: GIFs with more than one frame, animated PNGs
 * (an acTL chunk) and animated WebPs (an ANIM chunk). Undefined when it isn't a picture we take.
 */
export function sniffPicture(buf: Buffer): { type: PictureType; animated: boolean } | undefined {
  if (buf.length < 12) return undefined;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const idat = buf.indexOf("IDAT");
    const actl = buf.indexOf("acTL");
    return { type: "image/png", animated: actl > 0 && (idat < 0 || actl < idat) };
  }
  if (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a") {
    return { type: "image/gif", animated: gifFrames(buf) > 1 };
  }
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return { type: "image/webp", animated: buf.indexOf("ANIM") > 0 };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: "image/jpeg", animated: false };
  return undefined;
}

/** Counts a GIF's frames by walking its blocks. */
function gifFrames(buf: Buffer): number {
  let i = 13;
  const flags = buf[10] ?? 0;
  if (flags & 0x80) i += 3 * 2 ** ((flags & 7) + 1);
  let frames = 0;
  const skipSubBlocks = () => {
    while (i < buf.length) {
      const n = buf[i]!;
      i += 1;
      if (n === 0) return;
      i += n;
    }
  };
  while (i < buf.length) {
    const b = buf[i]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      i += 2;
      skipSubBlocks();
    } else if (b === 0x2c) {
      frames++;
      if (frames > 1) return frames;
      const f = buf[i + 9] ?? 0;
      i += 10;
      if (f & 0x80) i += 3 * 2 ** ((f & 7) + 1);
      i += 1; // LZW minimum code size
      skipSubBlocks();
    } else break;
  }
  return frames;
}

/** The sound types the soundboard takes, found from the bytes. */
export type SoundType = "audio/mpeg" | "audio/ogg" | "audio/wav";

/** What a sound really is: MP3 (with or without an ID3 tag), Ogg (Opus or Vorbis) or WAV. */
export function sniffSound(buf: Buffer): SoundType | undefined {
  if (buf.length < 12) return undefined;
  if (buf.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE") return "audio/wav";
  if (buf.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg";
  // An MPEG audio frame: 11 sync bits, then a layer that isn't "reserved".
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0 && (buf[1]! & 0x06) !== 0) return "audio/mpeg";
  return undefined;
}

const cleanName = (name: unknown): string => {
  if (!isEmojiName(name)) throw new HttpError(400, "Names are 2 to 32 letters, numbers or _ (like happy_raccoon)");
  // Emoji names show to everyone, kids included, so they go through the built-in word filter.
  if (findBlockedWords(name.replace(/_/g, " "), []).length) throw new HttpError(400, "Pick a different name: that one has a blocked word");
  return name;
};

/**
 * Custom emoji and stickers (per server), and reactions on messages.
 *
 * Emoji and sticker pictures can be seen by anyone signed in, because they travel inside
 * messages (DMs and other servers too) as tokens like <:raccoon:12>.
 */
export class ExpressionRepo {
  constructor(private readonly db: Db) {}

  // ---- Emoji -----------------------------------------------------------------------

  emojis(serverId: number): CustomEmoji[] {
    return (this.db.prepare("SELECT * FROM server_emojis WHERE server_id = ? ORDER BY name COLLATE NOCASE").all(serverId) as unknown as EmojiRow[]).map(toEmoji);
  }

  emojiRow(id: number): EmojiRow | undefined {
    return this.db.prepare("SELECT * FROM server_emojis WHERE id = ?").get(id) as EmojiRow | undefined;
  }

  addEmoji(serverId: number, by: number, name: unknown, file: string, picture: { type: PictureType; animated: boolean }): CustomEmoji {
    const clean = cleanName(name);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM server_emojis WHERE server_id = ? AND animated = ?").get(serverId, picture.animated ? 1 : 0) as { n: number }).n;
    const max = picture.animated ? EXPRESSION_LIMITS.animatedEmojis : EXPRESSION_LIMITS.emojis;
    if (count >= max) throw new HttpError(400, `A server can have up to ${max} ${picture.animated ? "animated" : "still"} emoji`);
    this.nameFree("server_emojis", serverId, clean);
    const res = this.db
      .prepare("INSERT INTO server_emojis (server_id, name, file, content_type, animated, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(serverId, clean, file, picture.type, picture.animated ? 1 : 0, by, now());
    return toEmoji(this.emojiRow(Number(res.lastInsertRowid))!);
  }

  renameEmoji(serverId: number, id: number, name: unknown): CustomEmoji {
    const r = this.emojiRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such emoji");
    const clean = cleanName(name);
    if (clean.toLowerCase() !== r.name.toLowerCase()) this.nameFree("server_emojis", serverId, clean);
    this.db.prepare("UPDATE server_emojis SET name = ? WHERE id = ?").run(clean, id);
    return toEmoji(this.emojiRow(id)!);
  }

  /** Returns the picture's file, to remove from disk. */
  deleteEmoji(serverId: number, id: number): string {
    const r = this.emojiRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such emoji");
    this.db.prepare("DELETE FROM server_emojis WHERE id = ?").run(id);
    return r.file;
  }

  // ---- Stickers ----------------------------------------------------------------------

  stickers(serverId: number): Sticker[] {
    return (this.db.prepare("SELECT * FROM server_stickers WHERE server_id = ? ORDER BY id").all(serverId) as unknown as StickerRow[]).map(toSticker);
  }

  stickerRow(id: number): StickerRow | undefined {
    return this.db.prepare("SELECT * FROM server_stickers WHERE id = ?").get(id) as StickerRow | undefined;
  }

  private stickerFields(input: { description?: unknown; emoji?: unknown }, current?: StickerRow): { description: string; emoji: string } {
    let description = current?.description ?? "";
    let emoji = current?.emoji ?? "";
    if (input.description !== undefined) {
      if (typeof input.description !== "string" || input.description.trim().length > EXPRESSION_LIMITS.stickerDescription) {
        throw new HttpError(400, `A description is up to ${EXPRESSION_LIMITS.stickerDescription} characters`);
      }
      description = input.description.trim();
      if (findBlockedWords(description, []).length) throw new HttpError(400, "That description has a blocked word");
    }
    if (input.emoji !== undefined) {
      if (input.emoji !== "" && !isUnicodeEmoji(input.emoji)) throw new HttpError(400, "Pick one emoji that goes with the sticker");
      emoji = input.emoji as string;
    }
    return { description, emoji };
  }

  addSticker(serverId: number, by: number, input: { name?: unknown; description?: unknown; emoji?: unknown }, file: string, picture: { type: PictureType; animated: boolean }): Sticker {
    const name = cleanName(input.name);
    const { description, emoji } = this.stickerFields(input);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM server_stickers WHERE server_id = ?").get(serverId) as { n: number }).n;
    if (count >= EXPRESSION_LIMITS.stickers) throw new HttpError(400, `A server can have up to ${EXPRESSION_LIMITS.stickers} stickers`);
    this.nameFree("server_stickers", serverId, name);
    const res = this.db
      .prepare("INSERT INTO server_stickers (server_id, name, description, emoji, file, content_type, animated, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(serverId, name, description, emoji, file, picture.type, picture.animated ? 1 : 0, by, now());
    return toSticker(this.stickerRow(Number(res.lastInsertRowid))!);
  }

  updateSticker(serverId: number, id: number, input: { name?: unknown; description?: unknown; emoji?: unknown }): Sticker {
    const r = this.stickerRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such sticker");
    const name = input.name === undefined ? r.name : cleanName(input.name);
    if (name.toLowerCase() !== r.name.toLowerCase()) this.nameFree("server_stickers", serverId, name);
    const { description, emoji } = this.stickerFields(input, r);
    this.db.prepare("UPDATE server_stickers SET name = ?, description = ?, emoji = ? WHERE id = ?").run(name, description, emoji, id);
    return toSticker(this.stickerRow(id)!);
  }

  deleteSticker(serverId: number, id: number): string {
    const r = this.stickerRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such sticker");
    this.db.prepare("DELETE FROM server_stickers WHERE id = ?").run(id);
    return r.file;
  }

  // ---- Soundboard ----------------------------------------------------------------------

  sounds(serverId: number): ServerSound[] {
    return (this.db.prepare("SELECT * FROM server_sounds WHERE server_id = ? ORDER BY id").all(serverId) as unknown as SoundRow[]).map(toSound);
  }

  soundRow(id: number): SoundRow | undefined {
    return this.db.prepare("SELECT * FROM server_sounds WHERE id = ?").get(id) as SoundRow | undefined;
  }

  sound(id: number): ServerSound | undefined {
    const r = this.soundRow(id);
    return r && toSound(r);
  }

  private soundFields(input: { emoji?: unknown; volume?: unknown }, current?: SoundRow): { emoji: string; volume: number } {
    let emoji = current?.emoji ?? "";
    let volume = current?.volume ?? 100;
    if (input.emoji !== undefined) {
      if (input.emoji !== "" && !isUnicodeEmoji(input.emoji)) throw new HttpError(400, "Pick one emoji for the sound's button");
      emoji = input.emoji as string;
    }
    if (input.volume !== undefined && input.volume !== "") {
      const v = Number(input.volume);
      if (!Number.isInteger(v) || v < 1 || v > 100) throw new HttpError(400, "Volume is 1 to 100");
      volume = v;
    }
    return { emoji, volume };
  }

  addSound(serverId: number, by: number, input: { name?: unknown; emoji?: unknown; volume?: unknown }, file: string, type: SoundType): ServerSound {
    const name = cleanName(input.name);
    const { emoji, volume } = this.soundFields(input);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM server_sounds WHERE server_id = ?").get(serverId) as { n: number }).n;
    if (count >= EXPRESSION_LIMITS.sounds) throw new HttpError(400, `A server can have up to ${EXPRESSION_LIMITS.sounds} sounds`);
    this.nameFree("server_sounds", serverId, name);
    const res = this.db
      .prepare("INSERT INTO server_sounds (server_id, name, emoji, volume, file, content_type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(serverId, name, emoji, volume, file, type, by, now());
    return toSound(this.soundRow(Number(res.lastInsertRowid))!);
  }

  updateSound(serverId: number, id: number, input: { name?: unknown; emoji?: unknown; volume?: unknown }): ServerSound {
    const r = this.soundRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such sound");
    const name = input.name === undefined ? r.name : cleanName(input.name);
    if (name.toLowerCase() !== r.name.toLowerCase()) this.nameFree("server_sounds", serverId, name);
    const { emoji, volume } = this.soundFields(input, r);
    this.db.prepare("UPDATE server_sounds SET name = ?, emoji = ?, volume = ? WHERE id = ?").run(name, emoji, volume, id);
    return toSound(this.soundRow(id)!);
  }

  deleteSound(serverId: number, id: number): string {
    const r = this.soundRow(id);
    if (!r || r.server_id !== serverId) throw new HttpError(404, "No such sound");
    this.db.prepare("DELETE FROM server_sounds WHERE id = ?").run(id);
    return r.file;
  }

  /** Every emoji, sticker and sound file of a server, for when it's deleted. */
  files(serverId: number): string[] {
    return [
      ...(this.db.prepare("SELECT file FROM server_emojis WHERE server_id = ?").all(serverId) as { file: string }[]),
      ...(this.db.prepare("SELECT file FROM server_stickers WHERE server_id = ?").all(serverId) as { file: string }[]),
      ...(this.db.prepare("SELECT file FROM server_sounds WHERE server_id = ?").all(serverId) as { file: string }[]),
    ].map((r) => r.file);
  }

  private nameFree(table: "server_emojis" | "server_stickers" | "server_sounds", serverId: number, name: string): void {
    if (this.db.prepare(`SELECT 1 FROM ${table} WHERE server_id = ? AND name = ? COLLATE NOCASE`).get(serverId, name)) {
      const what = table === "server_emojis" ? "an emoji" : table === "server_stickers" ? "a sticker" : "a sound";
      throw new HttpError(409, `This server already has ${what} called ${name}`);
    }
  }

  // ---- Reactions -----------------------------------------------------------------------

  /** Reactions for some messages, by message id. */
  reactions(messageIds: number[]): Map<number, Reaction[]> {
    const out = new Map<number, Reaction[]>();
    if (!messageIds.length) return out;
    const rows = this.db
      .prepare(`SELECT * FROM message_reactions WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY rowid`)
      .all(...messageIds) as unknown as ReactionRow[];
    for (const r of rows) {
      const list = out.get(r.message_id) ?? [];
      const key = r.emoji.startsWith("c:") ? `<${r.custom_animated ? "a" : ""}:${r.custom_name}:${r.emoji.slice(2)}>` : r.emoji;
      const existing = list.find((x) => x.emoji === key);
      if (existing) {
        existing.count++;
        existing.userIds.push(r.user_id);
      } else list.push({ emoji: key, count: 1, userIds: [r.user_id] });
      out.set(r.message_id, list);
    }
    return out;
  }

  /**
   * Reads a reaction: an emoji, or a custom emoji's token. A custom emoji has to still exist,
   * and `userId` has to be in its server (the same rule as using it in a message).
   */
  parseReaction(emoji: unknown, userId: number): { key: string; customName: string | null; animated: boolean } {
    if (isUnicodeEmoji(emoji)) return { key: emoji, customName: null, animated: false };
    const m = typeof emoji === "string" ? new RegExp(`^${CUSTOM_EMOJI_RE.source}$`).exec(emoji) : null;
    if (!m) throw new HttpError(400, "That isn't an emoji");
    const row = this.emojiRow(Number(m[3]));
    if (!row) throw new HttpError(404, "That emoji was deleted");
    if (!this.db.prepare("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?").get(row.server_id, userId)) {
      throw new HttpError(403, "That emoji belongs to a server you're not in");
    }
    return { key: `c:${row.id}`, customName: row.name, animated: !!row.animated };
  }

  /** Adds a reaction (again is fine). */
  react(messageId: number, userId: number, emoji: unknown): void {
    const r = this.parseReaction(emoji, userId);
    tx(this.db, () => {
      const kinds = this.db.prepare("SELECT DISTINCT emoji FROM message_reactions WHERE message_id = ?").all(messageId) as { emoji: string }[];
      if (!kinds.some((k) => k.emoji === r.key) && kinds.length >= EXPRESSION_LIMITS.reactionsPerMessage) {
        throw new HttpError(400, `A message can have up to ${EXPRESSION_LIMITS.reactionsPerMessage} different reactions`);
      }
      this.db
        .prepare("INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, custom_name, custom_animated, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(messageId, userId, r.key, r.customName, r.animated ? 1 : 0, now());
    });
  }

  /** Takes a reaction back. Anyone can take back their own, even of an emoji since deleted. */
  unreact(messageId: number, userId: number, emoji: unknown): void {
    let key: string;
    const m = typeof emoji === "string" ? new RegExp(`^${CUSTOM_EMOJI_RE.source}$`).exec(emoji) : null;
    if (m) key = `c:${Number(m[3])}`;
    else if (isUnicodeEmoji(emoji)) key = emoji;
    else throw new HttpError(400, "That isn't an emoji");
    this.db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(messageId, userId, key);
  }

  /** Moderators clear every reaction on a message (or one emoji's). */
  clearReactions(messageId: number): void {
    this.db.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(messageId);
  }
}
