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
  /** The color their name is shown in (#rrggbb), or null for the theme's default. */
  nameColor: string | null;
  /** The color their messages are shown in (#rrggbb), or null for the theme's default. */
  textColor: string | null;
}

export interface Me extends PublicUser {
  email: string | null;
  isSuperAdmin: boolean;
  /** Tell others when you've read their messages. Off means you don't see theirs either. */
  readReceipts: boolean;
  /** Can make chat servers: super admins always, everyone else once a super admin approves them. */
  canCreateServers: boolean;
  /** A kid account: linked to at least one parent, with kid-safe rules. */
  isKid: boolean;
  /** Show friends and server-mates what you're playing (from LootDen). */
  shareActivity: boolean;
}

/** "held": both said yes, but a kid's parent still has to approve it before they can chat. */
export type FriendState = "friends" | "incoming" | "outgoing" | "held";

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
  /**
   * Parents of the kids in this conversation (who aren't in it themselves). Conversation keys
   * are wrapped for them too, so they can read it while one of their alerts about it is open.
   * Shown to everyone in the conversation, so nobody is surprised.
   */
  guardians: PublicUser[];
}

export interface ConversationE2ee {
  /** The newest key version. New messages must use it. */
  version: number;
  /**
   * Members and guardians who have no copy of the newest key (they reset their keys, or a
   * parent was linked since), so it needs a new version.
   */
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
  /** Set when an incoming webhook posted it (LootDen alerts, a script...): shown under this name. */
  webhook: { id: number | null; name: string } | null;
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
  /** LootDen's address when it's linked, so links to its games can show a card. */
  lootdenUrl: string | null;
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
  /** Open a voice channel while two or more members play the same game (from LootDen). */
  playTogether: boolean;
  channels: Channel[];
  members: ServerMember[];
  createdAt: string;
  /** Set while automod or a moderator has timed you out here: you can read but not post or talk. */
  timedOutUntil: string | null;
}

// ---- Automod --------------------------------------------------------------------------

/**
 * What automod does when a rule is hit. block: the message isn't posted. alert: the owner and
 * admins are told right away. timeout: the sender can't post or talk in the server for a while
 * (the message that set it off isn't posted either). Every hit is written to the automod log.
 */
export type AutomodAction = "block" | "alert" | "timeout";

export type AutomodRuleKind = "words" | "spam" | "links" | "newAccounts";

/** What every rule has. */
export interface AutomodRuleBase {
  enabled: boolean;
  actions: AutomodAction[];
  /** How long a timeout from this rule lasts. */
  timeoutMinutes: number;
  /** Roles the rule leaves alone. The owner and admins are exempt by default. */
  exemptRoles: ServerRole[];
  /** Channels the rule leaves alone. */
  exemptChannelIds: number[];
}

export interface AutomodSettings {
  /** Blocked words, using the same filter as kid-safe chat (catches f*ck, sh1t, fuuuck). */
  words: AutomodRuleBase & { useBuiltinList: boolean; words: string[] };
  /** Flooding: too many messages too fast, the same message over and over, or too many @mentions. */
  spam: AutomodRuleBase & { maxMessages: number; perSeconds: number; maxDuplicates: number; maxMentions: number };
  /** Links, except to the domains listed (and this Dendrop's own address). */
  links: AutomodRuleBase & { allowedDomains: string[] };
  /** Brand new accounts, or people who only just joined, can't post yet. */
  newAccounts: AutomodRuleBase & { minAccountAgeHours: number; minMemberMinutes: number };
}

/** One entry in a server's automod log. */
export interface AutomodEvent {
  id: number;
  serverId: number;
  user: PublicUser | null;
  channelId: number | null;
  rule: AutomodRuleKind;
  actions: AutomodAction[];
  /** Why, in words: "Blocked word: darn", "6 messages in 5 seconds". */
  reason: string;
  /** The start of the message, so moderators can see what was caught. */
  excerpt: string;
  createdAt: string;
}

/** Someone who can't post or talk in a server for now. */
export interface ServerTimeout {
  user: PublicUser;
  until: string;
  reason: string;
  /** Who set it, or null for automod. */
  by: PublicUser | null;
}

export const AUTOMOD_LIMITS = {
  words: 300,
  wordLength: 40,
  domains: 100,
  timeoutMinutes: 7 * 24 * 60,
  logSize: 500,
} as const;

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

// ---- Kid-safe chat ---------------------------------------------------------------------

/** What a kid account may do. Set by the kid's parents. */
export interface KidRules {
  /** Hide swear words in what the kid reads, and stop them sending them. */
  profanityFilter: boolean;
  /** Extra words to filter, on top of the built-in list. */
  blockedWords: string[];
  /** New friends wait for a parent to say yes. */
  approveFriends: boolean;
  /** May join or make chat servers. */
  canJoinServers: boolean;
  /** Chatting is allowed from this time until allowedUntil ("HH:MM", kid's time zone). Both null: any time. */
  allowedFrom: string | null;
  allowedUntil: string | null;
  /** Minutes a day the app can be open, or null for no limit. */
  dailyMinutes: number | null;
  /** IANA time zone the times and days are counted in, such as "America/Chicago". */
  timezone: string;
}

/** Whether a kid can chat right now. */
export interface KidStatus {
  minutesToday: number;
  allowedNow: boolean;
  /** Why not, in words for the kid. */
  reason: string | null;
}

export interface FamilyKid {
  user: PublicUser;
  parents: PublicUser[];
  rules: KidRules;
  status: KidStatus;
  linkedAt: string;
}

export type FamilyAlertType =
  /** The kid deleted a message; a copy is kept for the parents. */
  | "deleted"
  /** The kid's app caught a filtered word (sent or received). Never says which word. */
  | "profanity"
  /** A new friend is waiting for approval (or was added, when approval is off). */
  | "contact"
  /** The kid used up today's minutes. */
  | "time_limit"
  /** The kid asked a parent to look at a chat. */
  | "help";

export interface FamilyAlert {
  id: number;
  kid: PublicUser;
  type: FamilyAlertType;
  /** The conversation it's about. While the alert is open, parents can read it (read only). */
  conversationId: number | null;
  messageId: number | null;
  /** For "contact": the new friend. */
  other: PublicUser | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** A parent looked at a kid's chat. Kids see these. */
export interface FamilyAuditEntry {
  parent: PublicUser;
  kidId: number;
  conversationId: number | null;
  createdAt: string;
}

/** GET /api/family: your family, as a kid or a parent (or both empty). */
export interface FamilyInfo {
  /** Set when you're a kid: who your parents are, your rules, and when they looked at your chats. */
  parents: PublicUser[];
  rules: KidRules | null;
  status: KidStatus | null;
  audit: FamilyAuditEntry[];
  /** Your kids, when you're a parent. */
  kids: FamilyKid[];
  /** Where your alerts are also sent, as a parent. */
  webhookUrl: string | null;
}

export interface FamilyLinkCode {
  code: string;
  expiresAt: string;
}

/** A kid's chat as a parent sees it while an alert is open. */
export interface FamilyChat {
  alert: FamilyAlert;
  conversation: Conversation;
  /** Newest page, oldest first. Messages the kid deleted come back with their kept copy. */
  messages: (Message & { deletedByKid?: boolean })[];
}

// ---- Integrations ---------------------------------------------------------------------

/**
 * An incoming webhook: a secret address that posts into one server text channel. LootDen's
 * Apprise alerts, Home Assistant, scripts... The address is shown once, when it's made.
 */
export interface Webhook {
  id: number;
  serverId: number;
  channelId: number;
  /** The name its messages are shown under. */
  name: string;
  createdBy: PublicUser | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A webhook just made (or given a new address): the only time its address is shown. */
export interface NewWebhook extends Webhook {
  url: string;
}

/** What someone is doing right now, from LootDen: "Playing Stardew Valley on Den-PC". */
export interface Activity {
  kind: "playing";
  title: string;
  /** The PC it's on. */
  device: string;
  startedAt: string;
  /** The game's page in LootDen, when there is one. */
  url: string | null;
}

/** A suggestion to join the voice channel opened for a game you and others are playing. */
export interface PlayTogether {
  serverId: number;
  channelId: number;
  /** The game, as LootDen names it. */
  game: string;
  /** Everyone in that server playing it now, you included. */
  userIds: number[];
}

/** A channel of a server, for where LootDen posts. */
export interface ChannelRef {
  serverId: number;
  channelId: number;
}

/** The super admin's LootDen link settings. The token itself is never sent back. */
export interface LootdenSettings {
  /** LootDen's address, e.g. https://games.example.com, or "" when not linked. */
  url: string;
  hasToken: boolean;
  /** Where planned game nights are announced; each also gets a voice channel in that server. */
  gameNights: ChannelRef | null;
  /** Where new screenshots from LootDen's family wall are shared. */
  screenshots: ChannelRef | null;
}

/** A LootDen game, for the card a link to it shows. */
export interface LootdenGame {
  id: string;
  title: string;
  /** Through Dendrop, so it works without signing in to LootDen. */
  coverUrl: string | null;
  releaseYear: number | null;
  genres: string[];
  platform: string;
  sizeBytes: number;
  /** Its page in LootDen. */
  url: string;
  /** You can send it to a PC: your LootDen profile is matched, and it's a full game. */
  canSend: boolean;
}

/** A PC a game can be sent to. */
export interface LootdenPc {
  name: string;
  online: boolean;
  lastUser: string | null;
}

/** How the LootDen link is doing, for the admin page. */
export interface LootdenStatus {
  settings: LootdenSettings;
  /** When LootDen last answered, and what went wrong last time, if anything. */
  lastOkAt: string | null;
  error: string | null;
  /** LootDen profiles, and the Dendrop account each lines up with (by TinyAuth sign-in, email or username). */
  accounts: {
    lootden: { id: number; username: string; displayName: string; kid: boolean; admin: boolean };
    user: PublicUser | null;
    matchedBy: "sign-in" | "email" | "username" | null;
    /** The Dendrop account is already a kid account. */
    userIsKid: boolean;
  }[];
  /** How many people are playing right now. */
  playing: number;
}

/** A kid's chores today, from Den Duty: shown as "🧹 2 chores left" to the kid and their parents. */
export interface ChoresToday {
  due: number;
  done: number;
  left: number;
}

/** The super admin's Den Duty link settings. The token itself is never sent back. */
export interface DendutySettings {
  /** Den Duty's address, e.g. https://chores.example.com, or "" when not linked. */
  url: string;
  /** The Den Duty home, from Settings, Home Assistant and the API. */
  homeId: string;
  hasToken: boolean;
  /** Where cheerful things go (chores approved, goals reached): fine for kids to read. */
  family: ChannelRef | null;
  /** Where grown-up things go (chores to review, shop orders, time-outs, help asks, reminders). Never posted where a kid can read it. */
  parents: ChannelRef | null;
}

/** How the Den Duty link is doing, for the admin page. */
export interface DendutyStatus {
  settings: DendutySettings;
  lastOkAt: string | null;
  error: string | null;
  /** Den Duty's kids, and the Dendrop kid account each goes with. */
  kids: {
    denduty: { id: string; name: string };
    user: PublicUser | null;
    /** "name": matched on its own by name; "picked": chosen by the admin (user null: nobody); null: no kid account with that name. */
    matchedBy: "name" | "picked" | null;
    chores: ChoresToday | null;
  }[];
  /** Dendrop kid accounts, to pick from. */
  kidAccounts: PublicUser[];
}

export const WEBHOOK_LIMITS = {
  perChannel: 10,
  name: 32,
  /** Messages a webhook can post per minute. */
  perMinute: 30,
} as const;

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
  | { type: "voice.updated"; voice: VoiceChannelState }
  /** Your family changed: linked, unlinked, rules, or (for a kid) whether you can chat now. */
  | { type: "family.updated"; family: FamilyInfo }
  /** A new alert about one of your kids. */
  | { type: "family.alert"; alert: FamilyAlert }
  /** To a server's owner and admins: automod caught something with the alert action on. */
  | { type: "automod.alert"; event: AutomodEvent }
  /** Someone you can see started or stopped playing something (null: nothing now). */
  | { type: "activity"; userId: number; activity: Activity | null }
  /** You and others in a server are playing the same game: a voice channel is open for it. */
  | { type: "play.together"; invite: PlayTogether }
  /** A kid's chores today changed (from Den Duty), to the kid and their parents (null: nothing to show). */
  | { type: "chores"; userId: number; chores: ChoresToday | null };

/** Events a client sends over the gateway. Everything else goes through the HTTP API. */
export type ClientEvent = { type: "typing"; conversationId: number } | { type: "ping" };

export * from "./profanity.js";

/** A #rrggbb color, the only form name and text colors are saved in. */
export const isHexColor = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

export const isUsername = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 2 && s.length <= LIMITS.usernameLength && /^[\w.-]+$/.test(s);
