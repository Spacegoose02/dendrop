import type { Conversation } from "@dendrop/shared";
import type { ChatMessage } from "./e2ee.ts";

/** Messages per conversation, oldest first, plus whether older ones remain on the server. */
export interface History {
  messages: ChatMessage[];
  hasMore: boolean;
}

export const conversationTitle = (c: Conversation, meId: number): string =>
  c.name ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(", ") ||
    "Just you");


/** Adds or replaces a message, keeping the list in id order (decrypting can finish out of order). */
export const upsert = (list: ChatMessage[], m: ChatMessage): ChatMessage[] =>
  list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m].sort((a, b) => a.id - b.id);
