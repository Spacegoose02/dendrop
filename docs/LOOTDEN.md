# LootDen and webhooks

[LootDen](https://github.com/Spacegoose02/lootden) is the family's self-hosted game library.
Dendrop links to it in two ways, and neither needs anything changed in LootDen:

- **Playing now:** what someone is playing in LootDen shows in Dendrop as their activity,
  "🎮 Playing Stardew Valley on Den-PC".
- **Alerts:** LootDen's alerts (new games, requests, deals) post into a Dendrop channel
  through an incoming webhook.

## Playing now

A super admin links LootDen in **Instance admin → LootDen**:

1. In LootDen, signed in as an admin: **Profile → Devices and tokens → Create token**. Copy it.
2. In Dendrop: paste LootDen's address (the one people open, e.g. `https://games.example.com`)
   and the token, then **Link LootDen**.

Every 30 seconds Dendrop asks LootDen who is playing what (`GET /api/family/now-playing`) and
which profiles it has (`GET /api/users`), using that token. The admin page shows whether the
last check worked and which LootDen profile goes with which Dendrop account.

**Which account is whose.** Both apps sign in through the same TinyAuth, so profiles usually
line up on their own: by email first, then by username. A LootDen profile with neither
matching a Dendrop account is listed as not matched, and its games aren't shown. (If LootDen
ever includes the TinyAuth subject in `/api/users`, Dendrop uses that first.)

**Who sees it.** Your friends and the people in a server with you, as a 🎮 line under your
name: in the friends list, the DM list and header, and a server's member list. It links to
the game's page in LootDen when there is one. You always see your own.

**Privacy.** Settings → Account → **Show what I'm playing** turns it off: then nobody else sees
it. It's on by default, like LootDen's own family board.

**Kids.** A kid account sees "Playing a game" for grown-ups' profiles, without the name or link,
the same way LootDen hides grown-ups' games from kid profiles. Games a LootDen kid profile is
playing are shown by name.

If LootDen can't be reached for 90 seconds, activities are cleared until it answers again.

## Incoming webhooks

A webhook is a secret address that posts into a server channel. The owner and admins make
them in **Server settings → Webhooks**: a name (what the messages are shown under) and a
channel. The full address is shown once, right after it's made; Dendrop keeps only a hash of
the secret. **New address** replaces a leaked one, and deleting a webhook keeps its messages.

Messages from a webhook show its name with an **app** tag. They go through the same channel
as everyone else's, so kid accounts' word filter still applies when they read them. Nobody can
edit them; the owner and admins can delete them. A webhook can post 30 times a minute.

### LootDen's alerts

LootDen sends its alerts through an [Apprise API](https://github.com/caronc/apprise-api)
server. Add the webhook as one more Apprise target: in LootDen, **Settings → Scanning &
alerts**, add the address with `https://` swapped for `jsons://` (or `http://` for `json://`):

```
jsons://chat.example.com/api/hooks/3/q2Xk...
```

Apprise's JSON target posts `{ "title", "message", "type" }`, which Dendrop shows as the title
on one line and the message under it. If you use a stateful Apprise key
(`…/notify/lootden`) instead of targets in LootDen, add the same URL to that key's config.

### Anything else

`POST` to the address with any of these bodies:

| Sender | Body |
| --- | --- |
| Apprise `json://` | `{"title": "...", "message": "..."}` |
| Apprise API, ntfy-style | `{"title": "...", "body": "..."}` |
| Discord-style | `{"content": "...", "username": "Shown as"}` (or `embeds[0].title` and `.description`) |
| Slack-style | `{"text": "..."}` |
| Forms | `title=...&body=...` as `application/x-www-form-urlencoded` |
| Plain | any `text/plain` body |

```sh
curl -H 'content-type: application/json' -d '{"content": "Backups done"}' \
  https://chat.example.com/api/hooks/3/q2Xk...
```

Answers: `204` posted, `400` no text, `404` wrong or deleted address, `429` too many posts
this minute. Text over 4,000 characters is cut, not refused.

## Still to come

The rest of the LootDen card in the roadmap: game nights as Dendrop events with a voice
channel, sharing screenshots from the family wall, seeding kid accounts from LootDen's kid
profiles, and game-link cards with **Send to PC**.
