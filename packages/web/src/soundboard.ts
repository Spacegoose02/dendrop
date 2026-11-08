/**
 * The soundboard: short sounds anyone in a voice channel can play for everyone there.
 *
 * Sounds aren't mixed into anyone's mic. The server tells everyone in the channel which sound
 * was played (a voice.sound event) and each app plays it itself, at that person's own soundboard
 * volume, on their chosen speakers. So sounds stay clear, even with noise suppression on, and
 * anyone can turn them down or off.
 *
 * The built-in sounds are made on the spot with Web Audio, like the mute and join chimes.
 */
import type { BuiltinSoundId, ServerSound, SoundboardPlay } from "@dendrop/shared";
import { loadAudio, outputNode, soundContext, type AudioPrefs } from "./audio.ts";

/** Set by the voice panel while you're deafened: then sounds stay quiet too. */
let deafened = false;
export const setSoundboardDeafened = (on: boolean): void => {
  deafened = on;
};

const buffers = new Map<number, Promise<AudioBuffer>>();

/** Decodes a server sound once and keeps it (they're a few seconds each). */
function bufferFor(ctx: AudioContext, sound: ServerSound): Promise<AudioBuffer> {
  let b = buffers.get(sound.id);
  if (!b) {
    b = fetch(sound.url, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`Sound ${sound.id}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((data) => ctx.decodeAudioData(data));
    b.catch(() => buffers.delete(sound.id));
    buffers.set(sound.id, b);
  }
  return b;
}

/** Plays a sound someone played in your voice channel (or a preview). */
export function playSoundboard(play: SoundboardPlay, prefs: AudioPrefs = loadAudio()): void {
  if (deafened || prefs.soundboardVolume <= 0) return;
  if ("builtin" in play) playBuiltinSound(play.builtin, prefs);
  else void playServerSound(play.sound, prefs);
}

/** How long a sound is, in seconds, from its file: checked before uploading one. */
export async function soundLength(file: Blob): Promise<number> {
  const ctx = soundContext();
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  return buf.duration;
}

export async function playServerSound(sound: ServerSound, prefs: AudioPrefs = loadAudio()): Promise<void> {
  try {
    const ctx = soundContext();
    const buf = await bufferFor(ctx, sound);
    const out = outputNode(ctx, prefs, (prefs.soundboardVolume / 100) * (sound.volume / 100), buf.duration);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    src.start();
  } catch {
    // A sound that won't play isn't worth an error in the middle of a chat.
  }
}

/** Plays one of the built-in sounds. */
export function playBuiltinSound(id: BuiltinSoundId, prefs: AudioPrefs = loadAudio()): void {
  try {
    const ctx = soundContext();
    const out = outputNode(ctx, prefs, 0.35 * (prefs.soundboardVolume / 100), 2.5);
    SYNTHS[id](ctx, out, ctx.currentTime + 0.02);
  } catch {
    // No audio output available.
  }
}

// ---- The built-in sounds -----------------------------------------------------------------

type Synth = (ctx: AudioContext, out: AudioNode, t: number) => void;

/** A tone with a quick attack and an exponential fade. */
function tone(ctx: AudioContext, out: AudioNode, opts: { type: OscillatorType; freq: number; to?: number; start: number; length: number; gain?: number; filter?: number }): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.freq, opts.start);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, opts.start + opts.length);
  const env = ctx.createGain();
  const peak = opts.gain ?? 1;
  env.gain.setValueAtTime(0, opts.start);
  env.gain.linearRampToValueAtTime(peak, opts.start + 0.01);
  env.gain.setValueAtTime(peak, opts.start + opts.length * 0.6);
  env.gain.exponentialRampToValueAtTime(0.001, opts.start + opts.length);
  let node: AudioNode = osc;
  if (opts.filter) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = opts.filter;
    osc.connect(f);
    node = f;
  }
  node.connect(env).connect(out);
  osc.start(opts.start);
  osc.stop(opts.start + opts.length + 0.05);
  return osc;
}

/** A burst of filtered noise: cymbals and snares. */
function noise(ctx: AudioContext, out: AudioNode, opts: { start: number; length: number; highpass: number; gain: number }): void {
  const len = Math.ceil(ctx.sampleRate * opts.length);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = opts.highpass;
  const env = ctx.createGain();
  env.gain.setValueAtTime(opts.gain, opts.start);
  env.gain.exponentialRampToValueAtTime(0.001, opts.start + opts.length);
  src.connect(f).connect(env).connect(out);
  src.start(opts.start);
}

/** Wobbles a tone's pitch, like a trombone's slide or a spring. */
function vibrato(ctx: AudioContext, osc: OscillatorNode, opts: { rate: number; depth: number; start: number; length: number }): void {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = opts.rate;
  const depth = ctx.createGain();
  depth.gain.value = opts.depth;
  lfo.connect(depth).connect(osc.frequency);
  lfo.start(opts.start);
  lfo.stop(opts.start + opts.length);
}

const SYNTHS: Record<BuiltinSoundId, Synth> = {
  badum: (ctx, out, t) => {
    tone(ctx, out, { type: "sine", freq: 220, to: 90, start: t, length: 0.18 });
    tone(ctx, out, { type: "sine", freq: 160, to: 70, start: t + 0.16, length: 0.22 });
    noise(ctx, out, { start: t + 0.42, length: 0.9, highpass: 6000, gain: 0.6 });
  },
  tada: (ctx, out, t) => {
    tone(ctx, out, { type: "sawtooth", freq: 523, start: t, length: 0.12, gain: 0.5, filter: 2500 });
    for (const f of [523, 659, 784, 1047]) tone(ctx, out, { type: "sawtooth", freq: f, start: t + 0.14, length: 0.9, gain: 0.3, filter: 2500 });
  },
  boing: (ctx, out, t) => {
    const o = tone(ctx, out, { type: "sine", freq: 140, to: 520, start: t, length: 0.6 });
    vibrato(ctx, o, { rate: 14, depth: 40, start: t, length: 0.6 });
  },
  sad: (ctx, out, t) => {
    const notes = [392, 370, 349];
    notes.forEach((f, i) => tone(ctx, out, { type: "sawtooth", freq: f, start: t + i * 0.38, length: 0.34, gain: 0.45, filter: 1200 }));
    const last = tone(ctx, out, { type: "sawtooth", freq: 330, start: t + 1.14, length: 1.1, gain: 0.45, filter: 1200 });
    vibrato(ctx, last, { rate: 6, depth: 8, start: t + 1.3, length: 0.95 });
  },
  airhorn: (ctx, out, t) => {
    const blasts: [number, number][] = [
      [0, 0.18],
      [0.24, 0.18],
      [0.48, 0.7],
    ];
    for (const [at, len] of blasts) for (const f of [415, 420, 622]) tone(ctx, out, { type: "sawtooth", freq: f, start: t + at, length: len, gain: 0.25, filter: 3000 });
  },
  ding: (ctx, out, t) => {
    tone(ctx, out, { type: "sine", freq: 1320, start: t, length: 1.4, gain: 0.6 });
    tone(ctx, out, { type: "sine", freq: 2640, start: t, length: 0.6, gain: 0.2 });
  },
};
