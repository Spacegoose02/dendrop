# Forwarding, saved messages, the mentions inbox and server folders

## Forwarding

Hover a message and pick ↪ (Forward), then pick a DM, group or server channel.

- The words and files are sent again from your device, so a message from an encrypted chat stays
  encrypted when it goes to another encrypted chat. Forwarding into a server channel makes it
  readable to that channel, like anything else posted there.
- `POST /api/conversations/:id/messages` takes `forwardOf: <messageId>`. The server checks you can
  see the original, then records its author and time as `forwarded: { authorId, authorName,
  createdAt }`. Forwarding a forward keeps the first author.
- A forward never pings anyone and is never a reply, even if the original did either.
- Forwarded messages show "↪ Forwarded · author, time" above the text and can't be edited.

## Saved messages

Hover a message and pick 🔖 to save it. Pick it again to unsave.

- Only you see your saved messages. Find them under **Saved messages** in the Direct messages
  sidebar. Clicking one jumps to it in its chat.
- `GET /api/saved`, `PUT /api/saved/:messageId`, `DELETE /api/saved/:messageId`. Your other
  devices get a `saved.updated` event.
- You can keep up to 500. Messages that are deleted, or in chats you've left, drop out of the
  list.

## Mentions inbox

**Mentions** in the Direct messages sidebar lists every message that pinged you, newest first:
@mentions of you, replies to you that ping, and @everyone. It covers DMs, groups, channels and
threads.

- `GET /api/mentions?before=<messageId>` pages back 30 at a time.

## Server folders

Group servers in the server list into folders.

- Drag a server onto another one to make a folder of both, or onto a folder to add it.
- Right-click (long-press on a phone) a server to start a folder, add it to one, take it out, or
  move it up and down. Right-click a folder to rename it, pick a color, move it, or ungroup it.
- A closed folder shows up to four of its servers' icons, with an unread marker and the pings
  from all of them.
- The layout is saved on your account (`GET`/`PUT /api/me/rail`), so it's the same on every
  device. Servers you join later show up at the end. Which folders are open is kept per device.
