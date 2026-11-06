/** Types shared by the Dendrop server and its clients. */

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
}

export interface Me extends PublicUser {
  email: string | null;
  isSuperAdmin: boolean;
  /** Tell others when you've read their messages. Off means you don't see theirs either. */
  readReceipts: boolean;
}

export type FriendState = "friends" | "incoming" | "outgoing";

export interface Friend {
  user: PublicUser;
  state: FriendState;
  since: string;
  /** Whether an accepted friend is connected right now. */
  online?: boolean;
}

export interface ReadState {
  userId: number;
  /** The newest message this person has seen, or null before they've opened the conversation. */
  messageId: number | null;
}

export interface Conversation {
  id: number;
  /** True for a group DM (more than two people, or named). */
  isGroup: boolean;
  name: string | null;
  members: PublicUser[];
  lastMessageAt: string | null;
  createdAt: string;
  reads: ReadState[];
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  /** Where to download it; pictures can be shown inline from here. */
  url: string;
}

export interface Message {
  id: number;
  conversationId: number;
  authorId: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  /** Deleted messages keep their place in the history but lose their text and files. */
  deleted: boolean;
  attachments: Attachment[];
}

export interface AuthInfo {
  /** True until the first account (the super admin) has been made. */
  needsSetup: boolean;
  oidc: { enabled: boolean; name: string };
  localLogin: boolean;
  signup: boolean;
}

/** GET /api/server: what this server allows, for signed-in clients. */
export interface ServerInfo {
  maxUploadBytes: number;
}

/** Pictures the web client shows inline. Everything else is offered as a download. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Limits that the server and clients both check. */
export const LIMITS = {
  messageLength: 4000,
  groupMembers: 10,
  attachmentsPerMessage: 10,
  usernameLength: 32,
  displayNameLength: 64,
  pageSize: 50,
} as const;

/** Events the server pushes over the WebSocket gateway at /api/gateway. */
export type ServerEvent =
  | { type: "ready"; user: Me }
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "conversation.created"; conversation: Conversation }
  | { type: "friend.updated"; friend: Friend }
  | { type: "friend.removed"; userId: number }
  | { type: "typing"; conversationId: number; userId: number }
  | { type: "read"; conversationId: number; userId: number; messageId: number }
  | { type: "presence"; userId: number; online: boolean };

/** Events a client sends over the gateway. Everything else goes through the HTTP API. */
export type ClientEvent = { type: "typing"; conversationId: number } | { type: "ping" };

export const isUsername = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 2 && s.length <= LIMITS.usernameLength && /^[\w.-]+$/.test(s);
