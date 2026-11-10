import { useEffect, useRef, useState } from "react";
import type { Me, PresenceMode } from "@dendrop/shared";
import { api } from "./api.ts";

/**
 * How many unread messages a conversation has: a red number when you were pinged (it counts the
 * pings), otherwise a quiet grey number. Nothing at all when it's caught up.
 */
export function UnreadBadge({ u }: { u?: { count: number; mentions: number } }) {
  if (!u || u.count <= 0) return null;
  const n = u.mentions > 0 ? u.mentions : u.count;
  const text = n > 99 ? "99+" : String(n);
  return (
    <span
      className={`unread-badge ${u.mentions > 0 ? "mention" : ""}`}
      aria-label={u.mentions > 0 ? `${u.mentions} mentions, ${u.count} unread` : `${u.count} unread`}
      title={u.mentions > 0 ? `${u.mentions} pinging you, ${u.count} unread in all` : `${u.count} unread`}
    >
      {u.count >= 100 && u.mentions === 0 ? "99+" : text}
    </span>
  );
}

const CHOICES: { id: PresenceMode; minutes?: number; label: string; detail: string }[] = [
  { id: "online", label: "Online", detail: "Friends see you're here, and you get notifications." },
  { id: "dnd", minutes: 60, label: "Do not disturb for 1 hour", detail: "No notifications or sounds. Calls still ring." },
  { id: "dnd", minutes: 8 * 60, label: "Do not disturb for 8 hours", detail: "Good for a night's sleep." },
  { id: "dnd", label: "Do not disturb until I turn it off", detail: "Stays on until you pick Online." },
  { id: "invisible", label: "Invisible", detail: "Friends see you as offline, but you can still chat." },
];

/** When a Do Not Disturb ends, in words ("until 9:30 PM"), or null when it doesn't end by itself. */
export function dndEnds(me: Me): string | null {
  if (me.presence !== "dnd" || !me.dndUntil) return null;
  return `until ${new Date(me.dndUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The little menu on your own avatar to go online, Do Not Disturb, or invisible. */
export function PresencePicker({ me, onChange }: { me: Me; onChange: (m: Me) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const mode = me.presence ?? "online";
  const pick = async (c: (typeof CHOICES)[number]) => {
    setError(null);
    try {
      onChange(await api<Me>("/api/me/presence", { method: "PUT", body: { presence: c.id, minutes: c.minutes } }));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that");
    }
  };
  const label = mode === "dnd" ? `Do not disturb ${dndEnds(me) ?? ""}`.trim() : mode === "invisible" ? "Invisible" : "Online";
  return (
    <div className="presence-picker" ref={ref}>
      <button className={`ghost presence-button ${mode}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={`${label}. Change your status`} aria-label={`${label}. Change your status`} />
      {open && (
        <div className="menu presence-menu" role="menu">
          {CHOICES.map((c) => {
            const active = c.id === mode && (c.id !== "dnd" || (c.minutes === undefined) === !me.dndUntil);
            return (
              <button key={`${c.id}-${c.minutes ?? ""}`} role="menuitemradio" aria-checked={active} className={`menu-item ${active ? "active" : ""}`} onClick={() => void pick(c)}>
                <span className={`presence-dot ${c.id}`} aria-hidden />
                <span>
                  <strong>{c.label}</strong>
                  <span className="muted small">{c.detail}</span>
                </span>
              </button>
            );
          })}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}
