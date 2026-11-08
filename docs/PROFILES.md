# Profiles

Click anyone's name or picture (in a chat, the member list, your friends or the DM list) to open their profile card. Click your own name in the bottom corner to see yours and change your status.

## What a profile has

- **Profile picture** and **banner** (PNG, JPEG, GIF or WebP, up to 5 MB; GIFs move). With no banner picture, the banner is a color you pick, or the theme's accent.
- **About me** (up to 190 characters, line breaks kept) and **pronouns**.
- **Custom status**: an emoji and a short line, like "🦝 Digging through the snack bin", that can clear itself after 30 minutes, an hour, 4 hours, today or this week. It shows under your name in the DM list, member lists and your friends list.
- What the card adds by itself: **Playing now** from LootDen (when you share it), and in a server your **nickname, roles and raccoon rank** with your XP. It also shows when you joined Dendrop, how long you've been friends, and the servers you share.

Edit it in **Settings → Profile**, or with **Edit profile** on your own card.

## Who can see it

Only you, your friends (and people with a friend request open with you), the people you share a chat or a server with, and your family. To anyone else your profile and pictures don't exist (404). Changes to your picture, name, colors or status reach the people who can see you straight away.

## Kid accounts

Kid profiles follow their parents' rules:

- **Pictures need a parent's OK.** A parent turns on *Profile picture and banner* in the family dashboard. Turning it off takes the kid's pictures down.
- **The word filter checks everything typed.** About me, pronouns and status go through the kid's family filter (with their extra words) on the server, since profiles aren't end-to-end encrypted.
- **Parents hear about changes.** A change to a kid's profile raises a *profile* alert for their parents (one at a time, until a parent marks it done).
- **Parents can clear it.** *Clear profile* in the family dashboard removes the kid's picture, banner, about me, pronouns and status.
- Kids with the word filter on see other people's about me and status with filtered words hidden, like messages.

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/users/:id/profile` | Someone's `UserProfile` (404 if you can't see them) |
| GET | `/api/users/:id/pictures/:file` | A profile picture or banner |
| PATCH | `/api/me/profile` | `{ bio?, pronouns?, bannerColor?, status? }`; `status: null` clears it |
| PUT / DELETE | `/api/me/avatar`, `/api/me/banner` | Upload (multipart, one file) or remove a picture |
| DELETE | `/api/family/kids/:kidId/profile` | A parent clears their kid's profile |

`PublicUser` now carries `avatar` (an address or null) and `status`. The gateway sends `user.updated` with the new `PublicUser` when someone's name, colors, picture or status changes.
