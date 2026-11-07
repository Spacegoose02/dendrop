/** Applies this device's audio settings to a LiveKit room: mic choice and cleanup, and input sensitivity. */
import { useEffect, useRef } from "react";
import { RoomEvent, Track, type LocalAudioTrack, type Room, type RoomOptions } from "livekit-client";
import { micConstraints, VoiceGate, type AudioPrefs } from "./audio.ts";

/** Room options from the settings, for new Room(...). */
export function roomAudioOptions(p: AudioPrefs): Pick<RoomOptions, "audioCaptureDefaults" | "audioOutput"> {
  return { audioCaptureDefaults: micConstraints(p), audioOutput: { deviceId: p.outputId || "default" } };
}

const micTrack = (room: Room): LocalAudioTrack | undefined =>
  room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;

/**
 * Keeps the mic in step with the settings while connected (switching device or cleanup restarts
 * it), and runs the voice gate: below the input sensitivity the mic sends silence.
 * `onGate` hears whether the gate is open, for a "you're being heard" hint.
 */
export function useRoomAudio(room: Room | null, prefs: AudioPrefs, onGate?: (open: boolean) => void): void {
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onGateRef = useRef(onGate);
  onGateRef.current = onGate;
  const applied = useRef(JSON.stringify(micConstraints(prefs)));

  // Device or cleanup changed: restart the mic track with the new constraints.
  useEffect(() => {
    if (!room) return;
    const next = JSON.stringify(micConstraints(prefs));
    if (next === applied.current) return;
    applied.current = next;
    const track = micTrack(room);
    if (track) void track.restartTrack(micConstraints(prefs)).catch(() => {});
  }, [room, prefs]);

  // The voice gate follows the mic track, which changes when it's restarted or republished.
  useEffect(() => {
    if (!room) return;
    let gate: VoiceGate | null = null;
    let gated: MediaStreamTrack | null = null;
    const attach = () => {
      const t = micTrack(room)?.mediaStreamTrack;
      if (t === gated) return;
      gate?.close();
      gate = null;
      gated = t ?? null;
      if (!t) return;
      gate = new VoiceGate(
        t,
        () => prefsRef.current.sensitivity,
        (open) => {
          // Muting through LiveKit is the user's mute; the gate only lets silence through.
          const track = micTrack(room);
          if (track && !track.isMuted && track.mediaStreamTrack === t) t.enabled = open;
          onGateRef.current?.(open);
        },
      );
    };
    attach();
    const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.MediaDevicesChanged] as const;
    for (const e of events) room.on(e, attach);
    // restartTrack swaps the MediaStreamTrack without an event of its own.
    const poll = setInterval(attach, 1000);
    return () => {
      for (const e of events) room.off(e, attach);
      clearInterval(poll);
      gate?.close();
      if (gated) gated.enabled = true;
    };
  }, [room]);
}
