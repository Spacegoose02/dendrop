# Scheduled events and stage channels

Plan game nights, movie nights and family get-togethers in a server, see who's coming, and
get reminded. Run the big nights in a stage channel, where a few people talk and share their
screen and everyone else listens.

## Events

Open a server and pick **Events** at the top of the channel list. Everyone in the server sees
its events, soonest first. An event that happens in a locked voice or stage channel is only
shown to the people who can see that channel.

Each event has:

- a name and an optional description,
- **where** it happens: one of the server's voice or stage channels, or somewhere else (a
  place you type, like "Grandma's house"),
- a day and start time, and an optional end time (an end before the start means the next
  morning, for late nights),
- **Every week**, for a weekly game night.

Making events needs the **Manage events** permission (the owner and admins always have it; give
it to anyone else with a custom role). Whoever makes an event is marked as going, and can edit,
start, end or cancel it later. Kid accounts can hold Manage events, but can't plan or change
events while their chat is paused.

### RSVPs and reminders

Anyone who can see an event can say they're **Going** or **Interested**, and change their mind
at any time. Everyone who said either gets:

- a heads-up 15 minutes before it starts, and
- another when it goes live, with a button to join its voice or stage channel.

People who aren't in the app get a push notification instead (if they set up phone
notifications). Like every Dendrop push, it says only that an event is starting, never which
one or where.

### Starting and ending

Events go live by themselves at their start time, and hosts can start one early with **Start
now**. An event ends at its end time, when a host presses **End event**, or 12 hours after it
started if it has no end time. A weekly event then moves on to the same time next week and
keeps everyone's RSVPs; any other event is gone once it ends. **Cancel event** removes it (every
week of a weekly one).

## Stage channels

A stage channel is a voice channel for an audience. Make one from the ＋ next to **Stage
channels** (Manage channels).

- **Stage moderators** are the owner, admins and anyone with Manage channels or Manage events.
  They come in as speakers.
- **Everyone else listens.** Their LiveKit token can't send audio, video or a screen until a
  moderator lets them speak, so a listener can't be heard even with a modified app.
- Listeners can **raise a hand**. Moderators see the audience (raised hands first) and pick
  **Let speak**; they can **Move to audience** any speaker, and speakers can step down
  themselves.
- Speakers have the usual voice controls, including screen share with sound, which is how a
  movie night is shared.
- Being let up or moved down happens straight away through the call server; there's no need to
  rejoin.

People who are timed out can listen on a stage but can't be let up to speak.

## API

| Method and path | What it does |
| --- | --- |
| `GET /api/events` | Events in every server you're in |
| `GET /api/servers/:id/events` | One server's events |
| `POST /api/servers/:id/events` | Makes one: `{ name, description?, channelId? \| location?, startsAt, endsAt?, repeat?: "none" \| "weekly" }` |
| `GET /api/events/:id` | One event |
| `PATCH /api/events/:id` | Changes one (same fields) |
| `DELETE /api/events/:id` | Cancels one |
| `PUT /api/events/:id/rsvp` | `{ status: "going" \| "interested" \| null }` |
| `POST /api/events/:id/start` / `end` | Starts it now, or ends it now |
| `POST /api/voice/hand` | A stage listener raises or lowers a hand: `{ raised }` |
| `PUT /api/servers/:id/channels/:channelId/stage/:userId` | Lets someone speak or moves them to the audience: `{ speaker }` |

Gateway events: `event.updated`, `event.removed` and `event.reminder` (`minutes` is 15 for the
heads-up and 0 when it goes live). Voice states carry `stage` for the channel, and `speaker`
and `handRaised` for each person.
