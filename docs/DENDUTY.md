# Den Duty

[Den Duty](https://github.com/Spacegoose02/den-duty) is the family's self-hosted chore tracker:
chores, points, goals, a rewards shop, time-outs and help asks. Dendrop links to it through
Den Duty's public API, and nothing has to change in Den Duty.

- **Chores line:** a kid's chores today show under their name, "🧹 2 of 5 chores left" or
  "⭐ All 5 chores done today". Only the kid and their parents see it.
- **Posts into channels:** what happens in Den Duty is posted as **Den Duty** (with an **app**
  tag), the cheerful things in a family channel and the grown-up things in a parents channel.

## Linking it

A super admin links Den Duty in **Instance admin → Den Duty**:

1. In Den Duty, as a parent: **Settings → Home Assistant, automations and the API**. Make a
   token (a read token is enough) and copy it, and the home id from the same page.
2. In Dendrop: paste Den Duty's address (e.g. `https://chores.example.com`), the home id and
   the token, then **Link Den Duty**.
3. Pick the channels (below), and check the **Kids** list.

Every 30 seconds Dendrop asks Den Duty for each kid's chores today
(`GET /api/v1/homes/:homeId/gaming`) and for anything new
(`GET /api/v1/homes/:homeId/events?after=…`). The token stays on the server and is never sent
back to the browser. If Den Duty can't be reached for 10 minutes, the chores lines go away
until it answers again.

**Which kid is whose.** Den Duty kids are profiles with a PIN, not sign-ins, so they're matched
to Dendrop **kid accounts** (accounts linked to a parent, see [KIDS.md](KIDS.md)) by name: a Den
Duty kid called "Ava" goes with the one kid account whose display name or username is "Ava".
Pick another account, or **Nobody**, in the Kids list. Grown-ups don't need matching.

## Channels

| Channel | What's posted | Who may read it |
| --- | --- | --- |
| **Family** | ✅ chores approved, 🌟 bonus points, 🎯 goals reached, 🎁 goals cashed in and rewards handed over, 🏆 family goals reached | Anyone, kids too |
| **Parents** | ⏳ chores waiting for a check, ➖ points taken away, 🛍️ shop orders to hand over, ⏸️ time-outs, ⏱️ buy-back requests, 🙋 help asks, ⏰ reminders | Grown-ups only |

The parents channel has to be one no kid account can read (a locked channel only the parents
are picked for works well). Dendrop refuses to pick one a kid can read, and checks again before
every post: if a kid is added later, grown-up posts stop until they're taken out.

Each channel can be off. Only channels in servers the super admin owns or runs can be picked.

Never posted: anything from Den Duty's Doctors pages (practices, medicine refills), refunds,
reminders ticked off and help asks closed. Right after linking, Dendrop starts from that
moment rather than posting what happened before.

## Still to come

- Time-outs that pause chat, and "no chat until chores are done", which needs a small change
  in Den Duty.
- A Den Duty bot to approve chores and answer help asks with buttons in chat, once Dendrop has
  bots that read and answer.
