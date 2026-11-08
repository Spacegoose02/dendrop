import { LIMITS, type SearchHit, type SearchResults } from "@dendrop/shared";
import type { ConversationRepo } from "./conversations.js";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";

export interface SearchQuery {
  q?: unknown;
  conversationId?: unknown;
  serverId?: unknown;
  authorId?: unknown;
  /** "file", "link" or "image". */
  has?: unknown;
  /** Message id to page from (exclusive). */
  before?: unknown;
}

const optId = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Bad ${what}`);
  return n;
};

/**
 * Turns what someone typed into an FTS5 query: each word must appear ("quoted phrases" stay
 * together), and the last word matches as a prefix, so results show while typing. FTS5 syntax
 * people type by accident (AND, NEAR, column:, *) is treated as plain words.
 */
export function ftsQuery(input: string): string {
  const parts: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  let lastBare = false;
  while ((m = re.exec(input))) {
    const raw = (m[1] ?? m[2] ?? "").replace(/"/g, "");
    // Keep letters, numbers and joiners; everything else separates words.
    const words = raw.split(/[^\p{L}\p{N}_'’-]+/u).filter(Boolean);
    if (!words.length) continue;
    parts.push(`"${words.join(" ")}"`);
    lastBare = m[1] === undefined;
  }
  if (parts.length && lastBare) parts[parts.length - 1] += "*";
  return parts.join(" ");
}

/**
 * Message search over everything the person can read that isn't end-to-end encrypted: DMs and
 * group chats without a key yet, and server channels and threads they can see (locked
 * channels follow conversation membership). Encrypted chats are searched on the device.
 */
export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly convos: ConversationRepo,
  ) {}

  search(userId: number, query: SearchQuery): SearchResults {
    const text = typeof query.q === "string" ? query.q.trim().slice(0, LIMITS.searchQuery) : "";
    const match = text ? ftsQuery(text) : "";
    const conversationId = optId(query.conversationId, "conversationId");
    const serverId = optId(query.serverId, "serverId");
    const authorId = optId(query.authorId, "authorId");
    const before = optId(query.before, "before");
    const has = query.has === undefined || query.has === "" ? null : String(query.has);
    if (has && !["file", "link", "image"].includes(has)) throw new HttpError(400, "has is file, link or image");
    if (!match && !authorId && !has) throw new HttpError(400, "Type something to search for");

    const where: string[] = ["m.deleted_at IS NULL", "m.key_version IS NULL"];
    const args: (string | number)[] = [userId];
    if (match) {
      where.push("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
      args.push(match);
    }
    if (conversationId) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    }
    if (serverId) {
      where.push("m.conversation_id IN (SELECT conversation_id FROM channel_conversations WHERE server_id = ?)");
      args.push(serverId);
    }
    if (authorId) {
      where.push("m.author_id = ? AND m.webhook_name IS NULL");
      args.push(authorId);
    }
    if (before) {
      where.push("m.id < ?");
      args.push(before);
    }
    if (has === "file") where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)");
    if (has === "image") where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')");
    if (has === "link") where.push("(m.body LIKE '%http://%' OR m.body LIKE '%https://%')");
    const n = LIMITS.searchPage;
    let rows: { id: number }[];
    try {
      rows = this.db
        .prepare(
          `SELECT m.id FROM messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
           WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ${n + 1}`,
        )
        .all(...args) as { id: number }[];
    } catch {
      throw new HttpError(400, "Couldn't search for that; try other words");
    }
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const place = this.db.prepare("SELECT channel_id, server_id, thread_id FROM channel_conversations WHERE conversation_id = ?");
    const hits = page.flatMap((r): SearchHit[] => {
      const message = this.convos.message(r.id);
      if (!message) return [];
      const p = place.get(message.conversationId) as { channel_id: number; server_id: number; thread_id: number | null } | undefined;
      return [{ message, serverId: p?.server_id ?? null, channelId: p?.channel_id ?? null, threadId: p?.thread_id ?? null }];
    });
    return { hits, next: more ? page.at(-1)!.id : null };
  }
}
