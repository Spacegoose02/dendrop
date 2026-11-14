import { useEffect, useState, useSyncExternalStore } from "react";
import { maskBlockedWords, type ChatServer, type Conversation, type MessageInPlace, type MessagePlace } from "@dendrop/shared";
import { api, ApiError } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { decryptFile, reveal, type ChatMessage } from "./e2ee.ts";
import { Markdown } from "./markdown.tsx";
import { Modal } from "./Modal.tsx";
import { postMessage } from "./send.ts";
import { conversationTitle } from "./util.ts";

// ---- Saved messages: which ones you saved, shared by every part of the app --------------------

let savedIds = new Set<number>();
let savedLoaded = false;
const savedListeners = new Set<() => void>();
const emitSaved = () => savedListeners.forEach((fn) => fn());

/** Records a save or unsave (from this device or, through the gateway, another one). */
export function setSaved(messageId: number, saved: boolean): void {
  if (savedIds.has(messageId) === saved) return;
  savedIds = new Set(savedIds);
  if (saved) savedIds.add(messageId);
  else savedIds.delete(messageId);
  emitSaved();
}

function loadSaved(): void {
  if (savedLoaded) return;
  savedLoaded = true;
  void api<MessageInPlace[]>("/api/saved").then(
    (list) => {
      savedIds = new Set(list.map((x) => x.message.id));
      emitSaved();
    },
    () => {
      savedLoaded = false;
    },
  );
}

export function useSavedIds(): Set<number> {
  useEffect(loadSaved, []);
  return useSyncExternalStore(
    (fn) => {
      savedListeners.add(fn);
      return () => savedListeners.delete(fn);
    },
    () => savedIds,
  );
}

/** Saves or unsaves a message. Throws with the server's reason (such as a full list). */
export async function toggleSaved(messageId: number): Promise<boolean> {
  const saved = !savedIds.has(messageId);
  await api(`/api/saved/${messageId}`, { method: saved ? "PUT" : "DELETE" });
  setSaved(messageId, saved);
  return saved;
}

// ---- The inbox: messages that pinged you, and your saved ones -----------------------------------

export type InboxTab = "mentions" | "saved";

/** Somewhere to jump to: the chat a message is in, and the message. */
export interface MessageTarget {
  conversationId: number;
  messageId: number;
  serverId: number | null;
  channelId: number | null;
  threadId: number | null;
}

export function placeLabel(p: MessagePlace): string {
  if (p.kind === "thread") return `${p.serverName} › ${p.name}`;
  if (p.kind === "channel") return `${p.serverName} › #${p.name}`;
  return p.name;
}

type Row = { item: MessageInPlace; shown: ChatMessage };

export function InboxPanel({
  me,
  tab: initialTab,
  conversations,
  servers,
  filter,
  onOpen,
  onClose,
}: {
  me: { id: number };
  tab: InboxTab;
  conversations: Conversation[];
  servers: ChatServer[];
  filter: string[] | null;
  onOpen: (t: MessageTarget) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<InboxTab>(initialTab);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useSavedIds();

  const show = (list: MessageInPlace[]) => Promise.all(list.map(async (item) => ({ item, shown: await reveal(item.message) })));

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    void api<MessageInPlace[]>(tab === "saved" ? "/api/saved" : "/api/mentions")
      .then(show)
      .then(
        (r) => {
          if (!live) return;
          setRows(r);
          setMore(tab === "mentions" && r.length >= 30);
        },
        (e: Error) => live && setError(e.message),
      );
    return () => {
      live = false;
    };
  }, [tab]);

  const older = async () => {
    const last = rows?.at(-1);
    if (!last) return;
    setBusy(true);
    try {
      const r = await show(await api<MessageInPlace[]>(`/api/mentions?before=${last.item.message.id}`));
      setRows((cur) => [...(cur ?? []), ...r]);
      setMore(r.length >= 30);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unsave = async (id: number) => {
    try {
      await toggleSaved(id);
      setRows((cur) => cur?.filter((r) => r.item.message.id !== id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const nameOf = (id: number) =>
    conversations.flatMap((c) => c.members).find((u) => u.id === id)?.displayName ??
    servers.flatMap((s) => s.members).find((m) => m.user.id === id)?.user.displayName;
  const mask = (s: string) => (filter ? maskBlockedWords(s, filter) : s);

  return (
    <Modal title="Inbox" onClose={onClose} wide>
      <div className="search-panel">
        <div className="chips" role="tablist">
          <button role="tab" aria-selected={tab === "mentions"} className={`chip ${tab === "mentions" ? "on" : ""}`} onClick={() => setTab("mentions")}>
            @ Mentions
          </button>
          <button role="tab" aria-selected={tab === "saved"} className={`chip ${tab === "saved" ? "on" : ""}`} onClick={() => setTab("saved")}>
            🔖 Saved
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
        <div className="search-results">
          {rows === null && !error && <p className="muted small center-text">Loading…</p>}
          {rows?.length === 0 && (
            <p className="muted center-text">
              {tab === "saved" ? "Nothing saved yet. Hover a message and pick 🔖 to keep it here." : "Nobody has pinged you yet. When someone @mentions you, replies to you or uses @everyone, it shows up here."}
            </p>
          )}
          {rows?.map(({ item, shown: m }) => {
            const name = m.webhook?.name ?? item.author?.displayName ?? "Someone";
            const target = { conversationId: item.place.conversationId, messageId: m.id, serverId: item.place.serverId, channelId: item.place.channelId, threadId: item.place.threadId };
            return (
              <div key={m.id} className="inbox-row">
                <button className="search-hit" onClick={() => onOpen(target)}>
                  <Avatar name={name} src={item.author?.avatar} size={32} />
                  <span className="search-hit-body">
                    <span className="search-hit-head">
                      <strong>{name}</strong>
                      <span className="muted small ellipsis">
                        {placeLabel(item.place)} · {new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </span>
                    <span className="search-hit-text">
                      {m.locked ? (
                        <span className="muted">🔒 {m.locked}</span>
                      ) : m.text ? (
                        <Markdown text={mask(m.text)} inline nameOf={nameOf} meId={me.id} />
                      ) : (
                        <span className="muted">{m.attachments.length ? `📎 ${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}` : "(no text)"}</span>
                      )}
                    </span>
                  </span>
                </button>
                {tab === "saved" && saved.has(m.id) && (
                  <button className="ghost small" onClick={() => void unsave(m.id)} title="Remove from saved" aria-label="Remove from saved">
                    Unsave
                  </button>
                )}
              </div>
            );
          })}
          {more && (
            <button className="ghost center-text" disabled={busy} onClick={() => void older()}>
              {busy ? "Loading…" : "Show older"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---- Forwarding -------------------------------------------------------------------------------

let forwarding: ChatMessage | null = null;
const forwardListeners = new Set<() => void>();
/** Opens the forward dialog for a message (the app shell shows it). null closes it. */
export function startForward(m: ChatMessage | null): void {
  forwarding = m;
  forwardListeners.forEach((fn) => fn());
}
export function useForwarding(): ChatMessage | null {
  return useSyncExternalStore(
    (fn) => {
      forwardListeners.add(fn);
      return () => forwardListeners.delete(fn);
    },
    () => forwarding,
  );
}

interface Destination {
  key: string;
  conversationId: number;
  label: string;
  detail: string;
  /** Server channels and threads aren't end-to-end encrypted. */
  plain: boolean;
}

/** A message's files as plain File objects, decrypted when the chat is encrypted. */
async function filesOf(m: ChatMessage): Promise<File[]> {
  return Promise.all(
    m.attachments.map(async (a, i) => {
      const meta = m.files?.[i];
      if (m.keyVersion && meta) return new File([await decryptFile(m, a, meta)], meta.n, { type: meta.ty });
      const res = await fetch(a.url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Couldn't download ${a.name} (${res.status})`);
      return new File([await res.blob()], a.name, { type: a.contentType });
    }),
  );
}

/**
 * Picks a chat to pass a message on to. The words and files are re-sent from this device (so an
 * encrypted message stays encrypted in an encrypted chat); the server notes who wrote it first.
 */
export function ForwardDialog({
  me,
  message,
  conversations,
  servers,
  onDone,
  onClose,
}: {
  me: { id: number };
  message: ChatMessage;
  conversations: Conversation[];
  servers: ChatServer[];
  onDone: (where: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all: Destination[] = [
    ...conversations.map((c) => ({
      key: `c${c.id}`,
      conversationId: c.id,
      label: conversationTitle(c, me.id),
      detail: c.isGroup ? `Group · ${c.members.length} members` : c.isNotes ? "Just you" : "Direct message",
      plain: false,
    })),
    ...servers.flatMap((sv) =>
      sv.channels
        .filter((ch) => ch.kind === "text" && ch.canPost !== false)
        .map((ch) => ({ key: `s${ch.id}`, conversationId: ch.conversationId, label: `#${ch.name}`, detail: sv.name, plain: true })),
    ),
  ];
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((d) => `${d.label} ${d.detail}`.toLowerCase().includes(needle)) : all;

  const send = async (d: Destination) => {
    setBusy(d.key);
    setError(null);
    try {
      const files = await filesOf(message);
      const go = async () => postMessage(await api<Conversation>(`/api/conversations/${d.conversationId}`), me.id, d.plain, message.text, files, { forwardOf: message.id });
      try {
        await go();
      } catch (err) {
        // A key can change under us (someone reset theirs): one more try with a fresh view.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        await go();
      }
      onDone(d.plain ? `${d.label} in ${d.detail}` : d.label);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Forward message" onClose={onClose}>
      <div className="forward-panel">
        <blockquote className="forward-preview">{message.text || (message.attachments.length ? `📎 ${message.attachments.length} file${message.attachments.length > 1 ? "s" : ""}` : "")}</blockquote>
        <input autoFocus placeholder="Find a chat or channel" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a chat or channel" />
        {error && <p className="error small">{error}</p>}
        <div className="forward-list">
          {shown.length === 0 && <p className="muted small center-text">No chats match.</p>}
          {shown.map((d) => (
            <div key={d.key} className="forward-row">
              <span className="nav-text">
                <span className="ellipsis">{d.label}</span>
                <span className="muted small ellipsis">{d.detail}</span>
              </span>
              <button className="primary small" disabled={busy !== null} onClick={() => void send(d)}>
                {busy === d.key ? "Sending…" : "Send"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
