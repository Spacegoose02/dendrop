/** Types shared by the Dendrop server and its clients. */

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  /**
   * The person's end-to-end encryption public key (P-256, raw, base64url), or null until they
   * set up encryption. Messages are encrypted to it; the server never has the private key.
   */
  publicKey: string | null;
}

export interface Me extends PublicUser {
  email: string | null;
  isSuperAdmin: boolean;
  /** Tell others when you've read their messages. Off means you don't see theirs either. */
  readReceipts: boolean;
  /** Can make chat servers: super admins always, everyone else once a super admin approves them. */
  canCreateServers: boolean;
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
  /** End-to-end encryption, or null while the conversation has no key yet (messages are plain). */
  e2ee: ConversationE2ee | null;
}

export interface ConversationE2ee {
  /** The newest key version. New messages must use it. */
  version: number;
  /** Members who have no copy of the newest key (they reset their keys), so it needs a new version. */
  missing: number[];
}

/** One version of a conversation key, encrypted to one person's public key. */
export interface WrappedKey {
  version: number;
  /** ECIES envelope: an ephemeral public key, IV and ciphertext, all base64url, joined with ".". */
  wrapped: string;
}

/** GET /api/e2ee: your own encryption setup. */
export interface E2eeSetup {
  publicKey: string | null;
  /** Your private key, encrypted with a key made from your chat passphrase (the server can't open it). */
  backup: KeyBackup | null;
}

export interface KeyBackup {
  /** PBKDF2-SHA256 salt and rounds, and the AES-GCM IV and ciphertext of the PKCS#8 private key. base64url. */
  salt: string;
  iterations: number;
  iv: string;
  ciphertext: string;
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
  /**
   * The conversation key version this message is encrypted with, or null for a plain message.
   * When set, `body` is ciphertext (see the web client's e2ee.ts) holding the text and the real
   * file names, and each attachment is stored encrypted under a placeholder name.
   */
  keyVersion: number | null;
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
  /** Voice and video calls work only when the server has LiveKit set up. */
  calls: boolean;
}

/** A call in a conversation. Calls live in memory on the server while they last. */
export interface Call {
  conversationId: number;
  startedBy: number;
  startedAt: string;
  /** Whether the person calling turned their camera on to start with. */
  video: boolean;
  /** People in the call right now. */
  joined: number[];
  /** People being rung who haven't answered or declined. */
  ringing: number[];
}

/** What a client needs to join a call's LiveKit room. */
export interface CallJoin {
  call: Call;
  url: string;
  token: string;
}

// ---- Chat servers ---------------------------------------------------------------------

export type ServerRole = "owner" | "admin" | "member";

/** What anyone may see of a public server (in the directory or an invite), and members of a private one. */
export interface ChatServerSummary {
  id: number;
  name: string;
  description: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  /** Public servers are listed in the directory and anyone signed in can join. Private ones need an invite. */
  isPublic: boolean;
  memberCount: number;
}

/** A server you're in, as you see it. Locked channels you can't see aren't included. */
export interface ChatServer extends ChatServerSummary {
  ownerId: number;
  myRole: ServerRole;
  /** Your nickname here, or null to use your display name. */
  nickname: string | null;
  /** Whether everyone can make invites, or only the owner and admins. */
  memberInvites: boolean;
  channels: Channel[];
  members: ServerMember[];
  createdAt: string;
}

/** Text channels hold messages; voice channels are rooms people drop into to talk (and keep a text chat too). */
export type ChannelKind = "text" | "voice";

export interface Channel {
  id: number;
  serverId: number;
  kind: ChannelKind;
  /**
   * The conversation holding this channel's messages. Messages, files, edits, typing and read
   * markers go through the same /api/conversations/:id endpoints as DMs.
   */
  conversationId: number;
  name: string;
  topic: string;
  position: number;
  /** Locked channels are seen only by the people picked for them, plus the owner and admins. */
  locked: boolean;
  /** For locked channels, who was picked (owners and admins see this; others get []). */
  memberIds: number[];
}

/** Someone in a voice channel, and what they show the others. */
export interface VoiceMember {
  userId: number;
  muted: boolean;
  /** Can't hear the others (and is muted too). */
  deafened: boolean;
  video: boolean;
  screen: boolean;
  joinedAt: string;
}

/** Who is in a voice channel right now. Lives in memory on the server; empty channels aren't listed. */
export interface VoiceChannelState {
  channelId: number;
  serverId: number;
  conversationId: number;
  members: VoiceMember[];
}

/** What a client needs to join a voice channel's LiveKit room. */
export interface VoiceJoin {
  voice: VoiceChannelState;
  url: string;
  token: string;
}

export interface ServerMember {
  user: PublicUser;
  role: ServerRole;
  nickname: string | null;
  joinedAt: string;
}

export interface ServerInvite {
  code: string;
  serverId: number;
  createdBy: number;
  createdAt: string;
  expiresAt: string | null;
  /** null for unlimited. */
  maxUses: number | null;
  uses: number;
  /** Set for an invite sent to one friend; only they can use it. */
  forUserId: number | null;
}

/** What an invite shows before you join. */
export interface InvitePreview {
  code: string;
  server: ChatServerSummary;
  invitedBy: PublicUser | null;
  expiresAt: string | null;
  /** You're already a member. */
  joined: boolean;
}

/** Your request to be allowed to make chat servers. */
export interface ServerCreatorRequest {
  user: PublicUser;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt: string | null;
}

/** A server as a super admin sees it: enough to oversee the instance, never its messages. */
export interface AdminServer extends ChatServerSummary {
  owner: PublicUser | null;
  channelCount: number;
  createdAt: string;
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
  serverName: 48,
  serverDescription: 300,
  channelName: 32,
  channelTopic: 200,
  channelsPerServer: 100,
  serversPerUser: 100,
  serverImageBytes: 5 * 1024 * 1024,
  /** Ciphertext of a full-length message, with room for file names. */
  encryptedBodyLength: 32_000,
} as const;

/** Events the server pushes over the WebSocket gateway at /api/gateway. */
export type ServerEvent =
  | { type: "ready"; user: Me }
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "conversation.created"; conversation: Conversation }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "friend.updated"; friend: Friend }
  | { type: "friend.removed"; userId: number }
  | { type: "typing"; conversationId: number; userId: number }
  | { type: "read"; conversationId: number; userId: number; messageId: number }
  | { type: "call.updated"; call: Call }
  | { type: "call.ended"; conversationId: number; missed: boolean }
  | { type: "presence"; userId: number; online: boolean }
  /** A server you're in changed, or you joined it. Each member gets their own view. */
  | { type: "server.updated"; server: ChatServer }
  /** You left or were removed, or the server was deleted. */
  | { type: "server.removed"; serverId: number }
  /** A friend invited you to a server. */
  | { type: "server.invited"; invite: InvitePreview }
  /** Your request to make servers was approved or denied; to super admins, a new or decided request. */
  | { type: "server.request"; request: ServerCreatorRequest }
  /** Someone joined, left or changed state in a voice channel you can see (or you were taken out of one). */
  | { type: "voice.updated"; voice: VoiceChannelState };

/** Events a client sends over the gateway. Everything else goes through the HTTP API. */
export type ClientEvent = { type: "typing"; conversationId: number } | { type: "ping" };

export const isUsername = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 2 && s.length <= LIMITS.usernameLength && /^[\w.-]+$/.test(s);
