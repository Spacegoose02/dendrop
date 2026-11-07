import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type Participant } from "livekit-client";
import type { Channel, ChatServer, Me, VoiceJoin, VoiceMember } from "@dendrop/shared";
import { api } from "./api.ts";
import { Tile } from "./CallPanel.tsx";

/**
 * The voice channel you're in: connects to its LiveKit room and has the controls. Like a call,
 * it stays mounted (compact) while you look at other chats, so you stay in.
 */
export function VoicePanel({
  me,
  join,
  server,
  channel,
  compact,
  onOpen,
  onLeft,
  onSpeakers,
}: {
  me: Me;
  join: VoiceJoin;
  server: ChatServer | undefined;
  channel: Channel | undefined;
  compact: boolean;
  onOpen: () => void;
  onLeft: () => void;
  /** Who is talking right now, for the channel list. */
  onSpeakers: (userIds: number[]) => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [, setVersion] = useState(0);
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  /** Whether the mic was on before deafening, so undeafening puts it back. */
  const micBeforeDeafen = useRef(true);
  const left = useRef(false);
  const bump = () => setVersion((v) => v + 1);

  const report = (state: Partial<Pick<VoiceMember, "muted" | "deafened" | "video" | "screen">>) =>
    void api("/api/voice/state", { body: state }).catch(() => {});

  const leave = () => {
    if (left.current) return;
    left.current = true;
    void room?.disconnect();
    void api("/api/voice/leave", { body: {} }).catch(() => {});
    onSpeakers([]);
    onLeft();
  };

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    setRoom(room);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
    ] as const;
    for (const e of events) room.on(e, bump);
    const onActive = (speakers: Participant[]) => {
      onSpeakers(speakers.map((p) => Number(p.identity)));
      bump();
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onActive);
    let cancelled = false;
    let connected = false;
    // The call server dropped us (or took us out); not us leaving, and not this effect cleaning up.
    const onDisconnected = () => {
      if (!cancelled && connected && !left.current) leave();
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    (async () => {
      try {
        await room.connect(join.url, join.token);
        if (cancelled) return;
        connected = true;
        setStatus("connected");
        await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => {
          setError(`Microphone: ${err.message}`);
          report({ muted: true });
        });
        bump();
      } catch (err) {
        if (!cancelled) {
          setStatus("failed");
          setError(`Couldn't reach the voice server: ${(err as Error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const e of events) room.off(e, bump);
      room.off(RoomEvent.ActiveSpeakersChanged, onActive);
      room.off(RoomEvent.Disconnected, onDisconnected);
      void room.disconnect();
      onSpeakers([]);
    };
    // The room is made once per channel joined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!room) return null;
  const local = room.localParticipant;
  const micOn = local.isMicrophoneEnabled;
  const camOn = local.isCameraEnabled;
  const everyone: Participant[] = [local, ...room.remoteParticipants.values()];
  const nickname = (identity: string) => {
    const m = server?.members.find((x) => String(x.user.id) === identity);
    return m ? (m.nickname ?? m.user.displayName) : undefined;
  };
  const name = channel?.name ?? "voice";
  const alone = status === "connected" && room.remoteParticipants.size === 0;

  const toggleMic = async () => {
    if (deafened) {
      // Unmuting while deafened undeafens too: you can't talk without hearing.
      setDeafened(false);
      await local.setMicrophoneEnabled(true).catch((err: Error) => setError(`Microphone: ${err.message}`));
      report({ muted: !local.isMicrophoneEnabled, deafened: false });
    } else {
      await local.setMicrophoneEnabled(!micOn).catch((err: Error) => setError(`Microphone: ${err.message}`));
      report({ muted: !local.isMicrophoneEnabled });
    }
    bump();
  };

  const toggleDeafen = async () => {
    if (!deafened) {
      micBeforeDeafen.current = micOn;
      setDeafened(true);
      await local.setMicrophoneEnabled(false);
      report({ deafened: true, muted: true });
    } else {
      setDeafened(false);
      if (micBeforeDeafen.current) await local.setMicrophoneEnabled(true).catch((err: Error) => setError(`Microphone: ${err.message}`));
      report({ deafened: false, muted: !local.isMicrophoneEnabled });
    }
    bump();
  };

  const toggleCamera = async () => {
    await local.setCameraEnabled(!camOn).catch((err: Error) => setError(`Camera: ${err.message}`));
    report({ video: local.isCameraEnabled });
    bump();
  };

  const controls = (
    <div className="call-controls">
      <button className={micOn ? "" : "off"} onClick={() => void toggleMic()} aria-pressed={!micOn} title={micOn ? "Mute" : "Unmute"}>
        {micOn ? "🎙️ Mute" : "🔇 Unmute"}
      </button>
      <button className={deafened ? "off" : ""} onClick={() => void toggleDeafen()} aria-pressed={deafened} title={deafened ? "Undeafen" : "Deafen"}>
        {deafened ? "🙉 Undeafen" : "🎧 Deafen"}
      </button>
      {!compact && (
        <button className={camOn ? "" : "off"} onClick={() => void toggleCamera()} aria-pressed={camOn}>
          {camOn ? "📷 Camera off" : "📷 Camera on"}
        </button>
      )}
      <button className="hangup" onClick={leave} title="Leave voice">
        Leave
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="call-bar voice-bar">
        <span className="call-live" aria-hidden />
        <button className="link ellipsis" onClick={onOpen}>
          In voice: 🔊 {name}
          {server ? <span className="muted"> · {server.name}</span> : null}
        </button>
        {controls}
      </div>
    );
  }

  return (
    <div className="call-panel voice-panel">
      <div className="call-tiles">
        {everyone.map((p) => (
          <Tile key={p.identity} p={p} isMe={p === local} myName={nickname(p.identity) ?? me.displayName} label={nickname(p.identity)} deafened={deafened} />
        ))}
      </div>
      <div className="call-status small muted">
        {status !== "failed" && <span>Voice channels aren't end-to-end encrypted yet. </span>}
        {status === "connecting" && "Connecting…"}
        {alone && "It's just you in here. Others can drop in any time."}
        {error && <span className="error">{error}</span>}
      </div>
      {controls}
    </div>
  );
}
