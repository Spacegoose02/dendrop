# Threads, forum channels and the pinned board

## Threads

Hover any message in a text or voice channel and press 🧵 to start a thread off it. The thread
opens in a pane beside the channel (full screen on phones), and the message shows a chip with the
thread's title, reply count and last activity. Pressing the chip again opens the same thread: a
message has at most one, and threads don't have threads.

- **Who sees it:** exactly the people who can see the channel. Locking the channel, or taking
  someone out of it, takes them out of its threads too.
- **Title:** the start of the message, unless you give one. Whoever started the thread, and
  anyone with Manage channels, can rename it.
- **Closing:** the starter or a moderator can close a thread so it's read only. People with
  Manage channels can still post in it, and only they can reopen one.
- **Deleting:** Manage channels or Delete messages. Deleting the channel deletes its threads.
- **Rules:** automod, timeouts and the kid filter apply to thread messages and titles just as in
  the channel. Threads aren't end-to-end encrypted, like channels.

## Forum channels

A forum is a channel kind (next to text and voice) that holds posts instead of one chat. Each
post is a thread with a title, a first message and up to 5 tags picked from the forum's list
(up to 20, set when making or editing the channel). The forum lists posts by latest activity,
with tag filters and a switch to show closed posts. Plain messages, webhooks and bots can't post
into a forum itself.

## The pinned board

People with the new **Pin messages** permission (and the owner and admins) can pin any message
in a channel or thread with 📌. The 📌 button in a channel's header opens the board: every pin
in the server you can see, newest first, or just this channel and its threads. Each card says
where it's from and has Jump and Unpin. Up to 50 pins per channel or thread; deleting a message
unpins it. Pin messages isn't a moderator permission, so kids can hold it.

## API

| Call | What it does |
| --- | --- |
| `POST /api/messages/:id/thread` `{ title? }` | Start a thread off a channel message, or get the one it has |
| `GET /api/servers/:id/channels/:channelId/threads?closed=true` | A channel's threads or a forum's posts |
| `POST /api/servers/:id/channels/:channelId/threads` `{ title, body, tags? }` | New forum post |
| `GET/PATCH/DELETE /api/threads/:id` | Read, change (`title`, `closed`, `tags`) or delete a thread |
| `PUT/DELETE /api/messages/:id/pin` | Pin or unpin |
| `GET /api/servers/:id/pins?channelId=` | The pinned board |

Thread messages go through `/api/conversations/:conversationId/messages` like a channel's.
Gateway events: `thread.updated`, `thread.removed` and `pins.updated`; messages carry `thread`
and `pinned`.
