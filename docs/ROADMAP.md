# Dendrop roadmap

Dendrop is a self-hosted chat app (text, voice, video, screen share) with a raccoon theme,
first-class kid-safe controls, and single sign-on through TinyAuth. This roadmap turns the
feature board into a build order.

**Top priority:** private direct messaging (text and calls) between people you trust, so Dendrop can replace Discord DMs first.

**Current state:** Phase 0 is in place, and Phase 1 has sign-in, friends, live DMs and group chats, files, emoji, read receipts, and voice and video calls. Phase 3's chat servers are in: servers, locked channels, invites, the public directory and super admin approval (GIFs still to come). The
status column is updated as each piece lands.

---

## Proposed stack

These are recommendations, not commitments. Each one is picked for "runs well in one Docker
Compose stack on Unraid" and "one codebase for Windows, Linux, and Android".

| Layer | Choice | Why |
| --- | --- | --- |
| Server API + realtime | TypeScript, Node, Fastify, WebSocket gateway | One language across server and clients |
| Database | SQLite (built into Node), in the /data volume | One container to run and back up, like LootDen; Postgres only if it ever outgrows a family server |
| Presence / typing | In memory in the server process | One server process per instance; Redis only if it ever needs several |
| Voice, video, screen share | LiveKit (self-hosted SFU) | Handles WebRTC rooms, simulcast, screen share, game streaming |
| File storage | Local volume, or MinIO (S3 API) | Uploads, avatars, custom emoji, banners |
| Auth | TinyAuth as OIDC provider, app sessions in Postgres | SSO and MFA handled by TinyAuth |
| Web client | React + Vite + TypeScript | Shared UI for every platform |
| Desktop (Windows 11, Linux) | Electron (or Tauri) | Electron matches LootDen's desktop app, so tray, autostart, auto-update and packaging code can be reused; Tauri gives smaller binaries |
| Android | Capacitor wrapping the same React app | APK builds, push notifications, native plugins for bubbles |
| Push notifications | ntfy / UnifiedPush (self-hosted), FCM as an opt-in fallback | Phone notifications without depending on the desktop app |
| Deployment | `docker-compose.yml` + Unraid template | One-command self-host |

Repo layout (npm workspaces, the same shape as LootDen):

```
packages/shared   # types and limits shared by the server and every client
packages/theme    # design tokens (tokens.css) and theme ids; clients style only with these
packages/server   # Fastify API, WebSocket gateway, SQLite, TinyAuth OIDC
packages/web      # React client, also wrapped by the desktop and Android apps
packages/desktop  # Electron app for Windows 11 and Linux
packages/android  # Capacitor app (APK)
```

---

## Privacy principles

Dendrop exists to replace Discord and take privacy back, so these apply to every phase:
- **Self-hosted, no third-party dependencies by default.** Everything runs in your own Docker stack. Anything that talks to an outside service (GIF search, FCM push, link previews) is opt-in and off by default.
- **End-to-end encryption for DMs.** Message content is encrypted on the device so the server only stores ciphertext. Shipped for DMs and group DMs (text and files), see [ENCRYPTION.md](ENCRYPTION.md). Calls in encrypted conversations use LiveKit's media E2EE. Still to come: forward secrecy (a Signal-style or MLS ratchet). Server channels can start unencrypted and adopt it later.
- **Minimal data.** No analytics or tracking, no message scanning on the server for DM content; filtering for kid accounts runs on the client.
- **Encrypted at rest and backups you control.** Postgres and file storage on encrypted volumes, with documented backup/restore.
- **Push notifications without content.** Notifications say "new message" and the app fetches the content, so ntfy/FCM never sees it.

Note: E2EE and the kid-safe "parent sees deleted messages / ghost admin" features pull against each other. The plan is to scope oversight to kid accounts only, done on the kid's device with the family's consent, and never applied to adult DMs.

## Phases

Each phase ends with something usable, so it can be self-hosted and tried before moving on.

### Phase 0: Foundation
Goal: an empty but running stack.
- Monorepo, linting, CI, Docker Compose with Postgres, Redis, LiveKit, and the server.
- **Systems → Server: docker / Unraid hosting** (initial compose file; Unraid template later).

### Phase 1: Accounts and direct messages (top priority)
Goal: you and your wife can log in and chat privately, replacing Discord DMs first.
- **Systems → SSO with TinyAuth**, **Backbone → Users / TinyAuth for SSO**, **Systems → MFA usable** (MFA enforced in TinyAuth; the app just respects it).
- **Backbone → Super admin who oversees the whole server** (instance-level role, set from config on first boot).
- **Backbone → Friend invites**, **Private chat / direct message** (1:1 and small group DMs).
- **Systems → New Chat** (start a DM or group DM).
- Real-time text: send, edit, delete, typing indicators, history.
- **Features → Message read receipts**, **Activity privacy** (hide online status / current activity).
- **Features → Emojis**, **File uploading**.
- **1:1 voice and video calls in DMs** (pulled forward from Phase 4, LiveKit with end-to-end encrypted media).
- End-to-end encryption for DMs and group DMs, including call audio and video: done (see [ENCRYPTION.md](ENCRYPTION.md)).

### Phase 2: Phone and PC apps
Pulled up right after DMs, because chatting happens mostly from a phone and a PC.
- **Systems → Android APK** (Capacitor build of the web client, sideloaded APK).
- **Backbone → Phone notifications**, **Sounds → Notifications for incoming calls and messages** (content-free pushes through self-hosted ntfy/UnifiedPush; full-screen incoming call screen on Android).
- **Features → Android chat bubbles for DMs** (native Bubbles API through a small Capacitor plugin).
- **Systems → Windows 11**, **Linux** (desktop builds, installer, tray, auto-update).
- **Systems → Automatically open when PC starts** (off by default).
- **Systems → Keybinds** (push-to-talk, mute, deafen; global shortcuts on desktop).
- **Features → Pop-out chats that separate from the main window**.

### Phase 3: Chat servers
- **Backbone → User needs to be approved to create chat servers** (super admin approval queue).
- **Backbone → Ability for chat servers**, **Individual chat servers others can join, with ability to make private**, **Creator is owner of chat server**.
- **Backbone → Lock channels, or owner chooses members** (per-channel permissions).
- **Features → Invite links to chat servers**, **Backbone → Ability to browse other chat servers** (public server directory; private servers hidden).
- **Features → GIFs** (off by default, since GIF search sends queries to a third party; can be proxied through the server).

### Phase 4: Voice channels, screen share, and audio quality
- **Backbone → Voice chat** in server channels, **Screen sharing**, **Game streaming** (LiveKit rooms).
- **Backbone → Microphone settings**, **Speaker settings** (device pickers, volume, test tone).
- **Systems → Automatically adjust input sensitivity**, **Noise suppression with various levels** (browser built-in, plus RNNoise for stronger levels).
- **Systems → Advanced audio**: automatic gain control, advanced voice activity, bypass system audio processing, "no audio device detected" warnings, quality-of-service, "when I speak / when others speak" ducking.
- **Sounds → Sounds for deafen, undeafen, mute, unmute** and other events.

### Phase 5: Kid-safe chat
Built on Phase 1 accounts, so it can start earlier if it becomes the priority.
- **Link kid accounts with parents** (parent account owns one or more child accounts; can reuse LootDen's kid profiles, see Phase 8).
- **Parental controls** dashboard: who the kid can DM, which servers they can join, friend request approval.
- **Time-based controls** (allowed hours, daily limits).
- **Profanity filters** (per-account, stricter for kids, configurable word lists).
- **Messages deleted by a kid are sent to the parent** (soft delete with parent copy).
- **Parents are ghost admins of kids' groups/chats when alerted** (read-only oversight, triggered by an alert, with an audit log).
- **Send webhook alerts from integrations, like the screenshot** (alert types: profanity hit, deleted message, new contact, time limit reached; delivered as webhooks and in-app).

### Phase 6: Moderation
- **Automod → Automod settings**: per-server rules (blocked words, spam / mention flooding, link filtering, suspicious-account checks), each with actions (block, alert, timeout) and exempt roles/channels. Shares its filter engine with the kid-safe profanity filter.

### Phase 7: Customization and polish
- **Features → Custom emoji upload, emoji sections**.
- **Features → Server chat profile, with ability to change server name** (per-server nickname/avatar), **Server chat banner**.
- **Features → Custom app icons** (desktop + Android alternate icons).
- **Features → Themes**: a theme token system, then theme packs (10 dark, 10 nuclear, 10 gaming, 10 laser), with the raccoon theme as the default.

### Phase 8: Integrations
- **Integrations → LootDen integration.** [LootDen](https://github.com/Spacegoose02/lootden) is the family's self-hosted game library. It already signs in with TinyAuth OIDC, runs on Docker/Unraid, tracks who is playing what on which PC, has kid profiles, game nights and a family screenshot wall, and today sends Discord status and Apprise alerts. Dendrop can take over the Discord parts:
  - **Same sign-in:** both apps use the same TinyAuth users, so a LootDen profile and a Dendrop account line up by OIDC subject.
  - **"Playing now" status:** LootDen's presence shows in Dendrop as your activity ("Playing Stardew Valley on Den-PC"), respecting Activity privacy. Replaces LootDen's Discord status.
  - **Alerts into Dendrop:** LootDen's Apprise alerts (new games, requests, deals) post into a Dendrop channel or DM through an incoming webhook.
  - **Game night:** a planned LootDen game night creates a Dendrop event with a voice channel, and "Surprise us" picks can be shared to chat.
  - **Family wall:** Ctrl+Shift+S screenshots can be shared to a Dendrop channel, kid-safe filtering kept.
  - **Kid accounts:** LootDen's kid profiles and parent links can seed Dendrop's kid-safe accounts (Phase 5), so a parent sets things up once.
  - **Game links:** pasting a LootDen game link shows a card with cover art and a "Send to PC" button.
- A general bot / webhook API, which the LootDen integration and the kid-safe alert webhooks both use.

---

## "Look alike" direction

The two reference screenshots show a familiar layout: server rail on the far left, channel
list, main message pane, member list on the right, user/voice controls bottom-left, and a
settings page with a left nav. Dendrop will use that same **layout and flow** so it feels
instantly usable, but with **its own visual identity**: original raccoon branding, iconography,
color palettes, and naming. No other app's logos, names, or artwork.

---

## Card status

| Column | Card | Phase | Status |
| --- | --- | --- | --- |
| Systems | New Chat | 1 | Done (DMs and group chats) |
| Systems | Windows 11 | 2 | Missing |
| Systems | Android APK | 2 | Missing |
| Systems | Linux | 2 | Missing |
| Systems | SSO with TinyAuth | 1 | Done |
| Systems | MFA usable | 1 | Done (enforced in TinyAuth) |
| Systems | Automatically adjust input sensitivity | 4 | Missing |
| Systems | Noise suppression with levels | 4 | Missing |
| Systems | Advanced audio switches | 4 | Missing |
| Systems | Automatically open when PC starts | 2 | Missing |
| Systems | Keybinds | 2 | Missing |
| Systems | Server: Docker / Unraid hosting | 0 | Done (Unraid template still to do) |
| Backbone | Ability for chat servers | 3 | Done |
| Backbone | Users / TinyAuth for SSO | 1 | Done |
| Backbone | Super admin over whole server | 1 | Done: approves who can make servers, sees and deletes any server (never its messages) |
| Backbone | Joinable chat servers, can be private | 3 | Done |
| Backbone | Private chat / direct message | 1 | Partial: DMs and group DMs live, end-to-end encrypted |
| Backbone | Screen sharing | 4 | Missing |
| Backbone | Game streaming | 4 | Missing |
| Backbone | Voice chat | 1 (DM calls), 4 (channels) | Partial: voice and video calls in DMs and group chats |
| Backbone | Phone notifications | 2 | Partial: server sends content-free pushes; Android app in #7 |
| Backbone | Speaker settings | 4 | Missing |
| Backbone | Microphone settings | 4 | Missing |
| Backbone | Friend invites | 1 | Done |
| Backbone | Browse other chat servers | 3 | Done (public servers only; private ones are never listed) |
| Backbone | Lock channels / owner chooses members | 3 | Done |
| Backbone | Creator is owner of chat server | 3 | Done (owner and admin roles, ownership transfer) |
| Backbone | Approval needed to create servers | 3 | Done |
| Features | Message read receipts | 1 | Done |
| Features | Emojis | 1 | Partial: built-in picker; search and custom emoji in Phase 7 |
| Features | GIFs | 3 | Missing |
| Features | Custom app icons | 7 | Missing |
| Features | File uploading | 1 | Done (pictures inline, other files download) |
| Features | Custom emoji upload, sections | 7 | Missing |
| Features | Themes (dark, nuclear, gaming, laser) | 7 | Missing |
| Features | Pop-out chats | 2 | Missing |
| Features | Android chat bubbles for DMs | 2 | Missing |
| Features | Activity privacy | 1 | Partial: read receipts can be turned off |
| Features | Invite links | 3 | Done (links with expiry and use limits, and invites to friends) |
| Features | Server chat profile / rename | 7 | Done (name, description, per-server nickname) |
| Features | Server chat banner | 7 | Done (icon and banner) |
| Integrations | LootDen integration | 8 | Missing |
| Kid safe chat | Profanity filters | 5 | Missing |
| Kid safe chat | Kid's deleted messages sent to parent | 5 | Missing |
| Kid safe chat | Time-based controls | 5 | Missing |
| Kid safe chat | Parental controls | 5 | Missing |
| Kid safe chat | Link kid accounts with parents | 5 | Missing |
| Kid safe chat | Webhook alert notifications | 5 | Missing |
| Kid safe chat | Parents as ghost admins when alerted | 5 | Missing |
| Sounds | Sounds for deafen/mute events | 4 | Missing |
| Sounds | Incoming call / message notifications | 2 | Missing |
| Automod | Automod settings | 6 | Missing |
| Look alike | Layout reference 1 (settings) | 1, 7 | Missing |
| Look alike | Layout reference 2 (main chat) | 1, 7 | Missing |

## Open questions
1. Should kid-safe chat move ahead of chat servers and voice channels (Phases 3 and 4)?
2. Desktop shell: Electron to share code with LootDen's app, or Tauri for smaller installs? The plan assumes Electron unless you prefer otherwise.
