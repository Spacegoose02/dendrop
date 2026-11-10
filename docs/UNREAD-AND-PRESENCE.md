# Unread counts, mark as unread, Do Not Disturb and Invisible

## Unread counts

Every conversation and channel you can see keeps a count of messages from other people that you
haven't read yet, and how many of those ping you (an @mention of you, or @everyone).

- `GET /api/unread` lists `{ conversationId, count, mentions }` for everything with unread
  messages. Counts stop at 100 (the app shows "99+").
- The sidebar shows a grey number for unread messages and a red number when you were pinged
  (the number is then the pings). A server's icon gets a red number with all its channels' pings.
- Muted chats still don't count unless you're pinged, as before.

## Mark as unread

Hover a message from someone else and pick ◉ (Mark unread from here).

- `POST /api/conversations/:id/unread { messageId }` returns the new count and sends an `unread`
  event to your other devices.
- It only moves *your* unread marker. Read receipts that other people already saw never move back.
- Reading the chat again (opening it, or a new message arriving while it's open) clears it.

## Your presence

Click the dot on your avatar in the bottom-left corner.

| Choice | What friends see | Notifications |
| --- | --- | --- |
| Online | Green dot | As usual |
| Do not disturb (1 hour, 8 hours, or until you turn it off) | Red dot, "Do not disturb" | None: no pushes, desktop popups or sounds. Calls still ring. |
| Invisible | Offline, even while you're connected | As usual |

- `PUT /api/me/presence { presence: "online" | "dnd" | "invisible", minutes? }`. `minutes` only
  applies to `dnd`; leave it out for "until I turn it off". It's saved on your account, so it
  follows you to every device, which get a `me.updated` event.
- A timed Do Not Disturb ends by itself; after that you count as online again.
- While you're invisible, connecting and disconnecting don't tell friends anything.
