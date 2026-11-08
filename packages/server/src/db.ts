import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Ordered schema migrations. Append only: never edit one that has shipped, add a new one.
 * PRAGMA user_version counts how many have run.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    password_hash TEXT,
    oidc_subject TEXT UNIQUE,
    is_super_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- One row per pair, stored with the lower id first. requester_id says who asked.
  CREATE TABLE friendships (
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    is_group INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    -- For 1:1 DMs: "lowId:highId", so each pair has exactly one conversation.
    dm_key TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_message_at TEXT
  );

  CREATE TABLE conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    last_read_message_id INTEGER,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX conversation_members_user ON conversation_members(user_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, id);
  `,
  `
  ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1;

  -- Files sent in messages. The bytes live in <data>/uploads/<id>.
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  `,
  `
  -- Where to send phone notifications (UnifiedPush / Web Push endpoints).
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT,
    auth TEXT,
    provider TEXT NOT NULL,
    device_name TEXT,
    created_at TEXT NOT NULL,
    last_sent_at TEXT
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  -- Small server-wide settings, such as the VAPID keys made on first start.
  CREATE TABLE server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- End-to-end encryption. The server keeps public keys, private keys encrypted with a
  -- passphrase it never sees, and conversation keys encrypted to each member's public key.
  ALTER TABLE users ADD COLUMN public_key TEXT;
  ALTER TABLE users ADD COLUMN key_backup TEXT;
  ALTER TABLE messages ADD COLUMN key_version INTEGER;

  CREATE TABLE conversation_keys (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The public key this copy was encrypted to, so a reset shows up as a missing copy.
    recipient_key TEXT NOT NULL,
    wrapped TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, version, user_id)
  );
  `,
  `
  -- Chat servers. Each channel keeps its messages in a conversation of kind 'channel', whose
  -- conversation_members rows are the people who can see the channel (kept in sync here).
  ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'dm';
  ALTER TABLE users ADD COLUMN can_create_servers INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id),
    is_public INTEGER NOT NULL DEFAULT 0,
    member_invites INTEGER NOT NULL DEFAULT 1,
    -- Pictures live in <data>/uploads/<file>; the type is kept for serving.
    icon_file TEXT,
    icon_type TEXT,
    banner_file TEXT,
    banner_type TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE server_members (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    nickname TEXT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE INDEX server_members_user ON server_members(user_id);

  CREATE TABLE server_bans (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE server_channels (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX server_channels_server ON server_channels(server_id, position);

  -- Who a locked channel was opened to (owners and admins always see it).
  CREATE TABLE channel_access (
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE server_invites (
    code TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Set for an invite sent to one friend.
    for_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX server_invites_server ON server_invites(server_id);
  CREATE INDEX server_invites_for ON server_invites(for_user_id);

  -- Asking a super admin for permission to make servers. One row per person.
  CREATE TABLE server_creator_requests (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  `
  -- Voice channels. Who is in one is kept in memory, like calls.
  ALTER TABLE server_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
  `,
  `
  -- Kid-safe chat. A kid account is one with at least one linked parent.
  CREATE TABLE family_links (
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (kid_id, parent_id)
  );
  CREATE INDEX family_links_parent ON family_links(parent_id);

  -- One-time codes a parent gives a kid to link their account.
  CREATE TABLE family_link_codes (
    code TEXT PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- The rules for a kid account, set by its parents. Times are HH:MM in the kid's time zone.
  CREATE TABLE kid_rules (
    kid_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    profanity_filter INTEGER NOT NULL DEFAULT 1,
    blocked_words TEXT NOT NULL DEFAULT '[]',
    approve_friends INTEGER NOT NULL DEFAULT 1,
    can_join_servers INTEGER NOT NULL DEFAULT 0,
    allowed_from TEXT,
    allowed_until TEXT,
    daily_minutes INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC'
  );

  -- Minutes a kid had the app open, per day in their time zone.
  CREATE TABLE kid_usage (
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kid_id, day)
  );

  -- Things a parent is told about. While an alert about a conversation is open, the kid's
  -- parents can read that conversation (read only), and every look is written to family_audit.
  CREATE TABLE family_alerts (
    id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER,
    other_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX family_alerts_kid ON family_alerts(kid_id, resolved_at);

  -- What a kid deleted, kept for their parents until a parent marks the alert done. The body
  -- is kept exactly as it was: ciphertext for encrypted chats, which parents open with their
  -- own copy of the conversation key. files is JSON; the bytes stay in <data>/uploads.
  CREATE TABLE kid_deleted_messages (
    message_id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    key_version INTEGER,
    files TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );

  -- Every time a parent opens a kid's chat. Kids see this list.
  CREATE TABLE family_audit (
    id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    alert_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX family_audit_kid ON family_audit(kid_id, id);

  -- A friendship with a kid waits here until a parent approves it.
  ALTER TABLE friendships ADD COLUMN held_for_parent INTEGER NOT NULL DEFAULT 0;
  -- Where a parent's alerts are also posted (ntfy, Apprise, Home Assistant...).
  ALTER TABLE users ADD COLUMN family_webhook TEXT;
  `,
  `
  -- Automod: each server's rules (JSON, see AutomodSettings), what it caught, and timeouts.
  CREATE TABLE server_automod (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE automod_events (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel_id INTEGER,
    rule TEXT NOT NULL,
    actions TEXT NOT NULL,
    reason TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX automod_events_server ON automod_events(server_id, id);

  -- Someone who can't post or talk in a server until a time. set_by is null for automod.
  CREATE TABLE server_timeouts (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until TEXT NOT NULL,
    reason TEXT NOT NULL,
    set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  -- Spam checks look back over someone's recent messages.
  CREATE INDEX messages_author_time ON messages(author_id, created_at);
  `,
  `
  -- Incoming webhooks: a secret address that posts into a server text channel. Only a hash of
  -- the secret is kept. Messages they post keep the webhook's name even after it's deleted.
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX webhooks_channel ON webhooks(channel_id);
  ALTER TABLE messages ADD COLUMN webhook_id INTEGER;
  ALTER TABLE messages ADD COLUMN webhook_name TEXT;
  -- Show friends and server-mates what you're playing (LootDen).
  ALTER TABLE users ADD COLUMN share_activity INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- LootDen game nights announced in Dendrop: the announcement and the night's voice channel.
  -- signature is what the announcement says, so a change in LootDen updates it.
  CREATE TABLE lootden_game_nights (
    lootden_id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    voice_channel_id INTEGER,
    message_id INTEGER,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Custom colors for your name and your messages (#rrggbb). Null uses the theme's colors;
  -- clients nudge a color that's hard to read on the current theme until it reads well.
  ALTER TABLE users ADD COLUMN name_color TEXT;
  ALTER TABLE users ADD COLUMN text_color TEXT;
  `,
  `
  -- Chores first: a kid can't chat until today's Den Duty chores are done.
  ALTER TABLE kid_rules ADD COLUMN chores_first INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Kid time rules that follow LootDen's play limits: its bedtime closes chat, and its game
  -- time shares the daily time with chat. Off until a parent turns them on.
  ALTER TABLE kid_rules ADD COLUMN lootden_bedtime INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kid_rules ADD COLUMN lootden_play_time INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Voice channels opened while two or more people in a server play the same game (from
  -- LootDen's Playing now). game is the title in lowercase. voice_channel_id is null when a
  -- moderator deleted the channel: it isn't opened again until everyone has stopped.
  CREATE TABLE play_together_channels (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    voice_channel_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (server_id, game)
  );
  -- Owners and admins can turn these off for their server.
  ALTER TABLE servers ADD COLUMN play_together INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- Custom server roles: ranked (position 0 highest, below the owner and admins), with an
  -- optional color and a JSON list of permissions. Members can hold any number of them.
  CREATE TABLE server_roles (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    position INTEGER NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX server_roles_server ON server_roles(server_id, position);

  CREATE TABLE server_member_roles (
    server_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
  );
  CREATE INDEX server_member_roles_role ON server_member_roles(role_id);

  -- Roles whose members can see a locked channel, alongside the people picked in channel_access.
  CREATE TABLE channel_role_access (
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );
  `,
  `
  -- Bots: accounts with no password that post through the bot API (/api/bot/v1) with a token.
  -- Only a hash of the token is kept. A deleted bot keeps its users row (is_bot = 1, no bots
  -- row) so its old messages still show its name.
  ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE bots (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    events_url TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    reads_messages INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE INDEX bots_owner ON bots(owner_id);

  -- Buttons under a bot's message (JSON, see MessageButton).
  ALTER TABLE messages ADD COLUMN buttons TEXT;

  -- Clicks on bots' buttons. A bot can answer one within BOT_LIMITS.replyMinutes.
  CREATE TABLE bot_interactions (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    button_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    replied_at TEXT
  );
  `,
  `
  -- Linked sign-ins: a Google account next to the password and TinyAuth ones.
  ALTER TABLE users ADD COLUMN google_subject TEXT;
  ALTER TABLE users ADD COLUMN google_email TEXT;
  CREATE UNIQUE INDEX users_google_subject ON users(google_subject);
  -- A kid account a parent made under theirs. The parents look after how it signs in.
  ALTER TABLE users ADD COLUMN managed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `,
  `
  -- Custom emoji and stickers, per server. The pictures live in <data>/uploads/<file>.
  CREATE TABLE server_emojis (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    content_type TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX server_emojis_name ON server_emojis(server_id, name COLLATE NOCASE);

  CREATE TABLE server_stickers (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL,
    content_type TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX server_stickers_name ON server_stickers(server_id, name COLLATE NOCASE);

  -- Reactions. emoji is the emoji itself, or "c:<id>" for a custom emoji, whose name and
  -- whether it moves are kept so the reaction still reads well after the emoji is deleted.
  CREATE TABLE message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    custom_name TEXT,
    custom_animated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  );

  -- GIFs for kids: off until a parent turns them on.
  ALTER TABLE kid_rules ADD COLUMN gifs INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Server levels: XP members earn by chatting, which gives raccoon ranks. On unless turned off.
  ALTER TABLE servers ADD COLUMN levels INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE server_xp (
    server_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    last_award_at TEXT,
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
  );
  CREATE INDEX server_xp_rank ON server_xp(server_id, xp DESC);

  -- The welcome screen: a hello, rules, and roles members pick themselves (JSON, see
  -- ServerWelcome). welcomed_at is when a member went through it and agreed to the rules.
  CREATE TABLE server_welcome (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '[]',
    require_agree INTEGER NOT NULL DEFAULT 0,
    roles TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  ALTER TABLE server_members ADD COLUMN welcomed_at TEXT;
  `,
];

export function now(): string {
  return new Date().toISOString();
}

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Runs fn in a transaction. node:sqlite has no helper for it. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
