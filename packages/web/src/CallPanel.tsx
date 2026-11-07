import { useEffect, useRef, useState } from "react";
import { ExternalE2EEKeyProvider, isE2EESupported, Room, RoomEvent, Track, type Participant } from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import type { CallJoin, Conversation, Me } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { keyring } from "./e2ee.ts";
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
    const room = new Room({ adaptiveStream: true, dynacast: true, ...(keyProvider && worker ? { encryption: { keyProvider, worker } } : {}) });
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
        await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => setError(`Microphone: ${err.message}`));
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

  if (!room) return null;
  const local = room.localParticipant;
  const micOn = local.isMicrophoneEnabled;
  const camOn = local.isCameraEnabled;
  const everyone: Participant[] = [local, ...room.remoteParticipants.values()];
  const title = conversation ? conversationTitle(conversation, me.id) : "Call";
  const waiting = status === "connected" && room.remoteParticipants.size === 0;

  const controls = (
    <div className="call-controls">
      <button
        className={micOn ? "" : "off"}
        onClick={() => void local.setMicrophoneEnabled(!micOn).then(() => setVersion((v) => v + 1))}
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

function Tile({ p, isMe, myName }: { p: Participant; isMe: boolean; myName: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const camTrack = cam && !cam.isMuted ? cam.track : undefined;
  const micTrack = !isMe ? mic?.track : undefined;

  useEffect(() => {
    const el = videoRef.current;
    if (!camTrack || !el) return;
    camTrack.attach(el);
    return () => {
      camTrack.detach(el);
    };
  }, [camTrack]);

  useEffect(() => {
    const el = audioRef.current;
    if (!micTrack || !el) return;
    micTrack.attach(el);
    return () => {
      micTrack.detach(el);
    };
  }, [micTrack]);

  const name = isMe ? myName : p.name || p.identity;
  return (
    <div className={`tile ${p.isSpeaking ? "speaking" : ""}`}>
      {camTrack ? <video ref={videoRef} autoPlay playsInline muted={isMe} className={isMe ? "mirror" : ""} /> : <Avatar name={name} size={64} />}
      {micTrack && <audio ref={audioRef} autoPlay />}
      <span className="tile-name">
        {name}
        {isMe ? " (you)" : ""}
        {mic?.isMuted || (isMe && !p.isMicrophoneEnabled) ? " 🔇" : ""}
      </span>
    </div>
  );
}
