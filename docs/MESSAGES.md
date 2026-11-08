# Search, replies, mentions, notifications, formatting and link previews

Everyday message features. Everything here respects end-to-end encryption: the server never
reads an encrypted chat to make any of it work.

## Search

Press **Ctrl+F** (or Ctrl+K, or the 🔍 in a chat's header). Search covers:

- **Server channels and threads** you can see (locked channels follow who can see them), and
  **DMs and group chats that aren't end-to-end encrypted** (yet). The server keeps a full-text
  index (SQLite FTS5) of plain messages only. Filters: where (this chat, this server, or
  everywhere), who sent it, and whether it has a link, a file or a picture. The last word you
  type matches as a prefix, and `"quoted words"` must appear together.
- **Encrypted chats are searched on your device.** Searching an encrypted chat downloads its
  history (up to the latest 3000 messages), decrypts it in the app and looks there, so the server
  never sees the words or the results. Decrypted history is kept in memory only, for the session.
  In "Everywhere", tick *Also search my encrypted chats on this device* to include them.

Click a result to jump to it: the chat opens, loads older messages until it reaches it, and
highlights it. Kids' results are masked by their family filter, like everything they read.

API: `GET /api/search?q=&conversationId=&serverId=&authorId=&has=link|file|image&before=`
returns `{ hits: SearchHit[], next }` (pass `next` as `before` for the next page).

## Replies and @mentions

Hover a message and press ↩ to reply. The reply shows a line with what it answers; click it to
jump there. By default the person you answer is pinged; the **@ On / @ Off** switch above the
composer turns that off for one reply.

Type `@` for a list of people in the chat, or `@everyone`. Mentions are stored as `<@userId>`
so they keep working when someone changes their name, and show as `@Name`. Messages that ping
you are highlighted.

- In **group chats** anyone can use `@everyone`.
- In **servers**, `@everyone` only pings when the sender has the new **Mention @everyone**
  permission (the owner and admins always do). Without it, the message still posts but pings no
  one.
- **Encrypted chats:** the server can't read the text, so the app tells it who the message pings
  (just the user ids), and the reply's message id. Nothing else about the content leaves the
  device. Pings are always kept to people in the conversation.

API: `POST /api/conversations/:id/messages` takes `replyToId`, `replyPing` (default true) and,
for encrypted messages, `mentions` (user ids) and `mentionsEveryone`. Messages carry `replyTo`,
`mentions` and `mentionsEveryone`.

## Notification settings

The 🔔 in a chat's header sets how much you hear about it:

| Setting | What you get |
| --- | --- |
| All messages | A notification for every message (the default) |
| Only @mentions | Only when someone pings you, replies to you, or uses @everyone |
| Nothing (muted) | No notifications and no unread dot (a ping still shows its highlight) |

In a server you can set the **whole server** too; a channel with no setting of its own follows
the server, and a thread follows its channel. Settings apply everywhere: phone pushes, the PC
app's notifications and unread dots. The gateway's `message.created` event says, per person,
`notify`, `mentioned` and `muted`; pushes still never include any message text.

API: `GET /api/notification-settings`, `PUT /api/notification-settings` with
`{ conversationId | serverId, level: "all" | "mentions" | "nothing" | null }`.

## Formatting

| Type | Shows as |
| --- | --- |
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `__underline__` | underline |
| `~~strike~~` | ~~strike~~ |
| `` `code` `` | `code` |
| ```` ```js ```` … ```` ``` ```` | a code block with a Copy button |
| `\|\|spoiler\|\|` | hidden until clicked |
| `> quote` | a quote |
| `# Heading`, `## …`, `### …` | headings |
| `- item`, `1. item` | lists |

A backslash shows the next character as typed (`\*not italic\*`). Formatting is turned into
page elements directly, never HTML, so a message can't inject markup; links are only ever
http(s) and open in a new tab.

## Link previews

Cards with a page's title, a line of text and a picture under links. **Off until a super admin
turns them on** (Admin → Link previews), because the server fetches outside pages.

- The **server fetches** the page and its picture and caches both (a day for pages, an hour for
  pages with nothing to show), so people's devices never contact the site just by opening a chat.
  Pictures are only kept if their bytes really are PNG, JPEG, GIF or WebP (up to 3 MB).
- **It never reaches your own network** (server-side request forgery): only http and https on
  ports 80 and 443, no links with passwords, no single-word or `.local` names, and every address
  a name resolves to must be public. Private, loopback, link-local (cloud metadata), carrier NAT,
  multicast and reserved ranges are refused, including IPv4 hidden inside IPv6. It connects to the
  address it checked, so a name can't switch to a private address between the check and the
  connection, and every redirect is checked the same way. Pages are read up to 512 KB with a short
  timeout.
- **Encrypted chats** get no previews unless you turn on *Link previews in encrypted chats* in
  Settings (on that device only), since asking for one shows the server the link.
- **Kids** get none until a parent turns on *Link previews* in their rules. Words their filter
  blocks are masked in cards too.
