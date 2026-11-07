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
