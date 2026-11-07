import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import type { Channel, ChatServer, Me, VoiceJoin, VoiceMember } from "@dendrop/shared";
import { api } from "./api.ts";
import { loadAudio, micError, playSound, useAudioPrefs } from "./audio.ts";
import { RemoteAudio, Tile } from "./CallPanel.tsx";
import { comboLabel, useKeybinds, voiceControls } from "./keybinds.ts";
import { roomAudioOptions, useRoomAudio } from "./voiceAudio.ts";
import { canShareScreen, ScreenTile, ShareDialog, shareOptions, type ShareQuality } from "./ScreenShare.tsx";

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
  const [sharing, setSharing] = useState<"no" | "picking" | "starting">("no");
  /** Whose screen is shown big, when more than one person shares. */
  const [focus, setFocus] = useState<string | null>(null);
  const left = useRef(false);
  const prefs = useAudioPrefs();
  const keybinds = useKeybinds();
  const [sending, setSending] = useState(true);
  useRoomAudio(room, prefs, setSending);
  const bump = () => setVersion((v) => v + 1);

  const report = (state: Partial<Pick<VoiceMember, "muted" | "deafened" | "video" | "screen">>) =>
    void api("/api/voice/state", { body: state }).catch(() => {});

  const leave = () => {
    if (left.current) return;
    left.current = true;
    playSound("leave");
    void room?.disconnect();
    void api("/api/voice/leave", { body: {} }).catch(() => {});
    onSpeakers([]);
    onLeft();
  };

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true, ...roomAudioOptions(loadAudio()) });
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
    // A soft chime when someone drops in or heads out.
    const onJoined = () => playSound("join");
    const onGone = () => playSound("leave");
    room.on(RoomEvent.ParticipantConnected, onJoined);
    room.on(RoomEvent.ParticipantDisconnected, onGone);
    const onActive = (speakers: Participant[]) => {
      onSpeakers(speakers.map((p) => Number(p.identity)));
      bump();
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onActive);
    // Sharing can also stop from the browser's own "Stop sharing" button.
    const onUnpublished = (pub: { source: Track.Source }) => {
      if (pub.source === Track.Source.ScreenShare) report({ screen: false });
    };
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
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
        playSound("join");
        await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => {
          setError(micError(err));
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
      room.off(RoomEvent.ParticipantConnected, onJoined);
      room.off(RoomEvent.ParticipantDisconnected, onGone);
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Disconnected, onDisconnected);
      void room.disconnect();
      onSpeakers([]);
    };
    // The room is made once per channel joined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keybinds: the latest toggles, whichever render they came from.
  const toggles = useRef({ mute: () => {}, deafen: () => {} });
  useEffect(() => {
    const mute = () => toggles.current.mute();
    const deafen = () => toggles.current.deafen();
    voiceControls.addEventListener("mute", mute);
    voiceControls.addEventListener("deafen", deafen);
    return () => {
      voiceControls.removeEventListener("mute", mute);
      voiceControls.removeEventListener("deafen", deafen);
    };
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
  const screenOn = local.isScreenShareEnabled;
  const sharers = everyone.filter((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  // The newest sharer is shown big unless you picked another.
  const stage = sharers.find((p) => p.identity === focus) ?? sharers[sharers.length - 1];

  const startShare = async (quality: ShareQuality, audio: boolean) => {
    setSharing("starting");
    const { capture, publish } = shareOptions(quality, audio);
    try {
      await local.setScreenShareEnabled(true, capture, publish);
      if (local.isScreenShareEnabled) {
        report({ screen: true });
        setFocus(local.identity);
      }
    } catch (err) {
      // Closing the picker isn't an error worth showing.
      if ((err as Error).name !== "NotAllowedError") setError(`Screen: ${(err as Error).message}`);
    }
    setSharing("no");
    bump();
  };

  const stopShare = async () => {
    await local.setScreenShareEnabled(false);
    report({ screen: false });
    bump();
  };

  const toggleMic = async () => {
    if (deafened) {
      // Unmuting while deafened undeafens too: you can't talk without hearing.
      setDeafened(false);
      await local.setMicrophoneEnabled(true).catch((err: Error) => setError(micError(err)));
      playSound("undeafen");
      report({ muted: !local.isMicrophoneEnabled, deafened: false });
    } else {
      await local.setMicrophoneEnabled(!micOn).catch((err: Error) => setError(micError(err)));
      playSound(local.isMicrophoneEnabled ? "unmute" : "mute");
      report({ muted: !local.isMicrophoneEnabled });
    }
    bump();
  };

  const toggleDeafen = async () => {
    if (!deafened) {
      micBeforeDeafen.current = micOn;
      setDeafened(true);
      await local.setMicrophoneEnabled(false);
      playSound("deafen");
      report({ deafened: true, muted: true });
    } else {
      setDeafened(false);
      if (micBeforeDeafen.current) await local.setMicrophoneEnabled(true).catch((err: Error) => setError(micError(err)));
      playSound("undeafen");
      report({ deafened: false, muted: !local.isMicrophoneEnabled });
    }
    bump();
  };

  toggles.current = { mute: () => void toggleMic(), deafen: () => void toggleDeafen() };

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
      {screenOn ? (
        <button className="sharing" onClick={() => void stopShare()} aria-pressed title="Stop sharing your screen">
          🖥️ Stop sharing
        </button>
      ) : (
        !compact &&
        canShareScreen() && (
          <button onClick={() => setSharing("picking")} disabled={sharing !== "no" || status !== "connected"} title="Share your screen">
            🖥️ Share screen
          </button>
        )
      )}
      <button className="hangup" onClick={leave} title="Leave voice">
        Leave
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="call-bar voice-bar">
        <RemoteAudio room={room} deafened={deafened} />
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
    <div className={`call-panel voice-panel ${stage ? "with-stage" : ""}`}>
      <RemoteAudio room={room} deafened={deafened} />
      {stage && (
        <div className="voice-stage">
          <ScreenTile
            key={stage.identity}
            p={stage}
            isMe={stage === local}
            name={nickname(stage.identity) ?? stage.name ?? "Someone"}
            focused
          />
          {sharers.length > 1 && (
            <div className="stage-others">
              {sharers
                .filter((p) => p !== stage)
                .map((p) => (
                  <ScreenTile
                    key={p.identity}
                    p={p}
                    isMe={p === local}
                    name={nickname(p.identity) ?? p.name ?? "Someone"}
                            focused={false}
                    onFocus={() => setFocus(p.identity)}
                  />
                ))}
            </div>
          )}
        </div>
      )}
      <div className={`call-tiles ${stage ? "strip" : ""}`}>
        {everyone.map((p) => (
          <Tile key={p.identity} p={p} isMe={p === local} myName={nickname(p.identity) ?? me.displayName} label={nickname(p.identity)} />
        ))}
      </div>
      <div className="call-status small muted">
        {status !== "failed" && <span>Voice channels aren't end-to-end encrypted yet. </span>}
        {status === "connecting" && "Connecting…"}
        {alone && "It's just you in here. Others can drop in any time."}
        {keybinds.inputMode === "ptt" && micOn && status === "connected" && (
          <span className={sending ? "ptt-live" : ""}>
            {" "}
            {keybinds.binds.pushToTalk ? (sending ? "Talking…" : `Hold ${comboLabel(keybinds.binds.pushToTalk)} to talk.`) : "Push to talk has no key yet (Settings)."}
          </span>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {controls}
      {sharing === "picking" && <ShareDialog onClose={() => setSharing("no")} onShare={(q, a) => void startShare(q, a)} />}
    </div>
  );
}
