import { useCallback, useState } from "react";
import { BUILTIN_SOUNDS, type ChatServer } from "@dendrop/shared";
import { api } from "./api.ts";
import { useDismiss } from "./Fun.tsx";

/**
 * The soundboard button in a voice channel, and its menu: the built-in sounds and the server's
 * own. Picking one plays it for everyone in the channel (the server sends it round, and each app
 * plays it at its own soundboard volume, yours included).
 */
export function SoundboardButton({ server, disabled, onError }: { server: ChatServer | undefined; disabled: boolean; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="soundboard-anchor">
      <button data-fun-toggle onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={disabled} title={disabled ? "Undeafen to use the soundboard" : "Play a sound for everyone here"}>
        🔊 Soundboard
      </button>
      {open && <SoundboardMenu server={server} onClose={close} onError={onError} />}
    </span>
  );
}

function SoundboardMenu({ server, onClose, onError }: { server: ChatServer | undefined; onClose: () => void; onError: (msg: string) => void }) {
  const ref = useDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const play = async (body: { builtin: string } | { soundId: number }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/voice/sound", { body });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      // The server asks for a short wait between sounds; the buttons rest for it too.
      setTimeout(() => setBusy(false), 2000);
    }
  };
  const sounds = server?.sounds ?? [];
  return (
    <div className="fun-menu soundboard-menu" ref={ref} role="menu" aria-label="Soundboard">
      <div className="section-label">Everyone has</div>
      <div className="soundboard-grid">
        {BUILTIN_SOUNDS.map((b) => (
          <button key={b.id} role="menuitem" className="soundboard-sound" disabled={busy} onClick={() => void play({ builtin: b.id })}>
            <span aria-hidden>{b.emoji}</span> {b.name}
          </button>
        ))}
      </div>
      {server && (
        <>
          <div className="section-label">{server.name}</div>
          {sounds.length ? (
            <div className="soundboard-grid">
              {sounds.map((s) => (
                <button key={s.id} role="menuitem" className="soundboard-sound" disabled={busy} onClick={() => void play({ soundId: s.id })}>
                  {s.emoji && <span aria-hidden>{s.emoji}</span>} {s.name.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">No sounds of its own yet. People with Manage emoji &amp; stickers can add some in server settings, Sounds.</p>
          )}
        </>
      )}
      <p className="muted small">Change how loud sounds are for you in Settings, Voice and audio.</p>
    </div>
  );
}
