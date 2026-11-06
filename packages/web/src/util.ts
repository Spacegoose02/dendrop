import type { Conversation, Message } from "@dendrop/shared";

/** Messages per conversation, oldest first, plus whether older ones remain on the server. */
export interface History {
  messages: Message[];
  hasMore: boolean;
}

export const conversationTitle = (c: Conversation, meId: number): string =>
  c.name ??
  (c.members
    .filter((m) => m.id !== meId)
    .map((m) => m.displayName)
    .join(", ") ||
    "Just you");

