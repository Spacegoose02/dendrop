/**
 * Voice and audio settings for this device: which mic and speakers, how the mic is cleaned up,
 * input sensitivity, and the little sounds for mute, deafen, join and leave. Saved in
 * localStorage, because device ids only mean something on the device that made them.
 */
import { useEffect, useState } from "react";
import { INSECURE_MEDIA } from "./secure.ts";

/**
 * Smart is Dendrop's own (RNNoise, the same in every browser). Browser is the browser's built-in
 * suppression, plus voice isolation where the browser has it (Chrome and Safari, not Firefox).
 */
export type NoiseLevel = "off" | "browser" | "smart";

export interface AudioPrefs {
  /** "" means the system default. */
  inputId: string;
  outputId: string;
  /** How loud other people are, 0 to 100. */
  outputVolume: number;
  noiseSuppression: NoiseLevel;
  echoCancellation: boolean;
  /** The browser's automatic gain control: evens out loud and quiet. */
  autoGain: boolean;
  /** Only send your mic when it's louder than this. "auto" follows the room's background noise. */
  sensitivity: "auto" | "off" | number;
  /** Sounds for mute, unmute, deafen, undeafen, and people joining and leaving voice. */
  sounds: boolean;
  /** How loud soundboard sounds play for you, 0 (off) to 100. */
  soundboardVolume: number;
}

export const DEFAULT_AUDIO: AudioPrefs = {
  inputId: "",
  outputId: "",
  outputVolume: 100,
  noiseSuppression: "smart",
  echoCancellation: true,
  autoGain: true,
  sensitivity: "auto",
  sounds: true,
  soundboardVolume: 60,
};

const KEY = "dendrop.audio";
const EVENT = "dendrop-audio";

export function loadAudio(): AudioPrefs {
  try {
    const p = { ...DEFAULT_AUDIO, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AudioPrefs>) };
    // Before smart suppression there were "standard" (the old default) and "strong": both move to smart.
    if (!["off", "browser", "smart"].includes(p.noiseSuppression)) p.noiseSuppression = "smart";
    return p;
  } catch {
    return { ...DEFAULT_AUDIO };
  }
}

export function saveAudio(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = { ...loadAudio(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows can refuse storage; the change still applies until reload.
  }
  dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

/** The current settings, kept up to date when they change (from the settings dialog or another tab). */
export function useAudioPrefs(): AudioPrefs {
  const [prefs, setPrefs] = useState(loadAudio);
  useEffect(() => {
    const update = () => setPrefs(loadAudio());
    const onStorage = (e: StorageEvent) => e.key === KEY && update();
    addEventListener(EVENT, update);
    addEventListener("storage", onStorage);
    return () => {
      removeEventListener(EVENT, update);
      removeEventListener("storage", onStorage);
    };
  }, []);
  return prefs;
}

/**
 * getUserMedia / LiveKit capture options for the mic. Mono at 48 kHz, which is what Opus sends and
 * RNNoise needs, so nothing is resampled on the way (Firefox otherwise may open the mic at the
 * sound card's rate). With smart suppression the browser's own is off, so the two don't fight.
 */
export function micConstraints(p: AudioPrefs): MediaTrackConstraints & { voiceIsolation?: boolean } {
  return {
    ...(p.inputId ? { deviceId: { exact: p.inputId } } : {}),
    channelCount: 1,
    sampleRate: 48000,
    noiseSuppression: p.noiseSuppression === "browser",
    ...(p.noiseSuppression === "browser" ? { voiceIsolation: true } : {}),
    echoCancellation: p.echoCancellation,
    autoGainControl: p.autoGain,
  };
}

/** Puts an audio element on the chosen speakers, at the chosen volume. */
export function applyOutput(el: HTMLMediaElement, p: AudioPrefs): void {
  el.volume = Math.max(0, Math.min(1, p.outputVolume / 100));
  const sink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
  if (sink.setSinkId && sink.sinkId !== p.outputId) void sink.setSinkId(p.outputId).catch(() => {});
}

/** Whether this browser can pick speakers (Chrome, Edge, the desktop app; not Firefox or Safari yet). */
export const canPickOutput = (): boolean => typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function";

/** A readable message for a mic that couldn't start. */
export function micError(err: Error): string {
  if (!window.isSecureContext) return INSECURE_MEDIA;
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
    return "No microphone found. Plug one in, or pick another in Settings, Voice and audio.";
  }
  if (err.name === "NotAllowedError") return "The microphone is blocked. Allow it for this site to talk.";
  return `Microphone: ${err.message}`;
}

// ---- Level meter and voice gate -------------------------------------------------------

/** Loudness of a track in dBFS (-100 silent to 0 loudest), read a few times a second. */
export class LevelMeter {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private source: MediaStreamAudioSourceNode;
  private buf: Float32Array<ArrayBuffer>;

  constructor(track: MediaStreamTrack) {
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
  }

  level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }

  close(): void {
    this.source.disconnect();
    void this.ctx.close().catch(() => {});
  }
}

/** How far above the background noise you need to be in auto mode. */
const AUTO_MARGIN_DB = 12;
/** Keep sending this long after you stop, so word endings and short pauses aren't clipped. */
const HOLD_MS = 500;
/** How often the gate checks the level. With the pipeline's 40 ms look-ahead, word starts get through. */
const TICK_MS = 20;
/** How fast the learned floor creeps up per tick (the same pace as before at 50 ms ticks). */
const FLOOR_RISE = 0.002;

/**
 * Input sensitivity: decides from the mic's loudness whether you're talking. In "auto" it learns
 * the background noise (a slow-rising floor that drops at once to quieter levels) and opens a
 * margin above it. Reads a clone of the track, so turning the sent track off doesn't blind it.
 */
export class VoiceGate {
  private meter: LevelMeter | null = null;
  private clone: MediaStreamTrack | null = null;
  private level: () => number;
  private floor = -60;
  private openUntil = 0;
  private timer: ReturnType<typeof setInterval>;
  open = true;

  /** `source` is the mic track to measure, or a function giving its level (the mic pipeline's meter). */
  constructor(
    source: MediaStreamTrack | (() => number),
    private sensitivity: () => AudioPrefs["sensitivity"],
    private onChange: (open: boolean, level: number, threshold: number) => void,
  ) {
    if (typeof source === "function") this.level = source;
    else {
      const clone = source.clone();
      clone.enabled = true;
      const meter = new LevelMeter(clone);
      this.clone = clone;
      this.meter = meter;
      this.level = () => meter.level();
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  threshold(): number {
    const s = this.sensitivity();
    if (s === "off") return -100;
    if (s === "auto") return Math.min(-20, this.floor + AUTO_MARGIN_DB);
    return s;
  }

  private tick(): void {
    const level = this.level();
    // The floor drops straight to quieter readings and creeps up slowly, so speech doesn't raise it much.
    this.floor = level < this.floor ? level : this.floor + FLOOR_RISE * (level - this.floor);
    const t = this.threshold();
    const now = Date.now();
    if (level >= t) this.openUntil = now + HOLD_MS;
    const open = now < this.openUntil;
    this.open = open;
    this.onChange(open, level, t);
  }

  close(): void {
    clearInterval(this.timer);
    this.meter?.close();
    this.clone?.stop();
  }
}

// ---- Sounds ----------------------------------------------------------------------------

export type SoundName = "mute" | "unmute" | "deafen" | "undeafen" | "join" | "leave";

/** Each sound is a couple of soft notes, made on the spot: no audio files. */
const NOTES: Record<SoundName, number[]> = {
  mute: [660, 440],
  unmute: [440, 660],
  deafen: [520, 390, 260],
  undeafen: [260, 390, 520],
  join: [523, 784],
  leave: [784, 523],
};

let soundCtx: AudioContext | null = null;

/** The shared context for little sounds and the soundboard. */
export function soundContext(): AudioContext {
  soundCtx ??= new AudioContext();
  void soundCtx.resume().catch(() => {});
  return soundCtx;
}

/**
 * A gain node that plays on the chosen speakers for about `seconds`, at `gain` times the volume
 * of others. Browsers can only pick speakers for media elements, so then it goes through one.
 */
export function outputNode(ctx: AudioContext, prefs: AudioPrefs, gain: number, seconds: number): GainNode {
  const out = ctx.createGain();
  out.gain.value = gain * Math.max(0, Math.min(1, prefs.outputVolume / 100));
  if (prefs.outputId && canPickOutput()) {
    const dest = ctx.createMediaStreamDestination();
    out.connect(dest);
    const el = new Audio();
    el.srcObject = dest.stream;
    applyOutput(el, { ...prefs, outputVolume: 100 });
    void el.play().catch(() => {});
    setTimeout(() => (el.srcObject = null), seconds * 1000 + 500);
  } else out.connect(ctx.destination);
  return out;
}

export function playSound(name: SoundName, prefs: AudioPrefs = loadAudio()): void {
  if (!prefs.sounds) return;
  try {
    const ctx = soundContext();
    const out = outputNode(ctx, prefs, 0.12, 1);
    NOTES[name].forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(env).connect(out);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch {
    // No audio output available: sounds are a nicety.
  }
}
