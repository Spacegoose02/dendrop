# Audit log

Dendrop keeps a record of who changed what, so moderators and admins can see what happened
after the fact.

## A server's audit log

**Server settings → Audit log**, for the owner, admins and anyone whose roles let them
manage the server, channels, roles or automod, remove and ban, time out, or delete
messages. It lists, newest first:

- **Members:** removed, banned, unbanned, timed out (with how long and why), timeout ended,
  rank changed, roles changed, levels reset.
- **Roles and channels:** made, changed (which settings), deleted, reordered.
- **Messages and threads:** someone else's message deleted, pinned or unpinned; someone else's
  thread closed, renamed or deleted.
- **The server:** settings, icon and banner, welcome screen, automod rules, invite links,
  emoji and stickers, webhooks, bots and events.

Pick a kind in **Show** to narrow it down. Names are saved with each entry, so it still reads
right after a channel, role or person is gone. Only changes that worked are logged. Messages
themselves are never copied into the log.

The **Mod log** tab is still there for what automod caught and who is timed out right now.

## The instance log

**Instance admin → Audit log**, for super admins: sign-in switches, passwords set for someone,
unlinked sign-ins, two-step sign-in reset for someone, who may make servers, deleted servers,
linking parents and kids, GIF, LootDen and Den Duty settings, and backups.
