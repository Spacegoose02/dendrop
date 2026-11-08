import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import type { Channel, ChatServer, Me, ScheduledEvent, VoiceChannelState, VoiceJoin, VoiceMember } from "@dendrop/shared";
import { api } from "./api.ts";
import { loadAudio, micError, playSound, useAudioPrefs } from "./audio.ts";
import { RemoteAudio, Tile } from "./CallPanel.tsx";
import { comboLabel, useKeybinds, voiceControls } from "./keybinds.ts";
import { roomAudioOptions, useRoomAudio, type MicNote } from "./voiceAudio.ts";
import { SoundboardButton } from "./SoundboardMenu.tsx";
import { setSoundboardDeafened } from "./soundboard.ts";
import { canShareScreen, ScreenTile, ShareDialog, shareOptions, type ShareQuality } from "./ScreenShare.tsx";
import { can } from "./roles.ts";
import { WatchDialog, WatchPanel } from "./WatchTogether.tsx";

/**
 * The voice channel you're in: connects to its LiveKit room and has the controls. Like a call,
 * it stays mounted (compact) while you look at other chats, so you stay in.
 *
 * On a stage channel only speakers talk. Listeners hear them and can raise a hand; stage
 * moderators (Manage channels or Manage events) let people speak or move them back.
 */
export function VoicePanel({
  me,
  join,
  live,
  event,
  server,
  channel,
  compact,
  onOpen,
  onLeft,
  onSpeakers,
  watchYoutube = false,
}: {
  me: Me;
  join: VoiceJoin;
  /** Who is in the channel now, from the server (speakers, listeners, raised hands). */
  live: VoiceChannelState | undefined;
  /** The event going on in this channel right now, if any. */
  event?: ScheduledEvent;
  server: ChatServer | undefined;
  channel: Channel | undefined;
  compact: boolean;
  onOpen: () => void;
  onLeft: () => void;
  /** Who is talking right now, for the channel list. */
  onSpeakers: (userIds: number[]) => void;
  /** YouTube is turned on for watch together. */
  watchYoutube?: boolean;
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
  const [micNote, setMicNote] = useState<MicNote>(null);
  useRoomAudio(room, prefs, setSending, setMicNote);
  // Deafened means the soundboard is quiet too.
  useEffect(() => {
    setSoundboardDeafened(deafened);
    return () => setSoundboardDeafened(false);
  }, [deafened]);
  const bump = () => setVersion((v) => v + 1);
  const isStage = join.voice.stage;
  const members = live?.members ?? join.voice.members;
  const mine = members.find((m) => m.userId === me.id);
  const speaker = !isStage || mine?.speaker !== false;
  const moderator = !!server && (can(server, "manageChannels") || can(server, "manageEvents"));
  const [stageNote, setStageNote] = useState<string | null>(null);
  const [watchDialog, setWatchDialog] = useState(false);
  const watch = live ? live.watch : (join.voice.watch ?? null);

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
        // Stage listeners only listen; their token can't send anything.
        if (join.voice.members.find((m) => m.userId === me.id)?.speaker !== false) {
          await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => {
            setError(micError(err));
            report({ muted: true });
          });
        }
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

  // Let up on stage, or moved back to the audience.
  const wasSpeaker = useRef(speaker);
  useEffect(() => {
    if (!room || wasSpeaker.current === speaker) return;
    wasSpeaker.current = speaker;
    if (speaker) {
      setStageNote("You can speak now. Unmute when you're ready.");
      playSound("join");
    } else {
      setStageNote("You're listening again.");
      const p = room.localParticipant;
      void Promise.all([p.setMicrophoneEnabled(false), p.setCameraEnabled(false), p.setScreenShareEnabled(false)]).catch(() => {}).then(bump);
    }
  }, [speaker, room]);

  if (!room) return null;
  const local = room.localParticipant;
  const micOn = local.isMicrophoneEnabled;
  const camOn = local.isCameraEnabled;
  const speakerIds = new Set(members.filter((m) => m.speaker).map((m) => String(m.userId)));
  const inRoom: Participant[] = [local, ...room.remoteParticipants.values()];
  // On a stage the tiles are the speakers; the audience is counted below.
  const everyone = isStage ? inRoom.filter((p) => speakerIds.has(p.identity)) : inRoom;
  const audience = isStage ? members.filter((m) => !m.speaker) : [];
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
    if (!speaker) return;
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

  const raiseHand = (raised: boolean) => void api("/api/voice/hand", { body: { raised } }).catch((err: Error) => setError(err.message));
  const setSpeakerOf = (userId: number, on: boolean) =>
    void api(`/api/servers/${join.voice.serverId}/channels/${join.voice.channelId}/stage/${userId}`, { method: "PUT", body: { speaker: on } }).catch((err: Error) =>
      setError(err.message),
    );
  const memberName = (userId: number) => nickname(String(userId)) ?? (userId === me.id ? me.displayName : "Someone");

  const toggleCamera = async () => {
    await local.setCameraEnabled(!camOn).catch((err: Error) => setError(`Camera: ${err.message}`));
    report({ video: local.isCameraEnabled });
    bump();
  };

  const listenerControls = (
    <div className="call-controls">
      <button className={mine?.handRaised ? "sharing" : ""} onClick={() => raiseHand(!mine?.handRaised)} aria-pressed={!!mine?.handRaised}>
        {mine?.handRaised ? "✋ Lower hand" : "✋ Raise hand"}
      </button>
      <button className={deafened ? "off" : ""} onClick={() => setDeafened((d) => !d)} aria-pressed={deafened} title={deafened ? "Listen again" : "Mute the stage"}>
        {deafened ? "🙉 Listen" : "🎧 Mute stage"}
      </button>
      <button className="hangup" onClick={leave} title="Leave the stage">
        Leave
      </button>
    </div>
  );

  const controls = !speaker ? (
    listenerControls
  ) : (
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
      {!compact && (
        <button className={watch ? "sharing" : ""} onClick={() => setWatchDialog(true)} title="Watch a video together">
          📺 {watch ? "Queue a video" : "Watch together"}
        </button>
      )}
      {!compact && status === "connected" && <SoundboardButton server={server} disabled={deafened} onError={setError} />}
      {isStage && !compact && (
        <button onClick={() => setSpeakerOf(me.id, false)} title="Stop speaking and listen with everyone else">
          🎧 Move to audience
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
        <RemoteAudio room={room} deafened={deafened} />
        <span className="call-live" aria-hidden />
        <button className="link ellipsis" onClick={onOpen}>
          {isStage ? `${speaker ? "On stage" : "Listening"}: 🎙️ ${event?.name ?? name}` : `In voice: 🔊 ${name}`}
          {server ? <span className="muted"> · {server.name}</span> : null}
          {watch ? <span className="muted"> · 📺 {watch.current.title}</span> : null}
        </button>
        {controls}
      </div>
    );
  }

  return (
    <div className={`call-panel voice-panel ${stage ? "with-stage" : ""} ${isStage ? "stage-panel" : ""}`}>
      <RemoteAudio room={room} deafened={deafened} />
      {isStage && (
        <div className="stage-head">
          {event ? (
            <>
              <span className="live-tag">Live</span> <strong>{event.name}</strong>
            </>
          ) : (
            <strong>🎙️ {name}</strong>
          )}
          <span className="muted small">
            {" "}
            · {members.length - audience.length} speaking · {audience.length} listening
          </span>
        </div>
      )}
      {watch && (
        <WatchPanel watch={watch} canControl={speaker} isKid={!!me.isKid} nameOf={memberName} onAdd={() => setWatchDialog(true)} />
      )}
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
      {isStage && audience.length > 0 && (
        <div className="stage-audience">
          <div className="section-label">Audience · {audience.length}</div>
          <ul>
            {[...audience]
              .sort((a, b) => Number(b.handRaised) - Number(a.handRaised))
              .map((m) => (
                <li key={m.userId} className={m.handRaised ? "hand" : ""}>
                  <span className="ellipsis">
                    {m.handRaised && <span aria-label="Hand raised">✋ </span>}
                    {memberName(m.userId)}
                  </span>
                  {moderator && (
                    <button className="small-button" onClick={() => setSpeakerOf(m.userId, true)}>
                      Let speak
                    </button>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
      {isStage && moderator && everyone.some((p) => p !== local) && (
        <div className="stage-audience">
          <div className="section-label">Speakers</div>
          <ul>
            {everyone
              .filter((p) => p !== local)
              .map((p) => (
                <li key={p.identity}>
                  <span className="ellipsis">{nickname(p.identity) ?? p.name ?? "Someone"}</span>
                  <button className="small-button" onClick={() => setSpeakerOf(Number(p.identity), false)}>
                    Move to audience
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      <div className="call-status small muted">
        {stageNote && <span>{stageNote} </span>}
        {isStage && !speaker && !stageNote && <span>You're listening. Raise your hand to ask to speak. </span>}
        {status !== "failed" && <span>Voice channels aren't end-to-end encrypted yet. </span>}
        {status === "connecting" && "Connecting…"}
        {alone && "It's just you in here. Others can drop in any time."}
        {keybinds.inputMode === "ptt" && micOn && status === "connected" && (
          <span className={sending ? "ptt-live" : ""}>
            {" "}
            {keybinds.binds.pushToTalk ? (sending ? "Talking…" : `Hold ${comboLabel(keybinds.binds.pushToTalk)} to talk.`) : "Push to talk has no key yet (Settings)."}
          </span>
        )}
        {micNote === "browser-fallback" && prefs.noiseSuppression === "smart" && (
          <span className="muted"> Smart noise suppression couldn't start here, so the browser's own is on. </span>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {controls}
      {watchDialog && (
        <WatchDialog
          serverId={join.voice.serverId}
          channelId={join.voice.channelId}
          playing={!!watch}
          youtube={watchYoutube}
          isKid={!!me.isKid}
          nameOf={memberName}
          onClose={() => setWatchDialog(false)}
        />
      )}
      {sharing === "picking" && <ShareDialog onClose={() => setSharing("no")} onShare={(q, a) => void startShare(q, a)} />}
    </div>
  );
}
