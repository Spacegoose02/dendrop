# Watch together and the in-game overlay

## Watch together

Anyone in a voice channel can put on a video that everyone in the channel watches at the same
moment: press **📺 Watch together** in the voice panel.

- **Videos from the channel's chat.** Post an MP4 or WebM in the voice channel's own chat and it
  shows up in the picker. It's streamed from your Dendrop server (with seeking), so nothing
  leaves your network.
- **Links to video files.** Paste a link to an `.mp4` or `.webm`; each device loads it from that
  site.
- **YouTube**, only when a super admin turns it on (Admin → Watch together). YouTube is an outside
  service, so it's off by default; while a YouTube video plays, each device loads YouTube's
  privacy-enhanced (`youtube-nocookie.com`) player.

Who runs it: everyone in a voice channel; on a stage channel, the speakers (listeners just
watch). Anyone who can run it can play, pause, seek (with the video's own controls), skip, queue
up to 20 more and stop it. It ends by itself when the last person leaves the channel.

How it stays in step: the server keeps what's on, whether it's playing and where it's up to
(position plus the server time it was set). Each device measures its clock against the server
(`GET /api/time`) and checks every second; more than a second out and it jumps to the right
spot. When the browser blocks playing with sound, a **Join in** button starts it.

Kid accounts can put on and watch videos from the chat, but not links from other sites; when
the others are watching one, a kid sees a note instead of the video.

The video plays in the full voice panel. While you look at another chat, the compact voice bar
shows what's on.

API (all for the voice channel you're in): `POST /api/voice/watch` `{ attachmentId }` or
`{ url, title? }` puts a video on or queues it, `POST /api/voice/watch/control`
`{ playing?, position? }`, `POST /api/voice/watch/next` `{ itemId? }`,
`DELETE /api/voice/watch/queue/:itemId`, `DELETE /api/voice/watch`. The state arrives in
`voice.updated` as `voice.watch`.

## In-game overlay (PC app)

A small see-through panel in a corner of your screen, over your game: the voice channel you're
in, who's in it, who's talking (highlighted and moved to the top), who's muted or sharing, the
channel's last few messages and what's on in watch together. Clicks go straight through it to
the game.

- **Follows LootDen.** By default it shows only while you're in voice *and* LootDen says you're
  playing something, so it's there for game nights and gone the rest of the time. The tray menu
  (right-click the raccoon → In-game overlay) can show it whenever you're in voice instead, turn
  it off, or move it to another corner.
- **Quick chat.** Press **Alt+`** to make it clickable: type a message for the voice channel's
  chat and press Enter, or mute and deafen. Escape (or Done) hands the game back.
- Kid accounts' word filter applies to what it shows, and their chat hours and time-outs apply
  to what they send, the same as in the app.

It works over games in **borderless window** or windowed mode. Games in exclusive full screen
draw over every other window, so switch the game to borderless to see it (most games call this
"Borderless" or "Windowed full screen").
