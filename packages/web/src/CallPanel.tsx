import { useEffect, useRef, useState } from "react";
import { ExternalE2EEKeyProvider, isE2EESupported, Room, RoomEvent, Track, type Participant, type RemoteTrack } from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import type { CallJoin, Conversation, Me } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import {
  applyOutput,
  canPickOutput,
  effectiveUserGain,
  loadAudio,
  micError,
  playSound,
  saveUserVolume,
  soundContext,
  useAudioPrefs,
  userVolume,
  useUserVolumes,
  type AudioPrefs,
  type UserVolume,
} from "./audio.ts";
import "./call.css";
import { keyring } from "./e2ee.ts";
import { voiceControls } from "./keybinds.ts";
import { roomAudioOptions, useRoomAudio } from "./voiceAudio.ts";
import { conversationTitle } from "./util.ts";

/**
 * The call you're in: connects to its LiveKit room, shows everyone, and has the controls.
 * It stays mounted while you look at other chats (compact), so the call keeps going.
 */
export function CallPanel({
  me,
  join,
  conversation,
  compact,
  onOpen,
  onLeft,
}: {
  me: Me;
  join: CallJoin;
  conversation: Conversation | undefined;
  compact: boolean;
  onOpen: () => void;
  onLeft: () => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [, setVersion] = useState(0);
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const left = useRef(false);
  const cid = join.call.conversationId;
  // Calls in an encrypted conversation are encrypted too, with a key only its members can make.
  const keyVersion = conversation?.e2ee?.version ?? null;
  const prefs = useAudioPrefs();
  useRoomAudio(room, prefs);

  const leave = () => {
    if (left.current) return;
    left.current = true;
    void room?.disconnect();
    void api(`/api/conversations/${cid}/call/leave`, { body: {} }).catch(() => {});
    onLeft();
  };

  useEffect(() => {
    const keyProvider = keyVersion ? new ExternalE2EEKeyProvider() : null;
    const worker = keyProvider && isE2EESupported() ? new E2EEWorker() : null;
    const room = new Room({ adaptiveStream: true, dynacast: true, ...roomAudioOptions(loadAudio()), ...(keyProvider && worker ? { encryption: { keyProvider, worker } } : {}) });
    setRoom(room);
    const bump = () => setVersion((v) => v + 1);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
    ] as const;
    for (const e of events) room.on(e, bump);
    let cancelled = false;
    // The call server dropped us (not us hanging up, and not this effect cleaning up).
    // A failed first connection also fires this; that case shows an error instead.
    let connected = false;
    const onDisconnected = () => {
      if (!cancelled && connected && !left.current) leave();
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    const onEncryptionError = (err: Error) => setError(`Encryption: ${err.message}`);
    room.on(RoomEvent.EncryptionError, onEncryptionError);
    let keyReady = false;
    (async () => {
      try {
        if (keyVersion && keyProvider) {
          // Never fall back to an unencrypted call in an encrypted conversation.
          if (!worker) throw new Error("this browser can't do encrypted calls; try an up-to-date Chrome, Edge, Safari or Firefox");
          if (!keyring.identity) throw new Error("unlock encryption on this device to join encrypted calls");
          const key = await keyring.callKey(cid, keyVersion, join.call.startedAt);
          if (!key) throw new Error("this device doesn't have the conversation key");
          await keyProvider.setKey(key);
          await room.setE2EEEnabled(true);
          keyReady = true;
          if (cancelled) return;
          setEncrypted(true);
        }
        await room.connect(join.url, join.token);
        if (cancelled) return;
        connected = true;
        setStatus("connected");
        await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => setError(micError(err)));
        if (join.call.video && join.call.startedBy === me.id) {
          await room.localParticipant.setCameraEnabled(true).catch((err: Error) => setError(`Camera: ${err.message}`));
        }
        bump();
      } catch (err) {
        if (!cancelled) {
          setStatus("failed");
          const msg = (err as Error).message;
          setError(keyVersion && !keyReady ? `Can't start an encrypted call: ${msg}` : `Couldn't reach the call server: ${msg}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const e of events) room.off(e, bump);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.EncryptionError, onEncryptionError);
      void room.disconnect();
      worker?.terminate();
    };
    // The room is made once per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMic = useRef(() => {});
  useEffect(() => {
    const mute = () => toggleMic.current();
    voiceControls.addEventListener("mute", mute);
    return () => voiceControls.removeEventListener("mute", mute);
  }, []);

  if (!room) return null;
  const local = room.localParticipant;
  const micOn = local.isMicrophoneEnabled;
  const camOn = local.isCameraEnabled;
  const everyone: Participant[] = [local, ...room.remoteParticipants.values()];
  const title = conversation ? conversationTitle(conversation, me.id) : "Call";
  const waiting = status === "connected" && room.remoteParticipants.size === 0;

  toggleMic.current = () =>
    void local
      .setMicrophoneEnabled(!micOn)
      .then(() => {
        playSound(micOn ? "mute" : "unmute");
        setVersion((v) => v + 1);
      })
      .catch((err: Error) => setError(micError(err)));

  const controls = (
    <div className="call-controls">
      <button
        className={micOn ? "" : "off"}
        onClick={() => toggleMic.current()}
        aria-pressed={!micOn}
        title={micOn ? "Mute" : "Unmute"}
      >
        {micOn ? "🎙️ Mute" : "🔇 Unmute"}
      </button>
      {!compact && (
        <button
          className={camOn ? "" : "off"}
          onClick={() =>
            void local
              .setCameraEnabled(!camOn)
              .then(() => setVersion((v) => v + 1))
              .catch((err: Error) => setError(`Camera: ${err.message}`))
          }
          aria-pressed={camOn}
        >
          {camOn ? "📷 Camera off" : "📷 Camera on"}
        </button>
      )}
      <button className="hangup" onClick={leave} title="Hang up">
        Hang up
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="call-bar">
        <RemoteAudio room={room} />
        <span className="call-live" aria-hidden />
        <button className="link ellipsis" onClick={onOpen}>
          {encrypted ? "🔒 " : ""}In a call with {title}
        </button>
        {controls}
      </div>
    );
  }

  return (
    <div className="call-panel">
      <RemoteAudio room={room} />
      <div className="call-tiles">
        {everyone.map((p) => (
          <Tile key={p.identity} p={p} isMe={p === local} myName={me.displayName} />
        ))}
      </div>
      <div className="call-status small muted">
        {status !== "failed" && (
          <span className={encrypted ? "call-lock" : ""}>{encrypted ? "🔒 End-to-end encrypted" : keyVersion ? "" : "Not end-to-end encrypted"} </span>
        )}
        {status === "connecting" && "Connecting…"}
        {waiting && "Ringing…"}
        {error && <span className="error">{error}</span>}
      </div>
      {controls}
    </div>
  );
}

/**
 * Plays everyone else's voices (and shared screens' sound). Rendered whether the panel is big or
 * compact, so you keep hearing people while you look at other chats.
 */
export function RemoteAudio({ room, deafened = false }: { room: Room; deafened?: boolean }) {
  const prefs = useAudioPrefs();
  const volumes = useUserVolumes();
  const tracks: { track: RemoteTrack; identity: string }[] = [];
  for (const p of room.remoteParticipants.values()) {
    for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio]) {
      const t = p.getTrackPublication(source)?.track;
      if (t) tracks.push({ track: t as RemoteTrack, identity: p.identity });
    }
  }
  return (
    <>
      {tracks.map(({ track: t, identity }) => (
        <TrackAudio key={t.sid ?? t.mediaStreamTrack.id} track={t} muted={deafened} prefs={prefs} person={userVolume(identity, volumes)} />
      ))}
    </>
  );
}

function TrackAudio({ track, muted, prefs, person }: { track: RemoteTrack; muted: boolean; prefs: AudioPrefs; person: UserVolume }) {
  const ref = useRef<HTMLAudioElement>(null);
  const boostGain = useRef<GainNode | null>(null);
  const [boosting, setBoosting] = useState(false);
  const gain = effectiveUserGain(prefs, person, muted);
  const isMuted = muted || person.muted || gain === 0;
  const wantBoost = !isMuted && person.volume > 100;

  useEffect(() => {
    if (ref.current) applyOutput(ref.current, { ...prefs, outputVolume: Math.min(100, Math.round(gain * 100)) });
  }, [prefs, gain]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  // Above 100%, HTMLMediaElement.volume caps at 1.0, so pipe the track through a Web Audio GainNode.
  useEffect(() => {
    if (!wantBoost) {
      boostGain.current = null;
      setBoosting(false);
      return;
    }
    let src: MediaStreamAudioSourceNode | null = null;
    let node: GainNode | null = null;
    let sinkEl: HTMLAudioElement | null = null;
    try {
      const ctx = soundContext();
      src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      node = ctx.createGain();
      node.gain.value = gain;
      if (prefs.outputId && canPickOutput()) {
        const dest = ctx.createMediaStreamDestination();
        src.connect(node).connect(dest);
        sinkEl = new Audio();
        sinkEl.srcObject = dest.stream;
        applyOutput(sinkEl, { ...prefs, outputVolume: 100 });
        void sinkEl.play().catch(() => {});
      } else {
        src.connect(node).connect(ctx.destination);
      }
      boostGain.current = node;
      setBoosting(true);
    } catch {
      boostGain.current = null;
      setBoosting(false);
    }
    return () => {
      boostGain.current = null;
      setBoosting(false);
      try {
        src?.disconnect();
        node?.disconnect();
      } catch {
        // Already disconnected.
      }
      if (sinkEl) sinkEl.srcObject = null;
    };
    // `gain` is updated smoothly below without rebuilding the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, wantBoost, prefs.outputId]);

  useEffect(() => {
    if (boostGain.current) boostGain.current.gain.value = gain;
  }, [gain]);

  return <audio ref={ref} autoPlay muted={isMuted || boosting} />;
}

/** One person in a call or voice channel: their camera or avatar, and their audio. */
export function Tile({ p, isMe, myName, label }: { p: Participant; isMe: boolean; myName: string; label?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const [volOpen, setVolOpen] = useState(false);
  const volumes = useUserVolumes();
  const uv = isMe ? { volume: 100, muted: false } : userVolume(p.identity, volumes);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const camTrack = cam && !cam.isMuted ? cam.track : undefined;

  useEffect(() => {
    const el = videoRef.current;
    if (!camTrack || !el) return;
    camTrack.attach(el);
    return () => {
      camTrack.detach(el);
    };
  }, [camTrack]);

  useEffect(() => {
    if (!volOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tileRef.current && !tileRef.current.contains(e.target as Node)) setVolOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVolOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [volOpen]);

  const name = label ?? (isMe ? myName : p.name || p.identity);
  const locallyMuted = !isMe && (uv.muted || uv.volume === 0);
  const customVol = !isMe && (uv.muted || uv.volume !== 100);

  return (
    <div
      ref={tileRef}
      className={`tile ${p.isSpeaking && !locallyMuted ? "speaking" : ""}`}
      onContextMenu={
        isMe
          ? undefined
          : (e) => {
              e.preventDefault();
              setVolOpen((o) => !o);
            }
      }
    >
      {camTrack ? <video ref={videoRef} autoPlay playsInline muted={isMe} className={isMe ? "mirror" : ""} /> : <Avatar name={name} size={64} />}
      {!isMe && (
        <button
          type="button"
          className={`tile-vol-btn ${customVol ? "changed" : ""} ${locallyMuted ? "muted" : ""}`}
          aria-label={`Volume for ${name}`}
          aria-expanded={volOpen}
          title="Adjust volume or mute for you (or right-click)"
          onClick={() => setVolOpen((o) => !o)}
        >
          {locallyMuted ? "🔇 Muted" : uv.volume !== 100 ? `🔊 ${uv.volume}%` : "🔊"}
        </button>
      )}
      {!isMe && volOpen && (
        <div className="tile-vol-pop" role="dialog" aria-label={`Volume for ${name}`}>
          <div className="tile-vol-head">
            <strong className="ellipsis">{name}</strong>
            <span className="muted">{locallyMuted ? "Muted for you" : `${uv.volume}%`}</span>
          </div>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={uv.muted ? 0 : uv.volume}
            aria-label={`${name} volume`}
            onChange={(e) => {
              const v = Number(e.target.value);
              saveUserVolume(p.identity, { volume: v, muted: v === 0 });
            }}
          />
          <div className="tile-vol-actions">
            <button
              type="button"
              className="ghost"
              aria-pressed={locallyMuted}
              onClick={() =>
                saveUserVolume(p.identity, {
                  muted: !locallyMuted,
                  ...(locallyMuted && uv.volume === 0 ? { volume: 100 } : {}),
                })
              }
            >
              {locallyMuted ? "🔊 Unmute for me" : "🔇 Mute for me"}
            </button>
            {customVol && (
              <button type="button" className="ghost" onClick={() => saveUserVolume(p.identity, { volume: 100, muted: false })}>
                100%
              </button>
            )}
          </div>
        </div>
      )}
      <span className="tile-name">
        {name}
        {isMe ? " (you)" : ""}
        {mic?.isMuted || (isMe && !p.isMicrophoneEnabled) ? " 🔇" : locallyMuted ? " 🔇 (for you)" : ""}
      </span>
    </div>
  );
}
