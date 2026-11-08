/**
 * Dendrop's own mic pipeline, run in Web Audio so it sounds the same in every browser:
 *
 *   mic → RNNoise (smart noise suppression, optional) → level meter
 *       → short look-ahead delay → voice gate (a smooth fade, not a hard cut) → what's sent
 *
 * RNNoise is a small neural network (xiph.org) compiled to WebAssembly and run in an
 * AudioWorklet, so it doesn't depend on the browser's own noise suppression. That matters in
 * Firefox, whose built-in suppression is weaker and has no voice isolation.
 *
 * The look-ahead lets the gate decide you're talking a moment before your voice is sent, so the
 * start of a word isn't clipped, and the gate fades instead of switching the track on and off.
 *
 * It plugs into LiveKit as an audio TrackProcessor (track.setProcessor), and the mic check in
 * Settings runs the same pipeline so you hear what others will.
 */
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

/** RNNoise only works at 48 kHz, which is also what Opus sends. */
export const MIC_SAMPLE_RATE = 48000;
/** How far ahead the gate looks: long enough to catch the start of a word, too short to notice. */
const LOOKAHEAD_S = 0.04;
/** Gate fades: quick to open, gentler to close so word endings trail off naturally. */
const OPEN_TC = 0.005;
const CLOSE_TC = 0.04;

let wasm: Promise<ArrayBuffer> | null = null;
const loadedIn = new WeakSet<BaseAudioContext>();

/** Loads RNNoise into a context once (the WebAssembly is fetched once per page). */
async function prepareRnnoise(ctx: AudioContext): Promise<ArrayBuffer> {
  wasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((err: unknown) => {
    wasm = null;
    throw err;
  });
  const binary = await wasm;
  if (!loadedIn.has(ctx)) {
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    loadedIn.add(ctx);
  }
  return binary;
}

/** Whether this browser can run the pipeline at all (AudioWorklet and WebAssembly). */
export const canProcessMic = (): boolean =>
  typeof AudioContext === "function" && typeof AudioWorkletNode === "function" && typeof WebAssembly === "object";

/** A context for the mic pipeline. Made on a click (joining voice), so browsers let it run. */
export function micContext(): AudioContext {
  const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: "interactive" });
  void ctx.resume().catch(() => {});
  return ctx;
}

export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "dendrop-mic";
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private delay: DelayNode | null = null;
  private gate: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private buf = new Float32Array(1024);
  private isOpen = true;
  /** Whether RNNoise is actually running (it can't below 48 kHz). */
  denoising = false;

  constructor(private denoise: boolean) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.build(opts.audioContext, opts.track);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.build(opts.audioContext ?? this.ctx!, opts.track);
  }

  async destroy(): Promise<void> {
    this.teardown();
    this.dest = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
  }

  /** Turns RNNoise on or off without restarting the mic. */
  async setDenoise(on: boolean): Promise<void> {
    if (this.denoise === on) return;
    this.denoise = on;
    const track = this.source?.mediaStream.getAudioTracks()[0];
    if (this.ctx && track) await this.build(this.ctx, track);
  }

  /** The mic's loudness after cleanup, in dBFS (-100 silent to 0 loudest). */
  level(): number {
    if (!this.analyser) return -100;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }

  /** Opens or closes the voice gate, with a short fade. */
  setOpen(open: boolean): void {
    if (open === this.isOpen || !this.gate || !this.ctx) return;
    this.isOpen = open;
    const g = this.gate.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? OPEN_TC : CLOSE_TC);
  }

  private async build(ctx: AudioContext, track: MediaStreamTrack): Promise<void> {
    const binary = this.denoise && ctx.sampleRate === MIC_SAMPLE_RATE ? await prepareRnnoise(ctx) : null;
    this.teardown();
    this.ctx = ctx;
    // Firefox can refuse a mic whose rate differs from the context's; the caller falls back then.
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.delay = ctx.createDelay(0.2);
    this.delay.delayTime.value = LOOKAHEAD_S;
    this.gate = ctx.createGain();
    this.gate.gain.value = this.isOpen ? 1 : 0;
    // Keep one destination (and so one processed track) across rebuilds, so LiveKit's sender keeps it.
    if (this.dest && this.dest.context !== ctx) this.dest = null;
    this.dest ??= ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    let head: AudioNode = this.source;
    this.denoising = false;
    if (binary) {
      this.rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
      head.connect(this.rnnoise);
      head = this.rnnoise;
      this.denoising = true;
    }
    head.connect(this.analyser);
    head.connect(this.delay).connect(this.gate).connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  private teardown(): void {
    for (const n of [this.source, this.rnnoise, this.analyser, this.delay, this.gate]) n?.disconnect();
    this.rnnoise?.destroy();
    this.source = this.rnnoise = this.analyser = this.delay = this.gate = null;
  }
}
