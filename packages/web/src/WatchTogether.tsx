import { useEffect, useRef, useState } from "react";
import { parseWatchLink, watchPosition, type WatchItem, type WatchSession, type WatchVideo } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";

/**
 * Watch together: a video everyone in a voice channel watches at the same moment. The server
 * keeps what's on and where it's up to (WatchSession); each device plays it itself and keeps
 * in step, nudging forward or back when it drifts more than a second.
 */

// ---- The server's clock ---------------------------------------------------------------------

let clockOffset = 0;
let clockReady: Promise<void> | null = null;

/** Measures how far this device's clock is from the server's (a few tries, the quickest wins). */
function syncClock(): Promise<void> {
  clockReady ??= (async () => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const sent = Date.now();
      try {
        const { now } = await api<{ now: number }>("/api/time");
        const rtt = Date.now() - sent;
        if (rtt < best) {
          best = rtt;
          clockOffset = now - (sent + rtt / 2);
        }
      } catch {
        break;
      }
    }
  })();
  return clockReady;
}

const serverNow = () => Date.now() + clockOffset;

/** Where the video should be right now, in seconds. */
const expected = (w: WatchSession) => watchPosition(w, serverNow());

const control = (body: { playing?: boolean; position?: number }) => api("/api/voice/watch/control", { body }).catch(() => {});
const ended = (itemId: string) => api("/api/voice/watch/next", { body: { itemId } }).catch(() => {});

const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

const KIND_ICON: Record<WatchItem["kind"], string> = { file: "🎞️", link: "🔗", youtube: "▶️" };

// ---- The player ------------------------------------------------------------------------------

/** What a player does, so the sync loop drives a <video> and YouTube the same way. */
interface Driver {
  time(): number;
  paused(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
}

/**
 * Keeps a player in step with the session: playing or paused as it should be, and within a
 * second of where everyone else is. Returns whether the browser blocked playing with sound
 * (then a click on "Join in" starts it).
 */
function useSync(driver: Driver | null, watch: WatchSession, applying: React.MutableRefObject<number>) {
  const [blocked, setBlocked] = useState(false);
  const watchRef = useRef(watch);
  watchRef.current = watch;

  useEffect(() => {
    if (!driver) return;
    let stopped = false;
    const tick = async () => {
      const w = watchRef.current;
      const want = expected(w);
      const drift = Math.abs(driver.time() - want);
      if (drift > (w.playing ? 1 : 0.3)) {
        applying.current = Date.now();
        driver.seek(want);
      }
      if (w.playing && driver.paused()) {
        applying.current = Date.now();
        try {
          await driver.play();
          if (!stopped) setBlocked(false);
        } catch (err) {
          if (!stopped && (err as Error).name === "NotAllowedError") setBlocked(true);
        }
      } else if (!w.playing && !driver.paused()) {
        applying.current = Date.now();
        driver.pause();
      }
    };
    void syncClock().then(tick);
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [driver, watch, applying]);

  return blocked;
}

/** True for a second after this device changed the player itself, so that isn't sent as someone's action. */
const ours = (applying: React.MutableRefObject<number>) => Date.now() - applying.current < 1000;

function VideoPlayer({ watch, canControl }: { watch: WatchSession; canControl: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  const applying = useRef(0);
  const item = watch.current;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    setDriver({
      time: () => v.currentTime,
      paused: () => v.paused,
      play: () => v.play(),
      pause: () => v.pause(),
      seek: (s) => {
        v.currentTime = s;
      },
    });
  }, [item.id]);

  const blocked = useSync(driver, watch, applying);

  // Someone using the video's own controls: tell everyone.
  const onPlay = () => {
    const v = ref.current;
    if (v && canControl && !ours(applying) && !watch.playing) void control({ playing: true, position: v.currentTime });
  };
  const onPause = () => {
    const v = ref.current;
    if (v && canControl && !ours(applying) && watch.playing && !v.ended) void control({ playing: false, position: v.currentTime });
  };
  const onSeeked = () => {
    const v = ref.current;
    if (v && canControl && !ours(applying) && Math.abs(v.currentTime - expected(watch)) > 1) void control({ position: v.currentTime });
  };

  return (
    <div className="watch-screen">
      <video
        key={item.id}
        ref={ref}
        src={item.src}
        playsInline
        controls={canControl}
        preload="auto"
        onPlay={onPlay}
        onPause={onPause}
        onSeeked={onSeeked}
        onEnded={() => void ended(item.id)}
      />
      {blocked && <JoinIn onClick={() => void ref.current?.play().catch(() => {})} />}
    </div>
  );
}

// YouTube's IFrame player, loaded only when a YouTube video is on (and only if a super admin allowed it).
interface YtPlayer {
  getCurrentTime(): number;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
}
type YtNamespace = { Player: new (el: HTMLElement, opts: object) => YtPlayer };
let ytReady: Promise<YtNamespace> | null = null;

function loadYouTube(): Promise<YtNamespace> {
  ytReady ??= new Promise((resolve, reject) => {
    const w = window as unknown as { YT?: YtNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      ytReady = null;
      reject(new Error("Couldn't load YouTube's player"));
    };
    document.head.appendChild(s);
  });
  return ytReady;
}

const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ENDED = 0;

function YouTubePlayer({ watch, canControl }: { watch: WatchSession; canControl: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applying = useRef(0);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const item = watch.current;

  useEffect(() => {
    let player: YtPlayer | undefined;
    let gone = false;
    const el = document.createElement("div");
    box.current?.appendChild(el);
    void loadYouTube().then(
      (YT) => {
        if (gone) return;
        player = new YT.Player(el, {
          host: "https://www.youtube-nocookie.com",
          videoId: item.src,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, controls: canControl ? 1 : 0, disablekb: canControl ? 0 : 1, start: Math.floor(expected(watchRef.current)) },
          events: {
            onReady: () => {
              const p = player!;
              setDriver({
                time: () => p.getCurrentTime(),
                paused: () => p.getPlayerState() !== YT_PLAYING && p.getPlayerState() !== 3, // 3 is buffering: still "playing".
                play: async () => p.playVideo(),
                pause: () => p.pauseVideo(),
                seek: (s) => p.seekTo(s, true),
              });
            },
            onStateChange: (e: { data: number }) => {
              const w = watchRef.current;
              if (e.data === YT_ENDED) return void ended(w.current.id);
              if (!canControl || ours(applying)) return;
              const at = player!.getCurrentTime();
              if (e.data === YT_PLAYING && !w.playing) void control({ playing: true, position: at });
              else if (e.data === YT_PAUSED && w.playing) void control({ playing: false, position: at });
              else if (e.data === YT_PLAYING && Math.abs(at - expected(w)) > 2) void control({ position: at });
            },
            onError: () => setError("YouTube won't play this video here (it may not allow being embedded)."),
          },
        });
      },
      (err: Error) => setError(err.message),
    );
    return () => {
      gone = true;
      setDriver(null);
      player?.destroy();
      el.remove();
    };
    // A new player for each video; control changes come through the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useSync(driver, watch, applying);

  return (
    <div className="watch-screen youtube" ref={box}>
      {error && <p className="error watch-error">{error}</p>}
    </div>
  );
}

function JoinIn({ onClick }: { onClick: () => void }) {
  return (
    <button className="watch-join-in primary" onClick={onClick}>
      ▶ Join in
      <span className="small">Your browser wants a click before playing sound.</span>
    </button>
  );
}

/**
 * The video everyone in the channel is watching, with what's up next. People who can talk run
 * it (play, pause, skip, queue); stage listeners just watch.
 */
export function WatchPanel({
  watch,
  canControl,
  isKid,
  nameOf,
  onAdd,
}: {
  watch: WatchSession;
  canControl: boolean;
  isKid: boolean;
  nameOf: (userId: number) => string;
  onAdd: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(0);
  const item = watch.current;
  // Kid accounts only see videos shared in Dendrop itself, not ones from other sites.
  const hidden = isKid && item.kind !== "file";

  useEffect(() => {
    void syncClock();
    const t = setInterval(() => setNow(expected(watch)), 1000);
    setNow(expected(watch));
    return () => clearInterval(t);
  }, [watch]);

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen().catch(() => {});
  };

  return (
    <div className="watch-panel" ref={box}>
      {hidden ? (
        <div className="watch-screen watch-hidden muted">
          📺 The others are watching a video from another site. Kid accounts can watch videos shared in the chat.
        </div>
      ) : item.kind === "youtube" ? (
        <YouTubePlayer key={item.id} watch={watch} canControl={canControl} />
      ) : (
        <VideoPlayer key={item.id} watch={watch} canControl={canControl} />
      )}
      <div className="watch-bar">
        <span className="ellipsis">
          <span aria-hidden>{KIND_ICON[item.kind]} </span>
          <strong>{item.title}</strong>
          <span className="muted small">
            {" "}
            · {watch.playing ? fmt(now) : `Paused at ${fmt(watch.position)}`} · put on by {nameOf(item.addedBy)}
          </span>
        </span>
        <span className="watch-actions">
          {canControl && (
            <>
              <button className="ghost small" onClick={() => void control({ playing: !watch.playing, position: expected(watch) })}>
                {watch.playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button className="ghost small" onClick={() => void api("/api/voice/watch/next", { body: {} }).catch(() => {})} title="Skip to the next video">
                ⏭ {watch.queue.length ? "Next" : "End"}
              </button>
              <button className="ghost small" onClick={onAdd}>
                ＋ Queue
              </button>
              <button className="ghost small danger" onClick={() => void api("/api/voice/watch", { method: "DELETE" }).catch(() => {})}>
                ⏹ Stop
              </button>
            </>
          )}
          <button className="ghost small" onClick={fullscreen} title="Full screen">
            ⛶
          </button>
        </span>
      </div>
      {watch.queue.length > 0 && (
        <ol className="watch-queue small">
          {watch.queue.map((q) => (
            <li key={q.id}>
              <span className="ellipsis">
                {KIND_ICON[q.kind]} {q.title} <span className="muted">· {nameOf(q.addedBy)}</span>
              </span>
              {canControl && (
                <button className="ghost small" aria-label={`Take ${q.title} out of the queue`} onClick={() => void api(`/api/voice/watch/queue/${q.id}`, { method: "DELETE" }).catch(() => {})}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- Picking a video -------------------------------------------------------------------------

const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

/**
 * Puts a video on (or queues it): one posted in the voice channel's chat, or a pasted link to a
 * video file or (when it's turned on) YouTube. Kid accounts only get the chat's videos.
 */
export function WatchDialog({
  serverId,
  channelId,
  playing,
  youtube,
  isKid,
  nameOf,
  onClose,
}: {
  serverId: number;
  channelId: number;
  /** Something's on already, so this adds to the queue. */
  playing: boolean;
  youtube: boolean;
  isKid: boolean;
  nameOf: (userId: number) => string;
  onClose: () => void;
}) {
  const [videos, setVideos] = useState<WatchVideo[] | null>(null);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<WatchVideo[]>(`/api/servers/${serverId}/channels/${channelId}/watch/videos`).then(setVideos, (err: Error) => setError(err.message));
  }, [serverId, channelId]);

  const parsed = link.trim() ? parseWatchLink(link) : null;
  const linkProblem = !link.trim()
    ? null
    : !parsed
      ? "That isn't a link."
      : parsed.kind === "youtube" && !youtube
        ? "YouTube isn't turned on for this Dendrop server. A super admin can turn it on in Admin."
        : null;

  const add = async (body: { attachmentId?: string; url?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/voice/watch", { body });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={playing ? "Add to the queue" : "Watch together"} onClose={onClose}>
      <p className="muted small">
        Everyone in the channel sees it at the same moment. Anyone who can talk here can pause, skip or add more.
      </p>
      {!isKid && (
        <form
          className="watch-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed && !linkProblem) void add({ url: link.trim() });
          }}
        >
          <label>
            Paste a link
            <input
              autoFocus
              placeholder={youtube ? "A YouTube link, or a link to an .mp4 or .webm" : "A link to an .mp4 or .webm video"}
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          {linkProblem && <p className="error small">{linkProblem}</p>}
          <button className="primary" disabled={busy || !parsed || !!linkProblem}>
            {playing ? "Add to queue" : "Play"}
          </button>
        </form>
      )}
      <div className="section-label">Videos posted in this channel's chat</div>
      {videos === null && !error && <p className="muted small">Loading…</p>}
      {videos?.length === 0 && <p className="muted small">None yet. Post a video in this channel's chat (MP4 or WebM) and it shows up here.</p>}
      {!!videos?.length && (
        <ul className="watch-videos">
          {videos.map((v) => (
            <li key={v.attachmentId}>
              <span className="ellipsis">
                🎞️ {v.name}
                <span className="muted small">
                  {" "}
                  · {size(v.size)} · {nameOf(v.postedBy)}
                </span>
              </span>
              <button className="small-button" disabled={busy} onClick={() => void add({ attachmentId: v.attachmentId })}>
                {playing ? "Queue" : "Play"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
