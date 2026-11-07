# LootDen and webhooks

[LootDen](https://github.com/Spacegoose02/lootden) is the family's self-hosted game library.
Dendrop links to it without anything changed in LootDen:

- **Playing now:** what someone is playing shows as their activity, "🎮 Playing Stardew
  Valley on Den-PC".
- **Alerts:** LootDen's alerts (new games, requests, deals) post into a channel through an
  incoming webhook.
- **Game links:** a link to a LootDen game shows a card with its cover and **Send to PC**.
- **Game nights:** each planned night is announced in a channel and gets a voice channel.
- **Family wall:** new screenshots are shared to a channel, kid-safe where kids can read it.
- **Kid accounts:** LootDen's kid profiles can be made Dendrop kid accounts in one click.
- **Play limits:** a kid's LootDen bedtime and game time can count in their chat time rules.
- **Surprise us:** LootDen's game night pick can be shared into a channel.

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

## Game links

Paste a link to a game in LootDen (`https://games.example.com/games/<id>`) in any chat and it
shows a card: cover art, year, genres and size, and a link back to LootDen. Covers come
through Dendrop, so nobody needs to be signed in to LootDen to see them.

**Send to PC** is on the card for anyone whose account is matched with a LootDen profile. It
lists the PCs they use with LootDen's app (every PC for LootDen admins), and the game
downloads and installs there the next time that PC checks in. (In LootDen it shows as sent by
the admin whose token Dendrop uses.) Kid accounts, and anyone whose
LootDen profile is a kid profile, only get cards for kid-safe games.

## Game nights

In **Instance admin → LootDen → Game nights**, pick a text channel in a server you're the
owner or an admin of. Every game night planned in LootDen is then announced there by
LootDen (when, the game, who's playing, the note), and gets its own voice channel in that
server, like `game-night-mario-kart-cup`. Changing the night in LootDen edits the
announcement; once it's over or deleted, its voice channel goes as soon as nobody's in it.
Dendrop looks for changes every 5 minutes.

## Family wall

In **Instance admin → LootDen → Family wall**, pick a text channel, and new screenshots on
LootDen's family wall (including ones taken with **Ctrl+Shift+S** in LootDen's app) are
shared there with the picture and caption. Picking a channel starts from now: what's already
on the wall isn't posted.

**Kid-safe:** when a kid account can read that channel, only screenshots of games LootDen
marks as kid-safe are shared. Others are skipped, not held back for later.

## Kid accounts from LootDen

The **Accounts** list on the admin page marks LootDen's kid profiles. For one whose Dendrop
account isn't a kid account yet, **Make kid account** links it to a parent: the Dendrop
account of one of LootDen's admins. That's the same as linking them by hand in Family, with
the usual rules (the parent needs encryption turned on, and the kid starts with the default
kid-safe rules, which parents can change).

## Play limits for kids

For a kid account whose LootDen profile is matched, parents get two more switches in
**Family**, under the kid's time rules. Both are off until a parent turns them on:

- **LootDen bedtime:** chat closes during the bedtime set in LootDen (Settings, Profiles,
  Play time), in LootDen's time zone, the same as outside chat hours: the kid can still read,
  but not send, call or add friends. This is on top of Dendrop's own chat hours.
- **Games count as screen time:** minutes played in LootDen today (including a game that's
  running now) count toward the daily time, so chat and games share one budget. The budget is
  the kid's own Dendrop daily time when it has one; otherwise it's LootDen's play time for
  today (weekday or weekend, plus any bonus time a parent gave in LootDen). When it's used up,
  parents get the usual "used today's time" alert, once a day.

Dendrop reads each kid's limits from LootDen (`GET /api/users/:id/limits`) on the same
30-second check, so a change in LootDen shows up within a minute. If LootDen can't be
reached, the last limits it gave are kept; unlinking LootDen stops them applying.

LootDen doesn't count chat time against games: its own limits only see play time.

## Surprise us

LootDen's **Surprise us** spin (Game night) gets a **Share to chat** button once LootDen has
a chat webhook: in LootDen, **Settings → Scanning & alerts → Chat webhook**, paste the
address of a Dendrop webhook (Server settings → Webhooks). The pick is posted as a link to the
game, so Dendrop shows its card with the cover.
