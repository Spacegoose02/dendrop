import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LIMITS, type NotificationSettings, type NotifyLevel } from "@dendrop/shared";
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

/** Your settings right now, for code outside React (loads them the first time). */
export function notificationSettings(): NotificationSettings {
  load();
  return current;
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
  { id: "mentions", label: "Only @mentions", detail: "Only when someone pings you, replies to you, uses @everyone, or writes one of your keywords." },
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

/**
 * Keyword alerts, in Settings > Notifications: words or phrases that ping you like an @mention
 * when someone else writes them.
 */
export function KeywordAlertsSection() {
  const settings = useNotificationSettings();
  const keywords = settings.keywords ?? [];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      setNotificationSettings(await api<NotificationSettings>("/api/notification-settings", { method: "PUT", body: { keywords: next } }));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const word = draft.trim().replace(/\s+/g, " ");
    if (!word) return;
    if (keywords.some((k) => k.toLowerCase() === word.toLowerCase())) return setDraft("");
    if (await save([...keywords, word])) setDraft("");
  };

  return (
    <section className="keyword-alerts">
      <h3>Keyword alerts</h3>
      <p className="muted small">
        Get pinged when someone writes one of these words, like a name or "game night", even without an @mention. They count as a mention everywhere you
        haven't muted. Matches whole words and ignores capitals. In end-to-end encrypted chats only your app can read the messages, so those alerts show
        in the app but can't wake your phone.
      </p>
      {keywords.length > 0 && (
        <ul className="keyword-list">
          {keywords.map((k) => (
            <li key={k}>
              <span>{k}</span>
              <button className="ghost icon small" disabled={busy} aria-label={`Remove ${k}`} title="Remove" onClick={() => void save(keywords.filter((x) => x !== k))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a word or phrase" maxLength={LIMITS.keywordLength} disabled={busy || keywords.length >= LIMITS.keywordAlerts} aria-label="New keyword" />
        <button type="submit" disabled={busy || !draft.trim() || keywords.length >= LIMITS.keywordAlerts}>
          Add
        </button>
      </form>
      {keywords.length >= LIMITS.keywordAlerts && <p className="muted small">That's the most you can have ({LIMITS.keywordAlerts}). Remove one to add another.</p>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
