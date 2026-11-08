# Voice audio, noise suppression and the soundboard

## The mic pipeline

Every call and voice channel sends the mic through Dendrop's own pipeline
(`packages/web/src/micProcessor.ts`), plugged into LiveKit as an audio track processor:

```
mic (48 kHz mono) → RNNoise (Smart only) → level meter
                  → 40 ms look-ahead → voice gate (fades, never a hard cut) → Opus
```

- **Smart noise suppression** is [RNNoise](https://github.com/xiph/rnnoise) compiled to
  WebAssembly (via `@sapphi-red/web-noise-suppressor`), running in an AudioWorklet. It doesn't
  depend on the browser, so Firefox, Chrome, Edge, the PC app and Android all sound the same.
  The browser's own suppression is turned off while it runs, so the two don't fight.
- **Browser's own** uses the browser's suppression plus voice isolation where it exists
  (Chrome and Safari; Firefox has none).
- The **voice gate** (input sensitivity and push to talk) looks at the cleaned-up level, a
  moment ahead of what is sent, so the start of a word isn't clipped. It fades over a few
  milliseconds instead of switching the track on and off.
- The mic is asked for at **48 kHz mono**, Opus's own rate, so nothing is resampled on the way.
- Opus goes out at up to **64 kbps** (LiveKit's default is 48), with DTX (silence is nearly free)
  and RED (a lost packet doesn't drop a syllable).

If the pipeline can't start (no AudioWorklet, or a browser that refuses the mic's sample rate),
the call carries on with the browser's own suppression, and the voice panel says so.

The mic check in Settings, Voice and audio runs the same pipeline, so "Hear myself" plays what
others will hear.

Settings saved before this change ("Standard" or "Strong") move to Smart.

## Soundboard

Short sounds anyone in a voice channel can play for everyone there: six built-in ones (made
on the spot with Web Audio, no files) and up to 24 per server, uploaded in server settings,
Sounds, by people with **Manage emoji & stickers** (MP3, Ogg or WAV, up to 5 seconds and 512 KB).

Sounds are never mixed into anyone's mic. `POST /api/voice/sound` (`{ builtin }` or `{ soundId }`)
checks you're in a voice channel, a speaker on a stage, not deafened or timed out, and that the
sound belongs to that server; then everyone in the channel gets a `voice.sound` event and their
app plays it at their own **soundboard volume** (Settings, Voice and audio; 0 turns sounds off).
Deafened people don't hear them. One person can play a sound every 2 seconds.

Sound files can only be fetched by members of their server.
