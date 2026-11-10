# Categories, slowmode, read-only channels, permissions and voice moderation

## Channel categories

People who can manage channels make categories with **＋ New category** under the channel list,
and rename or delete one with its ✎ (deleting keeps its channels, without a category). Pick a
channel's category in its settings, or make a channel straight into one with the category's ＋.
Anyone can fold a category with its ▾; that's remembered on the device. A folded category still
shows the channel you're in, a voice channel you're in, and channels with unread messages.

Channels without a category are listed first, grouped as before (text, voice, stage).

## Slowmode

A text or forum channel's settings have **Slowmode**: from 5 seconds to 6 hours between each
person's messages. People who can manage channels or delete messages don't wait. The app
counts down under the message box, and the server refuses early messages with a 429. Threads
and forum posts don't have slowmode.

## Read-only channels

Turn on **Read-only** in a text channel's settings, then pick the roles that can post.
Everyone else who can see it can read, react, use threads and set reminders, but not post.
People who can manage channels can always post. Good for #announcements and #rules.

## Permissions

Roles now have these permissions on top of the old ones:

| Permission | What it allows |
| --- | --- |
| Remove members | Remove people ranked below (they can come back with an invite). |
| Ban | Ban people ranked below, and see and lift bans. Roles that had "Remove and ban" got this automatically. |
| Manage nicknames | Change the nicknames of people ranked below (Members tab → Nickname). |
| Mute in voice | Mute or deafen people ranked below in voice channels until it's lifted. |
| Move and disconnect | Move people ranked below to another voice channel, or take them out of voice. |
| Manage webhooks & bots | Webhooks and bots, which used to be owner and admins only. |
| View audit log | Read the audit log without any other moderator permission. |

Kid accounts can't hold any of them except the ones they could before.

## Voice moderation

Hover someone in a voice channel in the sidebar and open **⋯** (always shown on phones):

- **Mute for everyone / Let them talk** and **Deafen / Let them hear**. A moderator's mute
  holds even if they leave and come back, until a moderator lifts it. The call server stops
  them sending sound and video, and their app shows the mute and won't let them unmute. Their
  icons turn red in the list.
- **Move to …** another voice channel they can see: their app joins it.
- **Disconnect** takes them out of voice.

Each of these lands in the audit log.
