# Kid-safe chat

Kid accounts are ordinary Dendrop accounts linked to one or more parents. Parents set the
rules, get alerts, and can look at a kid's chat when something comes up. The kid is always
told what their parents can see, and so is everyone they chat with.

## Linking a kid to a parent

- A parent turns on end-to-end encryption, then makes a **link code** (good for 24 hours) and
  the kid types it in on their own account. The app shows the kid what their parents will be
  able to see before they link.
- Or a super admin links two accounts directly (`POST /api/admin/family`), for families who
  set the kids' accounts up for them.
- A kid can have up to four parents. Kids can't unlink themselves; a parent can unlink
  themselves, and a super admin can unlink everyone. When the last parent goes, the account is
  a normal account again and its rules, alerts and kept copies are deleted.
- Kid accounts can't be parents, and super admins can't be kids.

LootDen's kid profiles can feed this later (both apps sign in through TinyAuth, so accounts
line up by OIDC subject); that's part of the LootDen integration.

## How parents see a chat when it's end-to-end encrypted

DMs are end-to-end encrypted, so the server can't read them, and that has to stay true for
kids too. The choice:

**Parents are "guardians" of every conversation their kid is in.** Each conversation key is
wrapped for the members *and* for the kid's parents. The server refuses a new key that leaves
a parent out, and when a parent is linked (or resets their keys) the conversation shows them as
missing a copy, so the next message makes a new key version that includes them. Parents can
read messages sent after they were linked, never older ones.

Having a copy of the key isn't enough to read anything: the parent isn't a member, so the
server won't give them the messages. It only does while an **alert** about that conversation
is open (see below), and only read only. Marking the alert done closes the chat again.

Why this way, rather than the alternatives:

- *The kid's device forwards copies to the parent*: works with E2EE too, but only for what the
  kid's app chooses to send, and a parent couldn't see context around an alert.
- *Server-side access for parents (no E2EE for kids)*: simpler, but the server could then read
  kids' chats, and so could anyone with the database. That breaks the main promise.
- *Parents as hidden members*: the kid's friends wouldn't know. Instead **everyone in a chat
  with a kid sees which parents can read it** (`Conversation.guardians`), next to the security
  codes.

Every time a parent opens a kid's chat it's written to an audit log the kid can see ("Mom
looked at your chat with Sam on Saturday").

## Alerts

Parents get alerts in the app and, if they set one, on a **webhook** (ntfy, Apprise, Home
Assistant and the like). Webhooks never contain message text, only "Kit deleted a message".

| Alert | Raised by | Opens the chat to parents |
| --- | --- | --- |
| Deleted message | The server, when a kid deletes their own message | Yes, with the deleted message put back |
| Filtered word | The kid's app (it never says which word), or the server for plain messages | Yes |
| Help | The kid, asking a parent to look at a chat | Yes |
| New friend | The server, when a kid gets a new friend | No (approve or decline it) |
| Time's up | The server, when the daily minutes run out | No |

**Deleted messages** are kept exactly as they were, ciphertext and files included, until a
parent marks the alert done; then the copy is erased.

## Rules

Each kid has rules their parents set:

- **Profanity filter** (on by default) with extra words per kid. It runs on the kid's device,
  because the server can't read encrypted chats: it hides filtered words in what the kid reads
  and stops the kid sending them. For plain messages (server channels, or chats before
  everyone has set up encryption) the server checks too. The filter is in
  `packages/shared/src/profanity.ts`; Automod uses the same engine (see [AUTOMOD.md](AUTOMOD.md)).
- **Approve new friends** (on by default). A friendship with a kid waits ("held") until a
  parent of each kid in it says yes; until then they can't start a chat. A kid's own parents
  don't need approving.
- **Chat servers** (off by default): whether the kid may join or make chat servers.
- **Chat hours** (like 07:00 to 20:30, in the kid's time zone) and a **daily limit** in minutes
  the app is open. Outside them the kid can still read, but can't send, edit, call, join voice,
  start chats or add friends. The server enforces these.
- **Chores first** (off by default, needs [Den Duty](DENDUTY.md) linked): no chat until today's
  Den Duty chores are done. Den Duty time-outs can also pause chat; see [DENDUTY.md](DENDUTY.md#chat-pauses).

## What it can't do

- A modified app on the kid's device could skip the client-side filter. The server still keeps
  deleted messages and enforces time, friend and server rules.
- A parent can't read messages from before they were linked, or from a key version made before
  they reset their own keys.
- Calls aren't recorded, and a call that's going when chat time ends isn't cut off yet.

## Bots

Bots ([BOTS.md](BOTS.md)) only live in server channels: they can't be friends, so they're never
in a kid's DMs or group chats. Kids can't make bots. A bot only reads channel messages when its
owner turns that on, and the server's Bots tab says so. Clicking a bot's button counts as
chatting, so it follows the kid's allowed hours, and a bot's private reply to a kid is checked
against their family filter.
