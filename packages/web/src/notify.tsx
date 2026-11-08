import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotificationSettings, NotifyLevel } from "@dendrop/shared";
import { api } from "./api.ts";

// ---- Your notification settings, shared by every part of the app ----------------------------

let current: NotificationSettings = { conversations: {}, servers: {} };
let loaded = false;
const listeners = new Set<() => void>();

export function setNotificationSettings(s: NotificationSettings): void {
  current = s;
  loaded = true;
  for (const fn of listeners) fn();
}

function load(): void {
  if (loaded) return;
  loaded = true;
  void api<NotificationSettings>("/api/notification-settings").then(setNotificationSettings, () => {
    loaded = false;
  });
}

export function useNotificationSettings(): NotificationSettings {
  useEffect(load, []);
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

const LEVELS: { id: NotifyLevel; label: string; detail: string }[] = [
  { id: "all", label: "All messages", detail: "A notification for every new message." },
  { id: "mentions", label: "Only @mentions", detail: "Only when someone pings you, replies to you, or uses @everyone." },
  { id: "nothing", label: "Nothing (muted)", detail: "No notifications and no unread dot." },
];

/**
 * The 🔔 menu in a chat's header. In a server channel it sets this channel and, below it, the
 * whole server; a channel with no setting of its own follows the server.
 */
export function NotifyMenu({ conversationId, serverId, serverName }: { conversationId: number; serverId?: number; serverName?: string }) {
  const settings = useNotificationSettings();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", esc);
    };
  }, [open]);

  const own = settings.conversations[conversationId];
  const serverLevel = serverId ? settings.servers[serverId] : undefined;
  const effective: NotifyLevel = own ?? serverLevel ?? "all";
  const save = async (body: { conversationId?: number; serverId?: number; level: NotifyLevel | null }) => {
    setError(null);
    try {
      setNotificationSettings(await api<NotificationSettings>("/api/notification-settings", { method: "PUT", body }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const icon = effective === "nothing" ? "🔕" : effective === "mentions" ? "🔔@" : "🔔";

  return (
    <div className="notify-menu-wrap" ref={ref}>
      <button className="ghost icon" onClick={() => setOpen(!open)} title="Notification settings" aria-label="Notification settings" aria-expanded={open}>
        {icon}
      </button>
      {open && (
        <div className="notify-menu" role="menu">
          <div className="section-label">{serverId ? "This channel" : "This conversation"}</div>
          {serverId && (
            <button role="menuitemradio" aria-checked={own === undefined} className={`ghost ${own === undefined ? "active" : ""}`} onClick={() => void save({ conversationId, level: null })}>
              <strong>Same as the server</strong>
              <span className="muted small">{LEVELS.find((l) => l.id === (serverLevel ?? "all"))!.label}</span>
            </button>
          )}
          {LEVELS.map((l) => (
            <button key={l.id} role="menuitemradio" aria-checked={own === l.id || (!serverId && own === undefined && l.id === "all")} className={`ghost ${own === l.id || (!serverId && own === undefined && l.id === "all") ? "active" : ""}`} onClick={() => void save({ conversationId, level: l.id === "all" && !serverId ? null : l.id })}>
              <strong>{l.label}</strong>
              <span className="muted small">{l.detail}</span>
            </button>
          ))}
          {serverId && (
            <>
              <div className="section-label">All of {serverName ?? "this server"}</div>
              {LEVELS.map((l) => (
                <button key={l.id} role="menuitemradio" aria-checked={(serverLevel ?? "all") === l.id} className={`ghost ${(serverLevel ?? "all") === l.id ? "active" : ""}`} onClick={() => void save({ serverId, level: l.id === "all" ? null : l.id })}>
                  <strong>{l.label}</strong>
                </button>
              ))}
            </>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}
