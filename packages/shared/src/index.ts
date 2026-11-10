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
  /** Set (true) for bot accounts, which post through the bot API and show a BOT tag. */
  isBot?: boolean;
  /** Their profile picture's address, or null for the round initial. */
  avatar: string | null;
  /** What they've set as their custom status, or null. Clients hide it once expiresAt passes. */
  status: CustomStatus | null;
}

/** A short line under someone's name, like "🎂 Birthday weekend!", that can clear itself. */
export interface CustomStatus {
  /** One emoji shown before the text, or null. */
  emoji: string | null;
  text: string;
  /** When it clears by itself, or null to keep it until it's changed. */
  expiresAt: string | null;
}

/**
 * Someone's profile: what the profile card shows on top of their PublicUser. Only the person,
 * their friends, family and the people who share a chat or a server with them can see it.
 */
export interface UserProfile {
  user: PublicUser;
  /** "About me", up to PROFILE_LIMITS.bio characters. */
  bio: string;
  /** Free text, like "she/her". */
  pronouns: string;
  /** The banner picture's address, or null for a color. */
  banner: string | null;
  /** The banner color (#rrggbb) when there's no picture, or null for the theme's accent. */
  bannerColor: string | null;
  /** When the account was made. */
  createdAt: string;
  /** When you became friends, or null. */
  friendsSince: string | null;
  /** Servers you're both in. */
  mutualServers: { id: number; name: string }[];
  /** Set for kid accounts, so their card can say their parents look after their profile. */
  isKid: boolean;
}

/** What PATCH /api/me/profile takes. Leave a field out to keep it. */
export interface ProfilePatch {
  bio?: string;
  pronouns?: string;
  bannerColor?: string | null;
  /** null clears it. */
  status?: { emoji: string | null; text: string; expiresAt: string | null } | null;
}

export const PROFILE_LIMITS = {
  bio: 190,
  pronouns: 40,
  statusText: 128,
  /** Profile pictures and banners. */
  imageBytes: 5 * 1024 * 1024,
  /** The furthest ahead a custom status can be set to clear. */
  statusDays: 30,
} as const;

/** The custom status to show now: null once it has expired. */
export const liveStatus = (s: CustomStatus | null | undefined, at = Date.now()): CustomStatus | null =>
  s && (!s.expiresAt || Date.parse(s.expiresAt) > at) ? s : null;

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
  /**
   * A kid account made by a parent, under theirs: its parents look after how it signs in, so it
   * can't change its own password or linked sign-ins. Null for everyone else.
   */
  managedBy: number | null;
  /**
   * Can use the couples kit (docs/COUPLES.md): super admins, and accounts a super admin switched
   * it on for. Always false for kid accounts.
   */
  couplesKit?: boolean;
  /** How you show up: online as usual, Do Not Disturb (no message notifications), or invisible (look offline). */
  presence?: PresenceMode;
  /** When Do Not Disturb ends by itself, or null for until you turn it off. */
  dndUntil?: string | null;
}

export type PresenceMode = "online" | "dnd" | "invisible";

/** Unread messages in one conversation (a DM, group, channel or thread), since you last read it. */
export interface UnreadCount {
  conversationId: number;
  /** Messages from others you haven't read (capped at 100). */
  count: number;
  /** How many of them ping you. */
  mentions: number;
}

/** "held": both said yes, but a kid's parent still has to approve it before they can chat. */
export type FriendState = "friends" | "incoming" | "outgoing" | "held";

export interface Friend {
  user: PublicUser;
  state: FriendState;
  since: string;
  /** Whether an accepted friend is connected right now (people who appear offline aren't). */
  online?: boolean;
  /** An online friend has Do Not Disturb on. */
  dnd?: boolean;
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
  /** Buttons under a bot's message; clicking one tells the bot (see BotInteraction). */
  buttons: MessageButton[] | null;
  /** Emoji reactions, in the order they were first added. */
  reactions: Reaction[];
  /** Set on a server channel message that has a thread hanging off it. */
  thread?: ThreadRef | null;
  /** Whether it's on its channel's pinned board. */
  pinned?: boolean;
  /** Set when the message is a poll (see Poll). */
  poll?: Poll | null;
  /** Set when the message is a quick game: tic-tac-toe, rock paper scissors or a dice roll. */
  game?: Game | null;
  /** Set when the message is a raccoon nudge. */
  nudge?: NudgeKind | null;
  /** Set on a reply: the message it answers (see ReplyRef). */
  replyTo?: ReplyRef | null;
  /** People pinged with <@id> (and a reply's author, unless the reply said not to). */
  mentions?: number[];
  /** Pinged @everyone, by someone allowed to. */
  mentionsEveryone?: boolean;
}

/**
 * The message a reply answers, small enough to show above it. `body` is its text as stored:
 * ciphertext when `keyVersion` is set (the client decrypts it like any message), and cut to
 * LIMITS.replyExcerpt characters when plain.
 */
export interface ReplyRef {
  id: number;
  authorId: number;
  body: string;
  keyVersion: number | null;
  deleted: boolean;
  /** Set when an incoming webhook posted it. */
  webhookName: string | null;
}

/** <@123> pings someone. Group 1 is the user id. */
export const MENTION_RE = /<@(\d{1,12})>/g;
/** @everyone, as a word of its own. */
export const EVERYONE_RE = /(?<![\w@])@everyone\b/;

/**
 * How much someone hears about a conversation or a whole server. "mentions": only when pinged
 * or replied to. "nothing": muted (pings still show a badge in the app, but nothing pops up).
 */
export type NotifyLevel = "all" | "mentions" | "nothing";
export const NOTIFY_LEVELS: NotifyLevel[] = ["all", "mentions", "nothing"];

/** Your notification settings: per conversation (DMs, channels, threads) and per server. Missing means "all". */
export interface NotificationSettings {
  conversations: Record<number, NotifyLevel>;
  servers: Record<number, NotifyLevel>;
}

/** One message found by search. The client knows the conversations, so it names the place. */
export interface SearchHit {
  message: Message;
  /** Set for a server channel or thread. */
  serverId: number | null;
  channelId: number | null;
  threadId: number | null;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Pass as `before` for the next page, or null at the end. */
  next: number | null;
}

/** A link's preview card, fetched by the server. Pictures always come through Dendrop. */
export interface LinkPreview {
  url: string;
  /** The site's own name, or its host. */
  site: string;
  title: string;
  description: string;
  /** /api/link-previews/image/<id> when the page has a picture, else null. */
  image: string | null;
}

/** Super admin settings for link previews: off by default, since the server fetches outside pages. */
export interface LinkPreviewSettings {
  enabled: boolean;
}

/**
 * One emoji reacted to a message, and who used it. `emoji` is the emoji itself ("👍") or a
 * custom emoji's token ("<:raccoon:12>", "<a:dance:13>" when animated).
 */
export interface Reaction {
  emoji: string;
  count: number;
  userIds: number[];
}

// ---- Custom emoji, stickers and GIFs ---------------------------------------------------

/**
 * A server's own emoji. Members of the server use it anywhere (other servers, DMs, group chats)
 * by its token: <:name:id>, or <a:name:id> when it's animated. Anyone signed in can see it.
 */
export interface CustomEmoji {
  id: number;
  serverId: number;
  name: string;
  animated: boolean;
  url: string;
  createdBy: number | null;
  createdAt: string;
}

/**
 * A server's sticker: a bigger picture sent on its own. Sent as a message whose whole text is
 * its token, <sticker:name:id>, so it works in end-to-end encrypted chats too.
 */
export interface Sticker {
  id: number;
  serverId: number;
  name: string;
  description: string;
  /** An emoji that goes with it, for search ("🦝"). */
  emoji: string;
  animated: boolean;
  url: string;
  createdBy: number | null;
  createdAt: string;
}

/**
 * A GIF from the GIF search. Pictures always come through Dendrop (/api/gifs/media/...), so the
 * GIF service never sees who is looking. Sent as a message holding its link (`url`).
 */
export interface Gif {
  id: string;
  title: string;
  /** The link a message carries: the GIF's page on the GIF service. */
  url: string;
  /** Small, for the picker. */
  previewUrl: string;
  /** Full size, for the chat. */
  mediaUrl: string;
  width: number;
  height: number;
}

export interface GifPage {
  gifs: Gif[];
  /** Pass as offset for the next page, or null at the end. */
  next: number | null;
}

/** Content ratings, mildest first. Kids always get "g". */
export const GIF_RATINGS = ["g", "pg", "pg-13", "r"] as const;
export type GifRating = (typeof GIF_RATINGS)[number];

/** The super admin's GIF settings. Off until set up, since searches go to an outside service. */
export interface GifSettings {
  enabled: boolean;
  provider: "giphy";
  /** The provider's API key is never sent back, only whether there is one. */
  hasKey: boolean;
  /** The strongest rating anyone here gets. */
  rating: GifRating;
}

/**
 * The GIF id in a link to one (a GIPHY page or picture), or null. Giphy ids are letters and
 * numbers; a page link ends with "-<id>".
 */
export function gifIdFromLink(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const ok = (id: string | undefined) => (id && /^[A-Za-z0-9]{4,64}$/.test(id) ? id : null);
  if (host === "giphy.com" || host === "www.giphy.com") {
    if ((parts[0] === "gifs" || parts[0] === "stickers") && parts[1]) return ok(parts[1].split("-").at(-1));
    return null;
  }
  if (/^media\d?\.giphy\.com$/.test(host) && parts[0] === "media") {
    // /media/<id>/giphy.gif, or /media/v1.<...>/<id>/giphy.gif
    return ok(parts[1]?.startsWith("v1.") ? parts[2] : parts[1]);
  }
  if (host === "i.giphy.com") return ok((parts[0] === "media" ? parts[1] : parts[0])?.replace(/\.(gif|webp)$/, ""));
  return null;
}

export const EXPRESSION_LIMITS = {
  /** Still emoji per server; animated ones have their own allowance. */
  emojis: 50,
  animatedEmojis: 50,
  emojiBytes: 256 * 1024,
  stickers: 30,
  stickerBytes: 512 * 1024,
  /** Letters, numbers and _, 2 to 32 long. */
  nameLength: 32,
  stickerDescription: 100,
  /** Different emoji on one message. */
  reactionsPerMessage: 20,
  /** Soundboard sounds per server, and how big each can be (about 5 seconds of MP3 or Ogg). */
  sounds: 24,
  soundBytes: 512 * 1024,
  /** Longest a soundboard sound can play, checked by the app when it's added. */
  soundSeconds: 5,
} as const;

/** A soundboard sound uploaded to a server. Plays to everyone in a voice channel with you. */
export interface ServerSound {
  id: number;
  serverId: number;
  name: string;
  /** An emoji shown on its button. */
  emoji: string;
  /** How loud it plays, 0 to 100, set when it's added. */
  volume: number;
  url: string;
  createdBy: number | null;
  createdAt: string;
}

/** Sounds every voice channel has, made by the app on the spot (no files). */
export const BUILTIN_SOUNDS = [
  { id: "badum", name: "Ba dum tss", emoji: "🥁" },
  { id: "tada", name: "Ta-da", emoji: "🎉" },
  { id: "boing", name: "Boing", emoji: "🦘" },
  { id: "sad", name: "Sad trombone", emoji: "😢" },
  { id: "airhorn", name: "Horn", emoji: "📯" },
  { id: "ding", name: "Ding", emoji: "🔔" },
] as const;
export type BuiltinSoundId = (typeof BUILTIN_SOUNDS)[number]["id"];
export const isBuiltinSound = (s: unknown): s is BuiltinSoundId => BUILTIN_SOUNDS.some((b) => b.id === s);

/** A soundboard sound someone played: a built-in one, or one of the server's. */
export type SoundboardPlay = { builtin: BuiltinSoundId } | { sound: ServerSound };

/** How long one person waits between soundboard sounds. */
export const SOUNDBOARD_COOLDOWN_MS = 2000;

/** Custom emoji names: letters, numbers and underscores. */
export const isEmojiName = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_]{2,32}$/.test(s);

/** <:name:id> or <a:name:id>. Group 1 is "a" when animated, 2 the name, 3 the id. */
export const CUSTOM_EMOJI_RE = /<(a?):([A-Za-z0-9_]{2,32}):(\d{1,12})>/g;
/** A message that is only a sticker: <sticker:name:id>. */
export const STICKER_RE = /^<sticker:([A-Za-z0-9_]{2,32}):(\d{1,12})>$/;

/**
 * Whether a string is one emoji (or a short run of them, such as a flag or a family): what
 * reactions accept besides custom emoji.
 */
export const isUnicodeEmoji = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 32 &&
  /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u.test(s) &&
  /[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}\u20e3]/u.test(s);

export interface AuthInfo {
  /** True until the first account (the super admin) has been made. */
  needsSetup: boolean;
  oidc: { enabled: boolean; name: string };
  /** "Sign in with Google" is set up and switched on. */
  google: { enabled: boolean };
  localLogin: boolean;
  signup: boolean;
  /** "Sign in with a passkey" can work here (an https:// address). */
  passkeys?: boolean;
}

/** The super admin's switches for how people sign in and get accounts. */
export interface SignInSettings {
  /** Sign in with a username and password. */
  passwordLogin: boolean;
  /** Anyone can make a password account from the sign-in page. */
  signup: boolean;
  /** Sign in through TinyAuth (or another OpenID Connect provider). */
  tinyauth: boolean;
  /** A first TinyAuth sign-in makes a Dendrop account. */
  tinyauthSignup: boolean;
  /** Sign in with Google. */
  google: boolean;
  /** A first Google sign-in makes a Dendrop account. Off: Google only works once linked in Settings. */
  googleSignup: boolean;
  /** People can link TinyAuth and Google to their account in Settings. */
  linking: boolean;
  /** Parents can make kid accounts under theirs. */
  parentKidAccounts: boolean;
}

/** GET /api/admin/signin. */
export interface AdminSignIn {
  settings: SignInSettings;
  /** Which providers the server is configured for (they also need DENDROP_PUBLIC_URL). */
  configured: { tinyauth: boolean; tinyauthName: string; google: boolean; publicUrl: boolean };
}

export type SignInProvider = "tinyauth" | "google";

/** GET /api/me/signins: the ways you can sign in, and what you could link. */
export interface MySignIns {
  password: boolean;
  tinyauth: { name: string; linked: boolean; available: boolean };
  google: { linked: boolean; email: string | null; available: boolean };
  /** Linking is switched on by the admin (and you aren't a kid account under a parent). */
  canLink: boolean;
  /** For a kid account under a parent: who looks after its sign-in. */
  managedBy: PublicUser | null;
}

/** An account as the super admin sees it, for managing sign-ins. */
export interface AdminAccount {
  user: PublicUser;
  isSuperAdmin: boolean;
  isKid: boolean;
  managedBy: string | null;
  password: boolean;
  tinyauth: boolean;
  google: string | null;
  createdAt: string;
  /** An authenticator app is set up for password sign-ins. */
  twoFactor?: boolean;
  /** How many passkeys the account has. */
  passkeys?: number;
  /** The couples kit is switched on for them (always false for kids; super admins always have it). */
  couplesKit?: boolean;
}

/** GET /api/server: what this server allows, for signed-in clients. */
export interface ServerInfo {
  maxUploadBytes: number;
  /** Voice and video calls work only when the server has LiveKit set up. */
  calls: boolean;
  /** LootDen's address when it's linked, so links to its games can show a card. */
  lootdenUrl: string | null;
  /** GIF search is set up here (kids also need their parents to allow GIFs: KidRules.gifs). GIF links show as GIFs. */
  gifs: boolean;
  /** YouTube videos can be watched together in voice channels. */
  watchYoutube: boolean;
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

/**
 * What a custom role can let its members do. The owner and admins can always do all of it.
 * Custom roles add up: someone with two roles can do what either allows.
 */
export type ServerPermission =
  | "manageServer"
  | "manageChannels"
  | "manageRoles"
  | "manageAutomod"
  | "kickMembers"
  | "timeoutMembers"
  | "deleteMessages"
  | "createInvites"
  | "manageExpressions"
  | "manageEvents"
  | "pinMessages"
  | "mentionEveryone"
  | "banMembers"
  | "manageWebhooks"
  | "manageNicknames"
  | "viewAuditLog"
  | "muteMembers"
  | "moveMembers";

export const SERVER_PERMISSIONS: ServerPermission[] = [
  "manageServer",
  "manageChannels",
  "manageRoles",
  "manageAutomod",
  "kickMembers",
  "banMembers",
  "timeoutMembers",
  "deleteMessages",
  "manageNicknames",
  "muteMembers",
  "moveMembers",
  "manageWebhooks",
  "viewAuditLog",
  "createInvites",
  "manageExpressions",
  "manageEvents",
  "pinMessages",
  "mentionEveryone",
];

/** Permissions that let someone moderate other people. Kid accounts can't hold them (or be admins). */
export const MODERATION_PERMISSIONS: ServerPermission[] = SERVER_PERMISSIONS.filter(
  (p) => p !== "createInvites" && p !== "manageExpressions" && p !== "manageEvents" && p !== "pinMessages" && p !== "mentionEveryone",
);

/**
 * A role a server's moderators made, like "Cousins" or "Game night crew". Roles are ranked
 * (position 0 is the highest, under the owner and admins). Someone with Manage roles can only
 * change roles ranked below their own highest role, and can only hand out permissions they have.
 */
export interface CustomRole {
  id: number;
  serverId: number;
  name: string;
  /** #rrggbb, or null for no color. Members' names show in their highest colored role's color. */
  color: string | null;
  position: number;
  permissions: ServerPermission[];
  memberCount: number;
}

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
  /** What you can do here, from your built-in role and your custom roles. */
  myPermissions: ServerPermission[];
  /** Custom roles, highest first. */
  roles: CustomRole[];
  /** Your nickname here, or null to use your display name. */
  nickname: string | null;
  /** Whether everyone can make invites, or only the owner and admins. */
  memberInvites: boolean;
  /** Open a voice channel while two or more members play the same game (from LootDen). */
  playTogether: boolean;
  channels: Channel[];
  /** Channel categories, in order. Channels whose categoryId is null show first, grouped by kind. */
  categories: ChannelCategory[];
  members: ServerMember[];
  createdAt: string;
  /** Set while automod or a moderator has timed you out here: you can read but not post or talk. */
  timedOutUntil: string | null;
  /** The server's custom emoji, by name. */
  emojis: CustomEmoji[];
  /** The server's stickers, newest last. */
  stickers: Sticker[];
  /** The server's soundboard sounds (the built-in ones aren't listed). */
  sounds: ServerSound[];
  /** Members earn XP and raccoon ranks for chatting. Owners and admins can turn it off. */
  levels: boolean;
  /** What new members see first: a hello, the rules, and roles they can pick for themselves. */
  welcome: ServerWelcome;
  /** When you went through the welcome screen (and agreed to the rules), or null if you haven't. */
  welcomedAt: string | null;
}

// ---- Levels -----------------------------------------------------------------------------

/** How XP is earned: a random amount per message, at most once per cooldown, in text channels. */
export const LEVEL_RULES = { xpMin: 15, xpMax: 25, cooldownSeconds: 60 } as const;

export interface RaccoonRank {
  /** The level it starts at. */
  level: number;
  name: string;
  emoji: string;
}

/** The ranks levels earn, lowest first. */
export const RACCOON_RANKS: RaccoonRank[] = [
  { level: 0, name: "Kit", emoji: "🍼" },
  { level: 2, name: "Scavenger", emoji: "🍂" },
  { level: 5, name: "Bin Diver", emoji: "🗑️" },
  { level: 10, name: "Night Prowler", emoji: "🌙" },
  { level: 15, name: "Masked Bandit", emoji: "🎭" },
  { level: 20, name: "Den Keeper", emoji: "🏡" },
  { level: 30, name: "Trash Panda Legend", emoji: "🌟" },
  { level: 50, name: "Raccoon Royalty", emoji: "👑" },
];

/** Total XP needed to reach a level: 100 for level 1, 300 for 2, 600 for 3, and so on. */
export const xpForLevel = (level: number): number => 50 * level * (level + 1);

export interface LevelProgress {
  level: number;
  rank: RaccoonRank;
  /** XP earned since this level started, and how much the next level needs on top of it. */
  into: number;
  needed: number;
}

export function levelOf(xp: number): LevelProgress {
  let level = Math.max(0, Math.floor((-1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2));
  while (xpForLevel(level + 1) <= xp) level++;
  while (level > 0 && xpForLevel(level) > xp) level--;
  const rank = [...RACCOON_RANKS].reverse().find((r) => r.level <= level)!;
  return { level, rank, into: xp - xpForLevel(level), needed: xpForLevel(level + 1) - xpForLevel(level) };
}

export interface LeaderboardEntry {
  userId: number;
  xp: number;
}

// ---- Welcome screen -----------------------------------------------------------------------

export const WELCOME_LIMITS = { message: 1000, rules: 20, ruleLength: 200, roles: 25, roleDescription: 100, emoji: 16 } as const;

/** A custom role members can give themselves on the welcome screen. Never one that moderates. */
export interface WelcomeRole {
  roleId: number;
  description: string;
  /** An emoji to show next to it, or "". */
  emoji: string;
}

export interface ServerWelcome {
  enabled: boolean;
  message: string;
  rules: string[];
  /** Members (not the owner, admins or bots) can't post or talk until they agree to the rules. */
  requireAgree: boolean;
  roles: WelcomeRole[];
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
  /** Custom roles the rule leaves alone. */
  exemptRoleIds: number[];
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

/**
 * Text channels hold messages; voice channels are rooms people drop into to talk (and keep a
 * text chat too). Stage channels are voice rooms for game nights and movie nights: a few
 * speakers talk and share their screen, everyone else listens and can raise a hand to speak.
 * Forum channels hold posts, each a thread with a title and tags, instead of one chat.
 */
export type ChannelKind = "text" | "voice" | "stage" | "forum";

/** Voice and stage channels are both rooms people drop into. */
export const isVoiceKind = (kind: ChannelKind): boolean => kind === "voice" || kind === "stage";

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
  /** For locked channels, who was picked (people who can manage channels see this; others get []). */
  memberIds: number[];
  /** For locked channels, custom roles whose members can see it too (same visibility as memberIds). */
  roleIds: number[];
  /** Forum channels: the tags posts can carry, in order. Empty for other channels. */
  tags: string[];
  /** The category it's listed under, or null for none. */
  categoryId: number | null;
  /** Seconds each person waits between messages here (0 is off). Moderators don't wait. */
  slowmode: number;
  /**
   * Only some people can post: people who can manage channels, and members of postRoleIds.
   * Everyone who can see the channel can still read it, react and use threads.
   */
  readOnly: boolean;
  /** For read-only channels, roles whose members can post (people who can manage channels see this; others get []). */
  postRoleIds: number[];
  /** Whether you can post here. */
  canPost: boolean;
}

/** A heading channels are grouped under in the sidebar, like "Games" or "Grown-ups". */
export interface ChannelCategory {
  id: number;
  name: string;
  position: number;
}

/** Longest slowmode, in seconds (6 hours). */
export const MAX_SLOWMODE = 6 * 60 * 60;
/** The slowmode choices the apps offer, in seconds. */
export const SLOWMODE_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

/** What a message shows about the thread hanging off it. */
export interface ThreadRef {
  id: number;
  conversationId: number;
  title: string;
  messageCount: number;
  lastMessageAt: string | null;
}

/**
 * A thread: a side conversation started from a channel message, or a post in a forum channel
 * (which has no starting message, just a title, tags and its first message). Everyone who can see
 * the channel can see and post in its threads. Its messages go through the same
 * /api/conversations/:conversationId endpoints as the channel's.
 */
export interface Thread {
  id: number;
  serverId: number;
  channelId: number;
  conversationId: number;
  title: string;
  /** The channel message it was started from, or null for a forum post. */
  parentMessageId: number | null;
  createdBy: number | null;
  createdAt: string;
  /** A closed thread is read only, except for people who can manage channels. */
  closed: boolean;
  /** Forum posts: tags from the channel's list. */
  tags: string[];
  /** Messages in it, not counting deleted ones. */
  messageCount: number;
  lastMessageAt: string | null;
  /** The start of its first message, for forum lists ("" if none). */
  preview: string;
}

/** A message on a server's pinned board, with where it is. */
export interface PinnedMessage {
  message: Message;
  channelId: number;
  /** Set when it's pinned inside a thread. */
  threadId: number | null;
  threadTitle: string | null;
  pinnedBy: number | null;
  pinnedAt: string;
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
  /** Whether they can talk. Always true in a voice channel; on a stage, only for speakers. */
  speaker: boolean;
  /** On a stage: a listener asking to speak. */
  handRaised: boolean;
  /** A moderator muted them: they can't unmute until a moderator lets them. */
  serverMuted?: boolean;
  /** A moderator deafened them: they hear nobody and can't undeafen until a moderator lets them. */
  serverDeafened?: boolean;
}

/** Who is in a voice channel right now. Lives in memory on the server; empty channels aren't listed. */
export interface VoiceChannelState {
  channelId: number;
  serverId: number;
  conversationId: number;
  /** A stage channel: only speakers talk, everyone else listens. */
  stage: boolean;
  members: VoiceMember[];
  /** A video everyone in the channel is watching together, or null. */
  watch: WatchSession | null;
}

// ---- Watch together ---------------------------------------------------------------------

/**
 * Where a watch-together video comes from:
 * - file: a video someone posted in the voice channel's own chat, streamed from this server.
 * - link: a direct link to a video file (.mp4, .webm…) on another site, played by each device.
 * - youtube: a YouTube video, only when a super admin has turned YouTube on (it's an outside service).
 */
export type WatchSourceKind = "file" | "link" | "youtube";

export interface WatchItem {
  /** Random, so a "this one ended" from a slow device can't skip the next one. */
  id: string;
  kind: WatchSourceKind;
  /** file: the stream address on this server; link: the video's address; youtube: the 11-character video id. */
  src: string;
  title: string;
  addedBy: number;
}

/**
 * What's playing in a voice channel. Each device works out where the video should be from
 * `position` and `updatedAt` (and the server's clock, GET /api/time), and catches up if it drifts.
 */
export interface WatchSession {
  current: WatchItem;
  /** Up next, in order. */
  queue: WatchItem[];
  playing: boolean;
  /** Seconds into the video at updatedAt. */
  position: number;
  /** Server time in milliseconds when position was set. */
  updatedAt: number;
}

/** Video types a channel's own files can be watched as (the ones browsers play). */
export const WATCH_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];

/** Where a watch-together video should be in seconds, at server time `serverNow`. */
export function watchPosition(w: Pick<WatchSession, "playing" | "position" | "updatedAt">, serverNow: number): number {
  return w.playing ? Math.max(0, w.position + (serverNow - w.updatedAt) / 1000) : w.position;
}

/**
 * Reads a pasted watch-together link: a YouTube video (any of its usual address shapes) or a
 * link to a video file. Returns null for anything that isn't an http(s) address.
 */
export function parseWatchLink(input: string): { kind: "youtube"; videoId: string } | { kind: "link"; url: string } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || input.length > 2000) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const id = /^[A-Za-z0-9_-]{11}$/;
  let videoId: string | undefined;
  if (host === "youtu.be") videoId = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") videoId = u.searchParams.get("v") ?? undefined;
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
      videoId = m?.[1];
    }
    if (!videoId || !id.test(videoId)) return null;
  }
  if (videoId !== undefined) return id.test(videoId) ? { kind: "youtube", videoId } : null;
  return { kind: "link", url: u.toString() };
}

/** Watch together settings for the whole Dendrop server (super admins). */
export interface WatchSettings {
  /** YouTube videos can be watched together. Off by default: each device then loads YouTube's player. */
  youtube: boolean;
}

/** A video posted in a voice channel's chat, ready to watch together. */
export interface WatchVideo {
  attachmentId: string;
  name: string;
  size: number;
  postedBy: number;
  postedAt: string;
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
  /** Custom roles, highest first. */
  roleIds: number[];
  /**
   * Their highest colored custom role's color, or null. In a server this wins over the person's
   * own name color, so everyone can tell who holds which role.
   */
  color: string | null;
  nickname: string | null;
  joinedAt: string;
  /** Their XP here, or null while the server has levels off. */
  xp: number | null;
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
  /** No chat until today's Den Duty chores are done (needs Den Duty linked). */
  choresFirst: boolean;
  /** LootDen's bedtime for the kid's LootDen profile closes chat too. */
  lootdenBedtime: boolean;
  /**
   * Game time in LootDen counts toward the daily time: chat and games share one budget, the
   * daily minutes above, or LootDen's daily play time when there are none.
   */
  lootdenPlayTime: boolean;
  /** May search for and see GIFs (always the mildest rating). Off until a parent turns it on. */
  gifs: boolean;
  /**
   * May set a profile picture and banner. Off until a parent turns it on; turning it off takes
   * them down. The kid's bio, pronouns and status always go through the family filter.
   */
  profilePictures: boolean;
  /** Sees preview cards (title, text, picture) under links. Off until a parent turns it on. */
  linkPreviews: boolean;
}

/** The kid's LootDen play limits, when LootDen is linked and their profile is matched. */
export interface LootdenKidLimits {
  /** No play (and, with lootdenBedtime, no chat) between these times in LootDen's time zone. */
  bedtime: { from: string; to: string } | null;
  /** Today's play time in LootDen with any bonus time, or null for no daily limit. */
  dailyMinutes: number | null;
  /** Minutes played in LootDen today, counting a game that's running now. */
  playedMinutes: number;
  /** LootDen's household time zone. */
  timezone: string;
}

/** Whether a kid can chat right now. */
export interface KidStatus {
  /** Minutes with the app open today. */
  minutesToday: number;
  /** Minutes of LootDen games counted toward the daily time today (0 unless lootdenPlayTime). */
  gameMinutesToday: number;
  /** Today's daily time in minutes: the kid's own, else LootDen's with lootdenPlayTime; null for none. */
  limitMinutes: number | null;
  /** The kid's LootDen play limits, or null when LootDen isn't linked or their profile isn't matched. */
  lootden: LootdenKidLimits | null;
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
  /** Made by a parent under their account: the parents look after its password. */
  managed: boolean;
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
  | "help"
  /** The kid changed their profile (bio, pronouns, status or pictures). */
  | "profile";

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
    /** Why this kid's chat is paused by Den Duty right now, as the kid sees it; null when it isn't. */
    chatPaused: string | null;
  }[];
  /** Dendrop kid accounts, to pick from. */
  kidAccounts: PublicUser[];
}

// ---- Bots ------------------------------------------------------------------------------

export type ButtonStyle = "primary" | "secondary" | "success" | "danger";

/**
 * A button under a bot's message. A button with an `id` tells the bot when it's clicked; one
 * with a `url` just opens that link.
 */
export interface MessageButton {
  id?: string;
  label: string;
  style: ButtonStyle;
  disabled?: boolean;
  url?: string;
}

/**
 * A bot: an account with no password that posts through the bot API with a secret token. Bots
 * live in server channels only: they can't be friends, so they're never in DMs, group chats or
 * anything end-to-end encrypted.
 */
export interface Bot {
  id: number;
  username: string;
  displayName: string;
  description: string;
  owner: PublicUser | null;
  /** Any server's owner or admins can add it, not just its owner's servers. */
  isPublic: boolean;
  /** Gets the text of messages in the channels it's in. Off: only clicks on its buttons and its own messages. */
  readsMessages: boolean;
  /** Where events are POSTed (signed), or null when it only uses the bot gateway. */
  eventsUrl: string | null;
  /** Signs the events POSTed to eventsUrl. Only shown to the bot's owner and super admins. */
  signingSecret?: string;
  /** Connected to the bot gateway right now, or has an events address. */
  online: boolean;
  /** How many servers it's in. */
  serverCount: number;
  createdAt: string;
  lastSeenAt: string | null;
}

/** A bot just made, or given a new token: the only time the token is shown. */
export interface NewBotToken {
  bot: Bot;
  token: string;
}

/** Someone clicked a bot's button. Sent to the bot as an "interaction.created" event. */
export interface BotInteraction {
  id: number;
  botId: number;
  messageId: number;
  conversationId: number;
  serverId: number;
  channelId: number;
  buttonId: string;
  /** Who clicked, and their role in the server. */
  user: PublicUser;
  role: ServerRole;
  createdAt: string;
}

/**
 * What a bot's events address may answer to an interaction, within BOT_LIMITS.callbackMs:
 * a reply only the clicker sees, and new text or buttons for the message clicked.
 */
export interface InteractionResponse {
  reply?: string;
  update?: { content?: string; buttons?: MessageButton[] | null };
}

/** The events bots get, over the bot gateway or POSTed to their events address. */
export const BOT_EVENT_TYPES = ["ready", "message.created", "message.updated", "server.updated", "server.removed", "interaction.created"] as const;

export const BOT_LIMITS = {
  /** Messages (and edits) a bot can post per minute. */
  perMinute: 30,
  buttons: 5,
  buttonLabel: 40,
  buttonId: 64,
  description: 200,
  botsPerOwner: 20,
  /** How long a bot's events address has to answer a click. */
  callbackMs: 3000,
  /** How long after a click a bot can still reply to it. */
  replyMinutes: 15,
  /** Clicks per person per minute. */
  clicksPerMinute: 20,
} as const;

export const WEBHOOK_LIMITS = {
  perChannel: 10,
  name: 32,
  /** Messages a webhook can post per minute. */
  perMinute: 30,
} as const;

// ---- Scheduled events -------------------------------------------------------------------

/** Going: counting on it. Interested: maybe. Both get the reminders. */
export type EventRsvp = "going" | "interested";

/**
 * A server event, like "Friday movie night". It happens in one of the server's voice or stage
 * channels, or somewhere else (location). People RSVP, and everyone who did is reminded a
 * little before it starts and again when it goes live. Events start by themselves at their time
 * (or earlier, when a host starts them) and end at their end time, when a host ends them, or
 * EVENT_LIMITS.openEndedHours after they started. A weekly event moves on to next week when it
 * ends, keeping its RSVPs; any other event is gone once it ends.
 */
export interface ScheduledEvent {
  id: number;
  serverId: number;
  name: string;
  description: string;
  /** The voice or stage channel it happens in, or null when it's somewhere else. */
  channelId: number | null;
  /** Where it is when it isn't in a channel ("Grandma's house"); "" otherwise. */
  location: string;
  startsAt: string;
  /** Null: it runs until a host ends it. */
  endsAt: string | null;
  repeat: "none" | "weekly";
  status: "scheduled" | "live";
  /** Who made it (null if they left or their account is gone). */
  createdBy: PublicUser | null;
  /** Who is going and who is interested (user ids, current members only). */
  goingIds: number[];
  interestedIds: number[];
  myRsvp: EventRsvp | null;
  /** Whether you can edit, start, end or cancel it: Manage events, or you made it. */
  canManage: boolean;
  createdAt: string;
}

export const EVENT_LIMITS = {
  name: 100,
  description: 1000,
  location: 100,
  /** Scheduled and live events a server can have at once. */
  perServer: 50,
  /** How far ahead an event can be. */
  maxDaysAhead: 366,
  /** The longest an event can last. */
  maxHours: 72,
  /** Events with no end time end this long after they start, if no host ended them. */
  openEndedHours: 12,
  /** The heads-up comes this long before an event starts. */
  reminderMinutes: 15,
} as const;

// ---- Polls, quick games, nudges and reminders ------------------------------------------

/**
 * A poll posted as a message. In an end-to-end encrypted chat the question and options travel
 * inside the encrypted message body (as { t: question, o: options }), so the server only knows
 * how many options there are and who picked which number.
 */
export interface Poll {
  /** The question and options, or null when they're encrypted in the message body. */
  question: string | null;
  options: string[] | null;
  optionCount: number;
  /** People can pick more than one option. */
  multi: boolean;
  /** When voting ends by itself, if it does. */
  closesAt: string | null;
  /** Voting is over (closed by its maker, or closesAt passed). */
  closed: boolean;
  /** Who picked each option, by position. */
  votes: number[][];
}

export type GameKind = "tictactoe" | "rps" | "dice";
export type RpsPick = "rock" | "paper" | "scissors";
export const RPS_PICKS: RpsPick[] = ["rock", "paper", "scissors"];

/**
 * A quick game in a chat. The server keeps the state and checks every move, so nobody can
 * cheat, and rolls the dice itself. Games carry no words, so they aren't encrypted.
 */
export interface Game {
  kind: GameKind;
  /** Who's playing, in seat order (X then O for tic-tac-toe). A seat is open while there's one. */
  players: number[];
  /** Tic-tac-toe: 9 cells, row by row: 0 empty, 1 the first player (X), 2 the second (O). */
  board: number[] | null;
  /** Whose move it is, or null when it's over or waiting for a second player. */
  turn: number | null;
  /** Rock paper scissors: who has picked so far (picks stay secret until both are in). */
  picked: number[];
  /** Rock paper scissors: each player's pick by seat, once both have picked. */
  picks: RpsPick[] | null;
  /** A dice roll: what was asked for ("2d6"), each die, and the total. */
  dice: { spec: string; rolls: number[]; total: number } | null;
  winner: number | null;
  /** Tic-tac-toe: the three winning cells. */
  line: number[] | null;
  draw: boolean;
  done: boolean;
}

/** Raccoon nudges for DMs: a little shake on the other person's screen. */
export const NUDGES = {
  poke: { emoji: "👉🦝", text: "poked you" },
  wave: { emoji: "🦝👋", text: "waved at you" },
  snack: { emoji: "🦝🍪", text: "brought you a snack" },
  hug: { emoji: "🦝🤗", text: "sent you a raccoon hug" },
  zoomies: { emoji: "🦝💨", text: "has the zoomies" },
  trash: { emoji: "🦝🗑️", text: "found treasure in the trash for you" },
} as const;
export type NudgeKind = keyof typeof NUDGES;
export const isNudgeKind = (s: unknown): s is NudgeKind => typeof s === "string" && Object.hasOwn(NUDGES, s);

/** "Ping me about this": a message to bring back to you later. Only you see your reminders. */
export interface Reminder {
  id: number;
  messageId: number;
  conversationId: number;
  remindAt: string;
  createdAt: string;
  /** Set once it has gone off; it stays listed until you dismiss it. */
  firedAt: string | null;
}

export const FUN_LIMITS = {
  pollQuestion: 300,
  pollOption: 80,
  pollOptions: 10,
  /** The longest a poll can stay open by itself. */
  pollMinutes: 14 * 24 * 60,
  dice: 10,
  diceSides: 1000,
  /** Seconds between nudges from one person in one chat. */
  nudgeSeconds: 30,
  reminders: 100,
  /** How far ahead a reminder can be, in days. */
  reminderDays: 366,
  /** The longest voice message, in seconds. */
  voiceSeconds: 300,
} as const;

/** "2d6", "d20" or "1d100": up to 10 dice with 2 to 1000 sides. Returns null when it isn't one. */
export function parseDice(spec: string): { count: number; sides: number } | null {
  const m = /^\s*(\d{0,2})\s*d\s*(\d{1,4})\s*$/i.exec(spec);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  if (count < 1 || count > FUN_LIMITS.dice || sides < 2 || sides > FUN_LIMITS.diceSides) return null;
  return { count, sides };
}

// ---- Couples kit ------------------------------------------------------------------

/**
 * What goes in a couples kit (see docs/COUPLES.md):
 * - idea: the Yes / No / Maybe list. Votes stay private; only mutual matches are shown.
 * - question: a question or "would you rather" with up to 10 answers, revealed once both answered.
 * - card: a custom prompt card in a named deck.
 * - spinner: a list of options for the date night spinner.
 * - photo: a view-once photo, deleted from the server once it's opened.
 * - note: a love note, held back until its delivery time.
 * - countdown: a shared countdown to a date.
 */
export const COUPLES_KINDS = ["idea", "question", "card", "spinner", "photo", "note", "countdown"] as const;
export type CouplesKind = (typeof COUPLES_KINDS)[number];

export type CouplesIdeaVote = "yes" | "no" | "maybe";

/** off: nobody asked. invited: one person asked and waits for the other. on: both said yes. */
export type CouplesKitState = "off" | "invited" | "on";

export interface CouplesKit {
  conversationId: number;
  state: CouplesKitState;
  /** Who asked to turn it on (null while off). */
  invitedBy: number | null;
  /**
   * False when this chat can never have a kit (someone in it is a kid account, or it isn't a
   * chat between two people): apps hide the kit button.
   */
  eligible: boolean;
  /** Why this conversation can't have a kit right now (null when it can). */
  unavailable: string | null;
  /** Everything in it, oldest first. Empty unless state is "on". */
  items: CouplesItem[];
  /**
   * Spicy mode: wilder built-in starters. Each person switches it on for themselves, and the
   * spicy pack (/api/couples/:id/spicy-pack) only comes once both have.
   */
  spicy: { mine: boolean; partner: boolean };
}

/** The spicy pack's built-in starters (see CouplesKit.spicy). */
export interface CouplesSpicyPack {
  ideas: string[];
  decks: { name: string; emoji: string; cards: string[] }[];
  /** [question, answer A, answer B] */
  wouldYouRather: [string, string, string][];
  spinner: { name: string; options: string[] };
}

export interface CouplesItem {
  id: number;
  conversationId: number;
  kind: CouplesKind;
  authorId: number;
  /**
   * Ciphertext, encrypted with the conversation key like a message but bound to the kit
   * ("dendrop:couples:<conversation>:<author>:<kind>"). Empty for an opened photo.
   */
  body: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Ideas: your vote. Questions: the number of the answer you picked. Null until you answer. */
  myVote: string | null;
  /** Ideas: "yes" when you both said yes, "maybe" when you both said yes or maybe; else null. */
  match: "yes" | "maybe" | null;
  /** Questions: whether the other person has answered (not what). */
  partnerAnswered: boolean;
  /** Questions: both answers by user id, once both of you have answered. */
  answers: Record<number, number> | null;
  /** Photos: whether it was opened (then it's gone). */
  opened: boolean;
  /** Photos: the encrypted file's size while it can still be opened. */
  fileSize: number | null;
  /** Notes: when it shows up for the other person (null for a note sent straight away). */
  deliverAt: string | null;
}

export const COUPLES_LIMITS = {
  itemsPerKit: 2000,
  questionOptions: 10,
  /** How far ahead a love note can be scheduled. */
  noteDays: 366,
} as const;

/** Pictures the web client shows inline. Everything else is offered as a download. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Limits that the server and clients both check. */
export const LIMITS = {
  messageLength: 4000,
  /** Videos waiting in a voice channel's watch-together queue. */
  watchQueue: 20,
  watchTitle: 120,
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
  categoriesPerServer: 30,
  categoryName: 40,
  threadTitle: 100,
  forumTags: 20,
  forumTagName: 24,
  tagsPerPost: 5,
  pinsPerChannel: 50,
  rolesPerServer: 50,
  roleName: 32,
  serversPerUser: 100,
  serverImageBytes: 5 * 1024 * 1024,
  /** Ciphertext of a full-length message, with room for file names. */
  encryptedBodyLength: 32_000,
  /** How much of a plain message a reply shows above itself. */
  replyExcerpt: 200,
  /** People one message can ping. */
  mentionsPerMessage: 50,
  /** Search words, and results per page. */
  searchQuery: 200,
  searchPage: 25,
  /** Links per message that get a preview card. */
  previewsPerMessage: 3,
} as const;

/** Events the server pushes over the WebSocket gateway at /api/gateway. */
export type ServerEvent =
  | { type: "ready"; user: Me }
  /**
   * A new message. `notify` says whether this person's settings want a notification for it
   * (missing from older servers: treat as true), `mentioned` whether it pings them, and `muted`
   * whether they muted the conversation (no unread dot).
   */
  | { type: "message.created"; message: Message; notify?: boolean; mentioned?: boolean; muted?: boolean }
  /** Your notification settings changed (on another device). */
  | { type: "notifications.updated"; settings: NotificationSettings }
  | { type: "message.updated"; message: Message }
  /** Someone added or took back a reaction: the message's reactions now. */
  | { type: "message.reactions"; conversationId: number; messageId: number; reactions: Reaction[] }
  | { type: "conversation.created"; conversation: Conversation }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "friend.updated"; friend: Friend }
  | { type: "friend.removed"; userId: number }
  /** A moderator moved you to another voice channel: join it. */
  | { type: "voice.move"; serverId: number; channelId: number }
  /** The people you blocked changed (on this or another device). */
  | { type: "blocks.updated"; blocked: PublicUser[] }
  /** Someone reported something you can review: a server's moderators, or super admins (serverId null). */
  | { type: "report.created"; serverId: number | null }
  | { type: "typing"; conversationId: number; userId: number }
  | { type: "read"; conversationId: number; userId: number; messageId: number }
  | { type: "call.updated"; call: Call }
  | { type: "call.ended"; conversationId: number; missed: boolean }
  | { type: "presence"; userId: number; online: boolean; dnd?: boolean }
  /** You marked a conversation unread on another device (or this one): its count now. */
  | { type: "unread"; unread: UnreadCount }
  /** A server you're in changed, or you joined it. Each member gets their own view. */
  | { type: "server.updated"; server: ChatServer }
  /** You left or were removed, or the server was deleted. */
  | { type: "server.removed"; serverId: number }
  /** A thread or forum post you can see was started or changed (title, closed, tags, new messages). */
  | { type: "thread.updated"; thread: Thread }
  /** A thread was deleted, or its channel was. */
  | { type: "thread.removed"; serverId: number; channelId: number; threadId: number; conversationId: number }
  /** A message was pinned or unpinned in a server: refresh its pinned board. */
  | { type: "pins.updated"; serverId: number; channelId: number; messageId: number; pinned: boolean }
  /** You reached a new level in a server (rankUp: and a new raccoon rank). */
  | { type: "level.up"; serverId: number; level: number; rank: RaccoonRank; rankUp: boolean }
  /** A friend invited you to a server. */
  | { type: "server.invited"; invite: InvitePreview }
  /** Your request to make servers was approved or denied; to super admins, a new or decided request. */
  | { type: "server.request"; request: ServerCreatorRequest }
  /** Someone joined, left or changed state in a voice channel you can see (or you were taken out of one). */
  | { type: "voice.updated"; voice: VoiceChannelState }
  /** Someone in your voice channel played a soundboard sound. */
  | { type: "voice.sound"; channelId: number; userId: number; play: SoundboardPlay }
  /** An event you can see was made, changed, started, or moved on to next week. Each viewer gets their own view. */
  | { type: "event.updated"; event: ScheduledEvent }
  /** An event ended (and doesn't repeat), was canceled, or you can't see it any more. */
  | { type: "event.removed"; serverId: number; eventId: number }
  /** To people who RSVP'd: an event starts soon (minutes > 0) or just went live (minutes = 0). */
  | { type: "event.reminder"; event: ScheduledEvent; minutes: number }
  /** Your family changed: linked, unlinked, rules, or (for a kid) whether you can chat now. */
  | { type: "family.updated"; family: FamilyInfo }
  /** A new alert about one of your kids. */
  | { type: "family.alert"; alert: FamilyAlert }
  /** To a server's owner and admins: automod caught something with the alert action on. */
  | { type: "automod.alert"; event: AutomodEvent }
  /** Someone you can see started or stopped playing something (null: nothing now). */
  | { type: "activity"; userId: number; activity: Activity | null }
  /** Someone's name, colors, picture or custom status changed: to them and everyone who can see them. */
  | { type: "user.updated"; user: PublicUser }
  /** Your own settings changed on another device (presence, for now). */
  | { type: "me.updated"; user: Me }
  /** You and others in a server are playing the same game: a voice channel is open for it. */
  | { type: "play.together"; invite: PlayTogether }
  /** A kid's chores today changed (from Den Duty), to the kid and their parents (null: nothing to show). */
  | { type: "chores"; userId: number; chores: ChoresToday | null }
  /** To a bot: someone clicked one of its buttons. */
  | { type: "interaction.created"; interaction: BotInteraction }
  /** To whoever clicked: the bot's answer, shown only to them. */
  | { type: "interaction.reply"; interactionId: number; messageId: number; conversationId: number; botId: number; content: string }
  /** One of your reminders went off: the message it's about, if you can still see it. */
  | { type: "reminder"; reminder: Reminder; message: Message | null }
  /**
   * A couples kit you're in changed: fetch it again (/api/couples/:id), since each person sees
   * their own view. noteFrom is set when a love note just arrived for you.
   */
  | { type: "couples.updated"; conversationId: number; noteFrom?: number };

/** Events a client sends over the gateway. Everything else goes through the HTTP API. */
export type ClientEvent =
  | { type: "typing"; conversationId: number }
  | { type: "ping" }
  /** The app went to the background or idle (false), or is in front and used again (true). Phones get pushes while no app is active. */
  | { type: "active"; active: boolean };

export * from "./profanity.js";

/** A #rrggbb color, the only form name and text colors are saved in. */
export const isHexColor = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

export const isUsername = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 2 && s.length <= LIMITS.usernameLength && /^[\w.-]+$/.test(s);

// ---- Two-step sign-in, passkeys, the audit log and backups ------------------------------

/** POST /api/auth/login answers with this instead of the account when a second step is needed. */
export interface TwoFactorChallenge {
  twoFactor: {
    /** Sent back with the code or passkey; good for 5 minutes. */
    ticket: string;
    /** An authenticator app code (or a recovery code) works. */
    totp: boolean;
    /** One of the account's passkeys works. */
    passkey: boolean;
  };
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Settings → Sign-in: two-step sign-in and passkeys. */
export interface MyTwoFactor {
  /** An authenticator app is set up: password sign-ins ask for a code. */
  totp: boolean;
  /** Unused recovery codes. */
  recoveryCodesLeft: number;
  passkeys: PasskeyInfo[];
  /** Passkeys work on this server (it needs an https:// address, or localhost). */
  passkeysAvailable: boolean;
}

/** POST /api/me/2fa/totp/start: scan the QR code, or type the secret into the app. */
export interface TotpSetup {
  secret: string;
  uri: string;
  /** The otpauth:// address as an SVG QR code. */
  qrSvg: string;
}

export interface AuditEntry {
  id: number;
  /** The server it happened in; null for the whole instance (super admin actions). */
  serverId: number | null;
  actor: { id: number | null; name: string };
  /** e.g. "member.ban", "role.update", "signin.update". See AUDIT_ACTIONS for the wording. */
  action: string;
  target: { userId: number | null; name: string | null };
  details: string;
  createdAt: string;
}

/** How each audit action reads, for the log's list. */
export const AUDIT_ACTIONS: Record<string, string> = {
  "server.update": "changed the server settings",
  "server.image": "changed the server picture",
  "server.delete": "deleted a server",
  "server.transfer": "handed the server to",
  "member.role": "changed the rank of",
  "member.roles": "changed the roles of",
  "member.kick": "removed",
  "member.ban": "banned",
  "member.unban": "unbanned",
  "member.timeout": "timed out",
  "member.untimeout": "ended the timeout of",
  "member.nickname": "changed the nickname of",
  "voice.moderate": "changed the voice of",
  "voice.disconnect": "took out of voice",
  "voice.move": "moved in voice",
  "category.create": "made a category",
  "category.update": "renamed a category",
  "category.delete": "deleted a category",
  "levels.reset": "reset levels",
  "welcome.update": "changed the welcome screen",
  "role.create": "made a role",
  "role.update": "changed a role",
  "role.delete": "deleted a role",
  "role.reorder": "reordered the roles",
  "report.resolve": "handled a report about",
  "channel.create": "made a channel",
  "channel.update": "changed a channel",
  "channel.delete": "deleted a channel",
  "channel.reorder": "reordered the channels",
  "message.delete": "deleted a message by",
  "message.pin": "pinned a message by",
  "message.unpin": "unpinned a message by",
  "thread.update": "changed a thread",
  "thread.delete": "deleted a thread",
  "automod.update": "changed automod",
  "invite.create": "made an invite link",
  "emoji.add": "added an emoji",
  "emoji.update": "renamed an emoji",
  "emoji.delete": "deleted an emoji",
  "sticker.add": "added a sticker",
  "sticker.delete": "deleted a sticker",
  "sound.add": "added a soundboard sound",
  "sound.update": "changed a soundboard sound",
  "sound.delete": "deleted a soundboard sound",
  "webhook.create": "made a webhook",
  "webhook.update": "changed a webhook",
  "webhook.reset": "made a new webhook link",
  "webhook.delete": "deleted a webhook",
  "bot.add": "added a bot",
  "bot.remove": "removed a bot",
  "event.create": "scheduled an event",
  "event.update": "changed an event",
  "event.delete": "cancelled an event",
  "signin.update": "changed the sign-in switches",
  "account.password": "set a new password for",
  "account.unlink": "unlinked a sign-in from",
  "account.reset2fa": "turned off two-step sign-in for",
  "account.couplesOn": "switched on the couples kit for",
  "account.couplesOff": "switched off the couples kit for",
  "creator.allow": "let make servers:",
  "creator.deny": "stopped making servers:",
  "family.link": "linked a parent and kid:",
  "gifs.update": "changed GIF search",
  "lootden.update": "changed the LootDen link",
  "denduty.update": "changed the Den Duty link",
  "backup.create": "made a backup",
  "backup.download": "downloaded a backup",
  "backup.delete": "deleted a backup",
  "backup.restore": "asked to restore a backup",
  "backup.settings": "changed the backup schedule",
};

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export interface BackupSettings {
  /** Make a backup on its own every this many hours; 0 is off. */
  everyHours: number;
  /** How many backups to keep; older ones are deleted. */
  keep: number;
  /** Put uploaded files (pictures, attachments) in the backup, not only the database. */
  includeUploads: boolean;
}

export interface BackupStatus {
  settings: BackupSettings;
  /** Where backups are written, inside the container (DENDROP_BACKUP_DIR). */
  dir: string;
  backups: BackupFile[];
  lastError: string | null;
  running: boolean;
}

// ---- Safety: blocking, reports, deleting your account ------------------------------------

/** Why someone reported a message or person. */
export type ReportReason = "spam" | "harassment" | "hate" | "sexual" | "violence" | "self_harm" | "underage" | "other";

export const REPORT_REASONS: Record<ReportReason, string> = {
  spam: "Spam or scams",
  harassment: "Bullying or harassment",
  hate: "Hate",
  sexual: "Sexual content",
  violence: "Violence or threats",
  self_harm: "Self-harm",
  underage: "A child at risk",
  other: "Something else",
};

/**
 * A report. Reports of messages in a server's channels go to that server's moderators (anyone
 * who can delete messages); reports of people and of messages in DMs go to super admins.
 */
export interface Report {
  id: number;
  serverId: number | null;
  reporter: PublicUser | null;
  /** Who it's about (the message's author for a message). Null once they deleted their account. */
  reported: PublicUser | null;
  reason: ReportReason;
  /** The reporter's own words. */
  details: string;
  /** The reported message, if it still exists. */
  messageId: number | null;
  conversationId: number | null;
  /**
   * The message's text when it was reported: copied from a server channel, or, from an encrypted
   * chat, only what the reporter chose to share (the server can't read those messages).
   */
  quote: string | null;
  /** Where it was said, for showing ("#general", "a DM"). */
  place: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: PublicUser | null;
}
