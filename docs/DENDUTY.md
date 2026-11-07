# Den Duty

[Den Duty](https://github.com/Spacegoose02/den-duty) is the family's self-hosted chore tracker:
chores, points, goals, a rewards shop, time-outs and help asks. Dendrop links to it through
Den Duty's public API. Pausing chat from a time-out needs Den Duty with the Dendrop chat option
on time-outs; older Den Duty still links, without it.

- **Chores line:** a kid's chores today show under their name, "🧹 2 of 5 chores left" or
  "⭐ All 5 chores done today". Only the kid and their parents see it.
- **Posts into channels:** what happens in Den Duty is posted as **Den Duty** (with an **app**
  tag), the cheerful things in a family channel and the grown-up things in a parents channel.
- **Chat pauses:** a Den Duty time-out can pause a kid's chat, or hold it until today's chores
  are done. Parents can also turn on **Chores first** for every day.

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

## Chat pauses

When a parent starts a time-out in Den Duty, **💬 In Dendrop** picks what it does to chat:

| Option | What the kid gets |
| --- | --- |
| chat stays as it is | Nothing changes in Dendrop. |
| pause chat | No chat for the whole time-out: "Chat is taking a break for your Den Duty time-out (No chatting) until Sat 6:00 PM. You've got this! 💛" |
| no chat until today's chores are done | Chat waits while chores are left: "Chat opens once today's chores are done: 2 to go in Den Duty. You can do it! 🧹" |

For every day, not just during a time-out, a parent can turn on **Chores first** for a kid in
**Family** (next to chat hours). It holds chat the same way until today's chores are done.

A paused kid can still read their chats, like outside chat hours, but can't send, call or add
friends; the composer shows the reason. Grown-ups are never paused. Chores marked done and
waiting for a grown-up to check count as done, and a day with no chores due doesn't hold chat.
Chat opens again by itself when the time-out ends, is ended early or bought back in Den Duty, or
the last chore is done (within half a minute, at the next check). If Den Duty can't be reached
for 10 minutes, chat isn't held back on old news. The admin's Kids list shows "⏸️ chat paused".

## Still to come

- A Den Duty bot to approve chores and answer help asks with buttons in chat, once Dendrop has
  bots that read and answer.
