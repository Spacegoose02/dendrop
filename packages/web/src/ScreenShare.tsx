import { useEffect, useRef, useState } from "react";
import { ScreenSharePresets, Track, VideoPreset, type Participant, type ScreenShareCaptureOptions, type TrackPublishOptions } from "livekit-client";
import { Modal } from "./Modal.tsx";

/** What the desktop app's preload adds (see packages/desktop/src/preload.ts). */
interface DesktopScreens {
  screenSources?: () => Promise<{ audio: boolean; sources: ScreenSource[] }>;
  pickScreen?: (id: string | null, audio: boolean) => Promise<void>;
}
interface ScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
}

const desktop = (): DesktopScreens | undefined => (window as unknown as { dendrop?: DesktopScreens }).dendrop;

/** Whether this device can share its screen: browsers with getDisplayMedia, and the desktop app. Not the Android app. */
export const canShareScreen = (): boolean => !!desktop()?.screenSources || typeof navigator.mediaDevices?.getDisplayMedia === "function";

export type ShareQuality = "smooth" | "game" | "text";

export const QUALITIES: { id: ShareQuality; label: string; detail: string }[] = [
  { id: "smooth", label: "Smooth", detail: "1080p at 30 fps. Videos, browsing, most things." },
  { id: "game", label: "Game", detail: "1080p at 60 fps, more bandwidth. Fast games." },
  { id: "text", label: "Sharp text", detail: "1080p at 15 fps, crisp. Code and documents." },
];

/** Capture and publish options for a quality. Game streams get the most bits and frames. */
export function shareOptions(quality: ShareQuality, audio: boolean): { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions } {
  const preset =
    quality === "game"
      ? new VideoPreset(1920, 1080, 6_000_000, 60, "high")
      : quality === "text"
        ? ScreenSharePresets.h1080fps15
        : ScreenSharePresets.h1080fps30;
  return {
    capture: {
      audio,
      systemAudio: audio ? "include" : "exclude",
      resolution: preset.resolution,
      contentHint: quality === "text" ? "detail" : "motion",
      // Keeps the voice channel's own tab out of the list, so nobody shares a hall of mirrors.
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    },
    publish: {
      screenShareEncoding: preset.encoding,
      // Text stays sharp by dropping frames; games stay smooth by dropping resolution.
      degradationPreference: quality === "text" ? "maintain-resolution" : "maintain-framerate",
    },
  };
}

/**
 * Picks what to share and how. In the desktop app it lists screens and windows itself (Electron
 * has no picker on Windows and Linux); in a browser, the browser's own picker opens after this.
 */
export function ShareDialog({ onShare, onClose }: { onShare: (quality: ShareQuality, audio: boolean) => void; onClose: () => void }) {
  const d = desktop();
  const [quality, setQuality] = useState<ShareQuality>("smooth");
  const [audio, setAudio] = useState(false);
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [desktopAudio, setDesktopAudio] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!d?.screenSources) return;
    d.screenSources()
      .then((r) => {
        setSources(r.sources);
        setDesktopAudio(r.audio);
        setPicked(r.sources[0]?.id ?? null);
      })
      .catch((err: Error) => setError(err.message));
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const share = async () => {
    if (d?.pickScreen) {
      if (!picked) return;
      await d.pickScreen(picked, audio && desktopAudio);
    }
    onShare(quality, audio && (!d?.pickScreen || desktopAudio));
  };

  return (
    <Modal title="Share your screen" onClose={onClose}>
      {d?.screenSources && (
        <>
          {!sources && !error && <p className="muted small">Finding screens and windows…</p>}
          {sources && (
            <div className="share-sources" role="radiogroup" aria-label="What to share">
              {sources.map((x) => (
                <label key={x.id} className={`share-source ${picked === x.id ? "picked" : ""}`}>
                  <input type="radio" name="share-source" checked={picked === x.id} onChange={() => setPicked(x.id)} />
                  <img src={x.thumbnail} alt="" />
                  <span className="ellipsis small">
                    {x.kind === "screen" ? "🖥️ " : ""}
                    {x.name}
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
      <div className="kind-picker" role="radiogroup" aria-label="Quality">
        {QUALITIES.map((q) => (
          <label key={q.id} className={`kind-option ${quality === q.id ? "picked" : ""}`}>
            <input
              type="radio"
              name="share-quality"
              checked={quality === q.id}
              onChange={() => {
                setQuality(q.id);
                // Games are better with their sound.
                if (q.id === "game") setAudio(true);
              }}
            />
            <span>
              <strong>{q.label}</strong>
              <span className="muted small">{q.detail}</span>
            </span>
          </label>
        ))}
      </div>
      {(!d?.pickScreen || desktopAudio) && (
        <label className="toggle">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          <span>
            <strong>Share sound too</strong>
            <span className="muted small">
              {d?.pickScreen ? "Everything your PC plays, so mute anything private." : "Chrome and Edge can share a tab's sound, or the whole screen's on Windows."}
            </span>
          </span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={!!d?.pickScreen && !picked} onClick={() => void share()}>
        {d?.pickScreen ? "Share" : "Choose what to share"}
      </button>
    </Modal>
  );
}

/** Someone's shared screen, with a full screen button. Its sound plays through RemoteAudio. */
export function ScreenTile({
  p,
  isMe,
  name,
  focused,
  onFocus,
}: {
  p: Participant;
  isMe: boolean;
  name: string;
  focused: boolean;
  onFocus?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const video = p.getTrackPublication(Track.Source.ScreenShare)?.track;

  useEffect(() => {
    const el = videoRef.current;
    if (!video || !el) return;
    video.attach(el);
    return () => {
      video.detach(el);
    };
  }, [video]);

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen().catch(() => {});
  };

  return (
    <div ref={box} className={`tile screen-tile ${focused ? "focused" : ""}`}>
      <video ref={videoRef} autoPlay playsInline muted onDoubleClick={fullscreen} />
      <span className="tile-name">
        🖥️ {isMe ? "Your screen" : `${name}'s screen`}
      </span>
      <span className="screen-actions">
        {onFocus && !focused && (
          <button className="ghost" onClick={onFocus} title="Show big">
            ⤢ Show
          </button>
        )}
        <button className="ghost" onClick={fullscreen} title="Full screen (or double-click)">
          ⛶ Full screen
        </button>
      </span>
    </div>
  );
}
