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
  `
  -- Couples kit: private extras for a 1:1 DM between two adult accounts, once both opt in.
  -- Never available when either account is a kid account, and wiped if one becomes one.
  -- invited_by asked; accepted_at is set once the other person said yes.
  CREATE TABLE couples_kits (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    accepted_at TEXT
  );

  -- What's in a kit. body is ciphertext (the conversation key, like messages); the server
  -- only knows the kind. file is a view-once photo's encrypted bytes in <data>/uploads/<file>,
  -- removed once it's opened. deliver_at holds a love note back until then.
  CREATE TABLE couples_items (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES couples_kits(conversation_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    file TEXT,
    file_size INTEGER,
    deliver_at TEXT,
    notified_at TEXT,
    opened_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX couples_items_conversation ON couples_items(conversation_id, id);
  CREATE INDEX couples_items_deliver ON couples_items(deliver_at) WHERE deliver_at IS NOT NULL AND notified_at IS NULL;

  -- Answers to ideas (yes / no / maybe) and questions (an option's number). Only ever shown
  -- to the other person as a mutual match, or once both have answered a question.
  CREATE TABLE couples_votes (
    item_id INTEGER NOT NULL REFERENCES couples_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, user_id)
  );
  `,
  `
  -- Polls: one per poll message. In an encrypted chat question and options are NULL (they're
  -- in the encrypted body) and only option_count is known.
  CREATE TABLE polls (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question TEXT,
    options TEXT,
    option_count INTEGER NOT NULL,
    multi INTEGER NOT NULL DEFAULT 0,
    closes_at TEXT,
    closed_at TEXT
  );
  CREATE TABLE poll_votes (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, option)
  );

  -- Quick games (tic-tac-toe, rock paper scissors, dice): the state as JSON, server-checked.
  CREATE TABLE message_games (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL
  );

  -- Raccoon nudges are messages with no text and this set.
  ALTER TABLE messages ADD COLUMN nudge TEXT;

  -- "Ping me about this": personal reminders about a message.
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    fired_at TEXT
  );
  CREATE INDEX reminders_user ON reminders(user_id);
  CREATE INDEX reminders_due ON reminders(fired_at, remind_at);
  `,
  `
  -- Scheduled events (see ScheduledEvent). channel_id is a voice or stage channel, or null with
  -- location set. status is 'scheduled' or 'live'; an event that ends is deleted, or moved on a
  -- week when repeats = 'weekly'. reminded says the heads-up before it starts went out.
  -- Stage channels are server_channels rows with kind 'stage'.
  CREATE TABLE server_events (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES server_channels(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    repeats TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'scheduled',
    started_at TEXT,
    reminded INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX server_events_server ON server_events(server_id, starts_at);
  CREATE INDEX server_events_due ON server_events(status, starts_at);

  CREATE TABLE server_event_rsvps (
    event_id INTEGER NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE INDEX server_event_rsvps_user ON server_event_rsvps(user_id);
  `,
  `
  -- Threads: a side conversation (kind 'thread') off a channel message, or a post in a forum
  -- channel (no parent message). Its conversation_members match its channel's (see syncChannel).
  CREATE TABLE channel_threads (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    parent_message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    closed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX channel_threads_channel ON channel_threads(channel_id);

  -- Forum channels: the tags their posts can carry (JSON list of names).
  ALTER TABLE server_channels ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

  -- The pinned board: messages pinned in server channels and threads.
  CREATE TABLE message_pins (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pinned_at TEXT NOT NULL
  );
  CREATE INDEX message_pins_conversation ON message_pins(conversation_id);

  -- Every conversation that belongs to a server: channels and their threads. Server rules
  -- (automod, timeouts, moderators) look a conversation up here.
  CREATE VIEW channel_conversations AS
    SELECT conversation_id, id AS channel_id, server_id, NULL AS thread_id FROM server_channels
    UNION ALL
    SELECT t.conversation_id, t.channel_id, c.server_id, t.id FROM channel_threads t JOIN server_channels c ON c.id = t.channel_id;
  `,
  `
  -- Profiles: a picture, a banner (picture or color), an "about me", pronouns, and a custom
  -- status that can clear itself. Pictures live in <data>/uploads/<file>.
  ALTER TABLE users ADD COLUMN avatar_file TEXT;
  ALTER TABLE users ADD COLUMN avatar_type TEXT;
  ALTER TABLE users ADD COLUMN banner_file TEXT;
  ALTER TABLE users ADD COLUMN banner_type TEXT;
  ALTER TABLE users ADD COLUMN banner_color TEXT;
  ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN status_emoji TEXT;
  ALTER TABLE users ADD COLUMN status_text TEXT;
  ALTER TABLE users ADD COLUMN status_expires_at TEXT;
  -- Kids need a parent's OK for a profile picture and banner.
  ALTER TABLE kid_rules ADD COLUMN profile_pictures INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Soundboard: short sounds uploaded per server, played to everyone in a voice channel.
  CREATE TABLE server_sounds (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    volume INTEGER NOT NULL DEFAULT 100,
    file TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX server_sounds_name ON server_sounds(server_id, name COLLATE NOCASE);
  `,
  `
  -- Two-step sign-in. An authenticator app's secret (enabled_at is null until the first code is
  -- checked; last_step stops a code being used twice), one-time recovery codes (hashed), and
  -- passkeys (WebAuthn credentials: the public key and its signature counter).
  CREATE TABLE user_totp (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    enabled_at TEXT,
    last_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE user_recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    PRIMARY KEY (user_id, code_hash)
  );

  CREATE TABLE user_passkeys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX user_passkeys_user ON user_passkeys(user_id);

  -- Short-lived sign-in state: a password that still needs its second step ('login'), and
  -- passkey challenges ('passkey-login', 'passkey-add'). attempts counts wrong codes.
  CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    challenge TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );

  -- Who did what: a server's moderators' actions (server_id set) and the super admins' actions
  -- on the whole instance (server_id null). Names are copied in so entries still read well
  -- after the person, role or channel is gone.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_name TEXT,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_log_server ON audit_log(server_id, id);
  `,
  `
  -- Replies, @mentions and per-conversation notification settings.
  ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
  ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX message_mentions_user ON message_mentions(user_id, message_id);

  -- scope is 'conversation' (a DM, channel or thread) or 'server'; level is a NotifyLevel.
  CREATE TABLE notification_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    level TEXT NOT NULL,
    PRIMARY KEY (user_id, scope, target_id)
  );

  -- Full-text search over plain messages only. End-to-end encrypted messages never get here:
  -- the server can't read them, so they're searched on the device.
  CREATE VIRTUAL TABLE messages_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
  INSERT INTO messages_fts (rowid, body) SELECT id, body FROM messages WHERE key_version IS NULL AND deleted_at IS NULL AND body != '';
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.key_version IS NULL AND new.deleted_at IS NULL AND new.body != '' BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, key_version, deleted_at ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts (rowid, body) SELECT new.id, new.body WHERE new.key_version IS NULL AND new.deleted_at IS NULL AND new.body != '';
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END;

  -- Link previews the server fetched, by URL. image is a file in <data>/link-previews.
  CREATE TABLE link_previews (
    url TEXT PRIMARY KEY,
    data TEXT,
    image_id TEXT,
    fetched_at TEXT NOT NULL
  );
  ALTER TABLE kid_rules ADD COLUMN link_previews INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- LootDen's game nights also become server events, whose RSVPs go back to LootDen; players is
  -- the Dendrop accounts LootDen last said are playing.
  ALTER TABLE lootden_game_nights ADD COLUMN event_id INTEGER;
  ALTER TABLE lootden_game_nights ADD COLUMN players TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- The couples kit is hidden until a super admin switches it on for an account (super admins
  -- always have it; kid accounts never do). Anyone already using a kit keeps it.
  ALTER TABLE users ADD COLUMN couples_kit INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET couples_kit = 1 WHERE id IN (
    SELECT m.user_id FROM conversation_members m JOIN couples_kits k ON k.conversation_id = m.conversation_id
  );
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
