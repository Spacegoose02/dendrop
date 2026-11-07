# Bots

A bot is an account a program uses to post into server channels, with buttons people can
click. It's what lets Den Duty put **Approve** and **Send back** on a "Kit finished the dishes"
message, or answer a helpdesk ask in chat.

Incoming webhooks ([Server settings → Webhooks](../packages/web/src/Webhooks.tsx)) are still the
simplest way to post a one-way alert. Use a bot when something needs to answer, edit its
messages later, or hear clicks.

## Safety rules

- **Bots only live in server channels.** They can't sign in, can't be friends, and so are never
  in DMs, group chats, calls or anything end-to-end encrypted. Asking to friend one is refused.
- **Grown-ups only.** Kid accounts can't make bots. Making one needs a super admin, someone
  allowed to make servers, or someone who already owns or admins a server.
- **A server's owner or admins add a bot**, the way they'd add a member, and kick it the same
  way. They can add bots they own, bots marked *public*, or (super admins) any bot. A bot is
  always a plain member: it can't be made an admin or given the server. Locked channels stay
  hidden from it unless it's picked for them.
- **Reading is off by default.** A bot only hears about clicks on its own buttons and its own
  messages. Its owner can turn on *reads messages* to get the text of everything said in the
  channels it can see; the Bots tab shows which bots read.
- **Same rules as everyone.** Its messages go through the server's automod, and it can post
  30 times a minute. Kids can click buttons only during their allowed hours, and people timed
  out can't click. A reply to a kid's click that trips their family filter isn't shown.
- **Tokens are secret.** Only a hash is stored; the token is shown once, and *New token* closes
  the old one's connections at once. Deleting a bot takes it out of every server; its messages
  stay.

## Making one

Server settings → **Bots** → *Make a bot*. It's added to that server and its token is shown
once. *Settings* on the bot sets its description, events address, *reads messages* and *public*,
shows its signing secret, and makes a new token.

## The bot API

Base: `https://<your dendrop>/api/bot/v1`, with the header `Authorization: Bot <token>`.
A session cookie never counts here, and a bot token counts nowhere else.

| Call | What it does |
| --- | --- |
| `GET /me` | The bot. |
| `GET /servers` | Servers it's in, with the channels it can see. |
| `GET /channels/:channelId/messages?before=&limit=` | History (needs *reads messages*). |
| `POST /channels/:channelId/messages` | `{ content, buttons? }`: posts in a text channel. |
| `PATCH /messages/:id` | `{ content?, buttons? }`: edits its own message. `buttons: null` or `[]` removes them. |
| `DELETE /messages/:id` | Deletes its own message. |
| `POST /interactions/:id/reply` | `{ content }`: answers a click; only the clicker sees it. Once per click, within 15 minutes. |
| `GET /gateway` | WebSocket of events (send `{"type":"ping"}` to keep it alive). |

### Buttons

Up to 5 per message:

```json
{
  "content": "⏳ Kit finished 🍽️ Dishes, waiting for a grown-up to check",
  "buttons": [
    { "id": "approve:41", "label": "Approve", "style": "success" },
    { "id": "reject:41", "label": "Send back", "style": "danger" },
    { "url": "https://denduty.example/chores", "label": "Open Den Duty" }
  ]
}
```

`id` is what the bot gets back when it's clicked (letters, numbers, `. : - _`, up to 64).
`style` is `primary`, `secondary` (default), `success` or `danger`. `disabled: true` greys one
out. A button with `url` instead of `id` just opens the link.

### Events

Events come over the gateway and, if the bot has an **events address**, are POSTed there too:
`ready`, `message.created`, `message.updated`, `server.updated`, `server.removed` and
`interaction.created`. Each POST is JSON with these headers:

- `X-Dendrop-Event`: the event type
- `X-Dendrop-Timestamp`: Unix seconds
- `X-Dendrop-Signature`: `sha256=` + hex HMAC-SHA256 of `<timestamp>.<body>` with the signing secret

Check the signature (and that the timestamp is recent) before trusting a POST.

### Clicks

A click sends the bot an `interaction.created` event:

```json
{ "type": "interaction.created", "interaction": {
  "id": 12, "botId": 5, "messageId": 301, "conversationId": 9, "serverId": 1, "channelId": 2,
  "buttonId": "approve:41", "role": "owner",
  "user": { "id": 1, "username": "mom", "displayName": "Mom" }, "createdAt": "…" } }
```

`role` is the clicker's role in the server, so a bot can, say, only let grown-ups approve.

- **Over the gateway**, answer with `POST /interactions/:id/reply` and edit the message with
  `PATCH /messages/:id`.
- **Over the events address**, Dendrop waits up to 3 seconds for the answer, which can be:

  ```json
  { "reply": "Approved. Kit gets +5 ✨", "update": { "content": "✅ Approved by Mom", "buttons": [] } }
  ```

If the bot has neither a gateway connection nor an events address, the click says the bot
isn't running.

## Example: a tiny gateway bot (Node)

```js
import WebSocket from "ws";
const BASE = "https://chat.example.net/api/bot/v1";
const headers = { authorization: `Bot ${process.env.TOKEN}`, "content-type": "application/json" };

const ws = new WebSocket(BASE.replace("http", "ws") + "/gateway", { headers });
setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 25_000);
ws.on("message", async (raw) => {
  const e = JSON.parse(raw);
  if (e.type !== "interaction.created") return;
  const { id, messageId, user, role } = e.interaction;
  if (role === "member") {
    await fetch(`${BASE}/interactions/${id}/reply`, { method: "POST", headers, body: JSON.stringify({ content: "Only grown-ups can approve" }) });
    return;
  }
  await fetch(`${BASE}/messages/${messageId}`, { method: "PATCH", headers, body: JSON.stringify({ content: `✅ Approved by ${user.displayName}`, buttons: [] }) });
});
```

## Next

- Den Duty: post chore checks with Approve / Send back buttons and helpdesk answers through a
  bot instead of the plain "Den Duty" posts ([DENDUTY.md](DENDUTY.md)).
- Slash commands, and bots holding custom server roles once those land.
