/** Applies this device's audio settings to a LiveKit room: mic choice and cleanup, and input sensitivity. */
import { useEffect, useRef } from "react";
import { RoomEvent, Track, type LocalAudioTrack, type Room, type RoomOptions } from "livekit-client";
import { micConstraints, VoiceGate, type AudioPrefs } from "./audio.ts";
import { loadKeybinds, pttHeld, setVoiceActive, voiceControls } from "./keybinds.ts";
import { canProcessMic, MicProcessor, micContext } from "./micProcessor.ts";

/**
 * How the mic is sent. Opus at up to 64 kbps mono (LiveKit's default is 48), with DTX so silence
 * costs next to nothing and RED so a lost packet doesn't drop a syllable.
 */
const MIC_PUBLISH = { audioPreset: { maxBitrate: 64_000 }, dtx: true, red: true, forceStereo: false };

/** Room options from the settings, for new Room(...). */
export function roomAudioOptions(p: AudioPrefs): Pick<RoomOptions, "audioCaptureDefaults" | "audioOutput" | "publishDefaults"> {
  return { audioCaptureDefaults: micConstraints(p), audioOutput: { deviceId: p.outputId || "default" }, publishDefaults: MIC_PUBLISH };
}

const micTrack = (room: Room): LocalAudioTrack | undefined =>
  room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;

/** Why smart noise suppression isn't running in this call, if it isn't (shown in the voice panel). */
export type MicNote = "browser-fallback" | null;

/**
 * Keeps the mic in step with the settings while connected (switching device or cleanup restarts
 * it), runs it through Dendrop's mic pipeline (smart noise suppression and a look-ahead voice
 * gate, see micProcessor.ts), and runs the voice gate: below the input sensitivity the mic sends
 * silence. In push-to-talk mode it sends only while the key is held.
 *
 * If the pipeline can't start (an old browser, or Firefox refusing the mic's sample rate), the
 * mic goes out as it is with the browser's own noise suppression, and the gate switches the
 * track on and off instead.
 *
 * `onGate` hears whether the gate is open, for a "you're being heard" hint; `onNote` hears when
 * smart suppression had to fall back.
 */
export function useRoomAudio(room: Room | null, prefs: AudioPrefs, onGate?: (open: boolean) => void, onNote?: (note: MicNote) => void): void {
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onGateRef = useRef(onGate);
  onGateRef.current = onGate;
  const onNoteRef = useRef(onNote);
  onNoteRef.current = onNote;
  const applied = useRef(JSON.stringify(micConstraints(prefs)));
  const processor = useRef<MicProcessor | null>(null);
  /** Set when the pipeline failed in this room, so the constraints ask the browser to clean up instead. */
  const fellBack = useRef(false);

  const constraintsFor = (p: AudioPrefs) => micConstraints(fellBack.current && p.noiseSuppression === "smart" ? { ...p, noiseSuppression: "browser" } : p);

  // Device or cleanup changed: restart the mic track with the new constraints.
  useEffect(() => {
    if (!room) return;
    void processor.current?.setDenoise(prefs.noiseSuppression === "smart").catch(() => {});
    const next = JSON.stringify(constraintsFor(prefs));
    if (next === applied.current) return;
    applied.current = next;
    const track = micTrack(room);
    if (track) void track.restartTrack(constraintsFor(prefs)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, prefs]);

  // While a call or voice channel is open, the PC app may watch for push to talk in the background.
  useEffect(() => {
    if (!room) return;
    setVoiceActive(true);
    return () => setVoiceActive(false);
  }, [room]);

  // The pipeline and voice gate follow the mic track, which changes when it's republished.
  useEffect(() => {
    if (!room) return;
    let gate: VoiceGate | null = null;
    /** The LiveKit track we set up for, and (without the pipeline) the raw track the gate watches. */
    let setUpFor: LocalAudioTrack | null = null;
    let gated: MediaStreamTrack | null = null;
    let busy = false;
    let closed = false;
    let voiceOpen = true;
    let lastOpen: boolean | null = null;
    let ctx: AudioContext | null = null;
    const closeCtx = () => {
      void ctx?.close().catch(() => {});
      ctx = null;
    };

    /** Lets the mic through, or sends silence. Muting through LiveKit is the user's mute and wins. */
    const apply = () => {
      const track = micTrack(room);
      if (!track || track !== setUpFor) return;
      const open = loadKeybinds().inputMode === "ptt" ? pttHeld() : voiceOpen;
      const p = processor.current;
      if (p) p.setOpen(open);
      else {
        const t = gated;
        if (!t || track.isMuted || track.mediaStreamTrack !== t) return;
        if (t.enabled !== open) t.enabled = open;
      }
      if (open !== lastOpen) {
        lastOpen = open;
        onGateRef.current?.(open);
      }
    };
    const onLevel = (open: boolean) => {
      voiceOpen = open;
      apply();
    };

    const fallBack = async (track: LocalAudioTrack) => {
      processor.current = null;
      if (prefsRef.current.noiseSuppression === "smart") {
        fellBack.current = true;
        onNoteRef.current?.("browser-fallback");
        applied.current = JSON.stringify(constraintsFor(prefsRef.current));
        await track.restartTrack(constraintsFor(prefsRef.current)).catch(() => {});
      }
    };

    const attach = async () => {
      if (busy || closed) return;
      const track = micTrack(room);
      if (track === setUpFor) {
        // Without the pipeline, restartTrack swaps the raw track under us: follow it.
        if (!processor.current && track && track.mediaStreamTrack !== gated) {
          gate?.close();
          gated = track.mediaStreamTrack;
          gate = new VoiceGate(gated, () => prefsRef.current.sensitivity, onLevel);
        }
        return;
      }
      busy = true;
      try {
        gate?.close();
        gate = null;
        gated = null;
        setUpFor = track ?? null;
        processor.current = null;
        lastOpen = null;
        closeCtx();
        if (!track) return;
        if (canProcessMic() && !fellBack.current) {
          const p = new MicProcessor(prefsRef.current.noiseSuppression === "smart");
          try {
            ctx = micContext();
            await track.setAudioContext(ctx);
            await track.setProcessor(p);
            processor.current = p;
            if (prefsRef.current.noiseSuppression === "smart" && !p.denoising) onNoteRef.current?.("browser-fallback");
          } catch (err) {
            console.warn("Mic pipeline couldn't start; using the browser's own cleanup", err);
            await track.stopProcessor().catch(() => {});
            await fallBack(track);
          }
        } else await fallBack(track);
        if (closed) return;
        const p = processor.current;
        if (p) gate = new VoiceGate(() => p.level(), () => prefsRef.current.sensitivity, onLevel);
        else {
          gated = track.mediaStreamTrack;
          gate = new VoiceGate(gated, () => prefsRef.current.sensitivity, onLevel);
        }
      } finally {
        busy = false;
      }
    };
    const kick = () => void attach();
    kick();
    const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.MediaDevicesChanged] as const;
    for (const e of events) room.on(e, kick);
    voiceControls.addEventListener("ptt-down", apply);
    voiceControls.addEventListener("ptt-up", apply);
    const poll = setInterval(kick, 1000);
    return () => {
      closed = true;
      for (const e of events) room.off(e, kick);
      voiceControls.removeEventListener("ptt-down", apply);
      voiceControls.removeEventListener("ptt-up", apply);
      clearInterval(poll);
      gate?.close();
      if (gated) gated.enabled = true;
      processor.current = null;
      // The room is gone with its tracks; the pipeline's context can go too.
      closeCtx();
    };
  }, [room]);
}
