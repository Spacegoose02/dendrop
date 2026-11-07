# Automod

Automod checks messages in a chat server's channels before they're saved. Channels aren't
end-to-end encrypted, so the server can read them; DMs and group chats are encrypted and
automod never sees them.

The owner, admins, and anyone with a custom role that has **Manage automod** set it up in **Server settings → Automod**. Every rule starts off.

## Rules

| Rule | Catches | Settings |
| --- | --- | --- |
| Blocked words | Swears and your own words, even disguised (`f*ck`, `sh1t`, `fuuuck`). Same filter as kid-safe chat (`packages/shared/src/profanity.ts`). | Use the built-in list or not; your words, one per line (`heck*` matches anything starting with heck). |
| Spam and flooding | Too many messages too fast, the same message over and over, too many @mentions. | Messages per seconds; repeats in 5 minutes; mentions per message (`@everyone`, `@here` and members count). 0 turns a check off. |
| Links | Links (with or without `https://`) to sites not on the list. Email addresses aren't links. | Allowed sites; subdomains count. Links to this Dendrop (`DENDROP_PUBLIC_URL`) are always fine. |
| New accounts | Accounts younger than some hours, and people who joined less than some minutes ago. | Hours; minutes. 0 turns a check off. |

Edits are checked for words, links and mentions too.

## Actions

Each rule has its own actions, any mix of:

- **Block**: the message isn't posted, and the sender is told why (moderators see the detail).
- **Alert**: the owner, admins and people with Manage automod get a live alert; the server sidebar shows **Automod alerts**.
- **Time out**: the sender can't post, edit or join voice anywhere in the server for the set
  minutes, and is taken out of its voice channel. The message that set it off isn't posted.
  Automod never times out the owner or admins.

With no action picked, a hit is only written to the log.

## Exemptions

Each rule can leave roles (owner, admins, members, and any custom roles) and channels alone. The owner and admins are
exempt by default.

## Mod log and timeouts

**Server settings → Mod log** shows who is timed out (with **End timeout**) and the last 500
things automod caught, with the start of the message. Moderators can also time people out by
hand from **Members** (5 minutes to a week). Admins can't time out the owner or other admins.

## API

All moderator only.

- `GET /api/servers/:id/automod`, `PATCH /api/servers/:id/automod` with `{ words?, spam?, links?, newAccounts? }` (fields left out stay).
- `GET /api/servers/:id/automod/events?before=<id>`
- `GET /api/servers/:id/timeouts`, `PUT /api/servers/:id/timeouts/:userId` with `{ minutes, reason? }`, `DELETE /api/servers/:id/timeouts/:userId`

Moderators get `automod.alert` gateway events; a timed-out member's `server.updated` carries `timedOutUntil`.
