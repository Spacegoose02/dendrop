import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LIMITS, maskBlockedWords, type ChatServer, type Conversation, type Message, type PublicUser, type SearchHit, type SearchResults } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { reveal, type ChatMessage } from "./e2ee.ts";
import { Markdown, plainText } from "./markdown.tsx";
import { Modal } from "./Modal.tsx";
import { conversationTitle } from "./util.ts";

// ---- Opening search, and jumping to a message ------------------------------------------------

export interface SearchScope {
  conversationId?: number;
  serverId?: number;
}

type Store<T> = { value: T; listeners: Set<() => void> };
const store = <T,>(value: T): Store<T> => ({ value, listeners: new Set() });
const setStore = <T,>(s: Store<T>, v: T) => {
  s.value = v;
  for (const fn of s.listeners) fn();
};
const useStore = <T,>(s: Store<T>): T =>
  useSyncExternalStore(
    (fn) => {
      s.listeners.add(fn);
      return () => s.listeners.delete(fn);
    },
    () => s.value,
  );

const searchOpen = store<SearchScope | null>(null);
const jump = store<{ conversationId: number; messageId: number } | null>(null);

export const openSearch = (scope: SearchScope) => setStore(searchOpen, scope);
export const closeSearch = () => setStore(searchOpen, null);
export const useSearchOpen = () => useStore(searchOpen);

/** Asks the chat showing this conversation to scroll to a message (loading older pages to reach it). */
export const requestJump = (conversationId: number, messageId: number) => setStore(jump, { conversationId, messageId });
export const clearJump = () => setStore(jump, null);
export function useJumpTarget(conversationId: number): number | null {
  const j = useStore(jump);
  return j && j.conversationId === conversationId ? j.messageId : null;
}

// ---- Searching encrypted chats on this device ------------------------------------------------

/** Decrypted history fetched for searching, kept in memory only (never stored on disk). */
const local = new Map<number, { messages: ChatMessage[]; done: boolean }>();
/** How far back on-device search reads in each encrypted chat. */
const LOCAL_LIMIT = 3000;

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^"+|"+$/g, ""))
    .filter(Boolean);

async function searchOnDevice(c: Conversation, q: string, authorId: number | null, onProgress: (n: number) => void): Promise<ChatMessage[]> {
  let entry = local.get(c.id);
  if (!entry) {
    entry = { messages: [], done: false };
    local.set(c.id, entry);
  }
  while (!entry.done && entry.messages.length < LOCAL_LIMIT) {
    const before = entry.messages[0]?.id;
    const raw = await api<Message[]>(`/api/conversations/${c.id}/messages?limit=100${before ? `&before=${before}` : ""}`);
    const page = await Promise.all(raw.map(reveal));
    entry.messages = [...page, ...entry.messages];
    if (raw.length < 100) entry.done = true;
    onProgress(entry.messages.length);
  }
  const want = words(q);
  return entry.messages
    .filter((m) => !m.deleted && !m.locked && (!authorId || m.authorId === authorId))
    .filter((m) => {
      const text = plainText(m.text).toLowerCase() + " " + (m.files ?? []).map((f) => f.n.toLowerCase()).join(" ");
      return want.every((w) => text.includes(w));
    })
    .reverse();
}

// ---- The search panel ---------------------------------------------------------------------------

interface Row {
  key: string;
  message: ChatMessage;
  conversationId: number;
  serverId: number | null;
  channelId: number | null;
  threadId: number | null;
  onDevice: boolean;
}

/**
 * Search across messages. The server searches everything it can read (server channels, and DMs
 * that aren't end-to-end encrypted); encrypted chats are searched here on the device, after
 * downloading and decrypting their history, so the server never sees the words.
 */
export function SearchPanel({
  me,
  scope,
  conversations,
  servers,
  filter,
  onOpen,
  onClose,
}: {
  me: { id: number };
  scope: SearchScope;
  conversations: Conversation[];
  servers: ChatServer[];
  /** A kid's family filter: blocked words are masked in results. */
  filter: string[] | null;
  onOpen: (hit: { conversationId: number; messageId: number; serverId: number | null; channelId: number | null; threadId: number | null }) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [where, setWhere] = useState<"here" | "everywhere">(scope.conversationId || scope.serverId ? "here" : "everywhere");
  const [authorId, setAuthorId] = useState<number | null>(null);
  const [has, setHas] = useState<"" | "file" | "link" | "image">("");
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [deviceToo, setDeviceToo] = useState(false);
  const run = useRef(0);

  const here = scope.conversationId ? conversations.find((c) => c.id === scope.conversationId) : undefined;
  const hereServer = scope.serverId ? servers.find((s) => s.id === scope.serverId) : undefined;
  const hereEncrypted = !!here?.e2ee;
  const placeName = hereServer ? hereServer.name : here ? conversationTitle(here, me.id) : "";
  const encryptedChats = conversations.filter((c) => c.e2ee);

  /** Everyone you might filter by: this chat's or server's people, or all of them. */
  const people: PublicUser[] = (() => {
    const all = new Map<number, PublicUser>();
    const add = (u: PublicUser) => all.set(u.id, u);
    if (where === "here" && here) here.members.forEach(add);
    else if (where === "here" && hereServer) hereServer.members.forEach((m) => add(m.user));
    else {
      conversations.forEach((c) => c.members.forEach(add));
      servers.forEach((s) => s.members.forEach((m) => add(m.user)));
    }
    return [...all.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  })();
  const nameOf = (id: number) =>
    conversations.flatMap((c) => c.members).find((u) => u.id === id)?.displayName ??
    servers.flatMap((s) => s.members).find((m) => m.user.id === id)?.user.displayName;

  const placeOf = (r: Row): string => {
    const sv = r.serverId ? servers.find((s) => s.id === r.serverId) : undefined;
    if (sv) {
      const ch = sv.channels.find((c) => c.id === r.channelId);
      return `${sv.name} › #${ch?.name ?? "channel"}${r.threadId ? " › thread" : ""}`;
    }
    const c = conversations.find((x) => x.id === r.conversationId);
    return c ? conversationTitle(c, me.id) : "A chat";
  };

  const search = async (more = false) => {
    const text = q.trim();
    if (!text && !authorId && !has) return;
    const id = ++run.current;
    setBusy(true);
    setError(null);
    if (!more) {
      setRows([]);
      setNext(null);
    }
    try {
      const out: Row[] = [];
      // The server's part: everything it can read.
      const onlyLocal = where === "here" && hereEncrypted;
      if (!onlyLocal) {
        const params = new URLSearchParams();
        if (text) params.set("q", text);
        if (where === "here" && scope.conversationId) params.set("conversationId", String(scope.conversationId));
        if (where === "here" && scope.serverId && !scope.conversationId) params.set("serverId", String(scope.serverId));
        if (authorId) params.set("authorId", String(authorId));
        if (has) params.set("has", has);
        if (more && next) params.set("before", String(next));
        const r = await api<SearchResults>(`/api/search?${params}`);
        const shown = await Promise.all(r.hits.map(async (h: SearchHit) => ({ h, m: await reveal(h.message) })));
        for (const { h, m } of shown) out.push({ key: `s${m.id}`, message: m, conversationId: m.conversationId, serverId: h.serverId, channelId: h.channelId, threadId: h.threadId, onDevice: false });
        if (id === run.current) setNext(r.next);
      }
      // Encrypted chats: on the device (words only; files and links can't be filtered by the server).
      if (!more && text && !has) {
        const targets = where === "here" ? (hereEncrypted && here ? [here] : []) : deviceToo ? encryptedChats : [];
        for (const c of targets) {
          setProgress(`Searching ${conversationTitle(c, me.id)} on this device…`);
          const found = await searchOnDevice(c, text, authorId, (n) => id === run.current && setProgress(`Decrypting ${conversationTitle(c, me.id)} on this device… ${n} messages`));
          for (const m of found.slice(0, 100)) out.push({ key: `d${m.id}`, message: m, conversationId: c.id, serverId: null, channelId: null, threadId: null, onDevice: true });
        }
      }
      if (id !== run.current) return;
      out.sort((a, b) => b.message.id - a.message.id);
      setRows((prev) => (more ? [...prev, ...out] : out));
      setSearched(true);
    } catch (err) {
      if (id === run.current) setError((err as Error).message);
    } finally {
      if (id === run.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  // Search as you type, after a short pause.
  useEffect(() => {
    if (!q.trim() && !authorId && !has) {
      setRows([]);
      setSearched(false);
      return;
    }
    const t = setTimeout(() => void search(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, where, authorId, has, deviceToo]);

  const mask = (s: string) => (filter ? maskBlockedWords(s, filter) : s);

  return (
    <Modal title="Search messages" onClose={onClose} wide>
      <div className="search-panel">
        <input
          autoFocus
          type="search"
          className="search-input"
          value={q}
          maxLength={LIMITS.searchQuery}
          placeholder={where === "here" && placeName ? `Search ${placeName}` : "Search all your messages"}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
        />
        <div className="search-filters">
          {placeName && (
            <div className="chips" role="radiogroup" aria-label="Where">
              <button role="radio" aria-checked={where === "here"} className={`chip ${where === "here" ? "on" : ""}`} onClick={() => setWhere("here")}>
                {hereServer ? `In ${placeName}` : "This chat"}
              </button>
              <button role="radio" aria-checked={where === "everywhere"} className={`chip ${where === "everywhere" ? "on" : ""}`} onClick={() => setWhere("everywhere")}>
                Everywhere
              </button>
            </div>
          )}
          <select value={authorId ?? ""} onChange={(e) => setAuthorId(e.target.value ? Number(e.target.value) : null)} aria-label="From">
            <option value="">From anyone</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                From {u.id === me.id ? "you" : u.displayName}
              </option>
            ))}
          </select>
          <select value={has} onChange={(e) => setHas(e.target.value as typeof has)} aria-label="Has">
            <option value="">Any message</option>
            <option value="link">Has a link</option>
            <option value="file">Has a file</option>
            <option value="image">Has a picture</option>
          </select>
        </div>
        {where === "here" && hereEncrypted && (
          <p className="muted small">🔒 This chat is end-to-end encrypted, so it's searched here on this device. The server never sees what you search for.</p>
        )}
        {where === "everywhere" && encryptedChats.length > 0 && (
          <label className="check small">
            <input type="checkbox" checked={deviceToo} onChange={(e) => setDeviceToo(e.target.checked)} />
            Also search my {encryptedChats.length} encrypted chat{encryptedChats.length === 1 ? "" : "s"} on this device (slower: they're downloaded and decrypted here)
          </label>
        )}
        {error && <p className="error small">{error}</p>}
        {progress && <p className="muted small">{progress}</p>}
        <div className="search-results" aria-live="polite">
          {searched && !busy && rows.length === 0 && <p className="muted center-text">Nothing found.</p>}
          {rows.map((r) => {
            const m = r.message;
            const name = m.webhook?.name ?? nameOf(m.authorId) ?? "Someone";
            return (
              <button
                key={r.key}
                className="search-hit"
                onClick={() => onOpen({ conversationId: r.conversationId, messageId: m.id, serverId: r.serverId, channelId: r.channelId, threadId: r.threadId })}
              >
                <Avatar name={name} size={32} />
                <span className="search-hit-body">
                  <span className="search-hit-head">
                    <strong>{name}</strong>
                    <span className="muted small ellipsis">
                      {r.onDevice && "🔒 "}
                      {placeOf(r)} · {new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </span>
                  <span className="search-hit-text">
                    {m.text ? <Markdown text={mask(m.text)} inline nameOf={nameOf} meId={me.id} /> : <span className="muted">{m.attachments.length ? `📎 ${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}` : "(no text)"}</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {next && !busy && (
            <button className="ghost center-text" onClick={() => void search(true)}>
              Show older results
            </button>
          )}
          {busy && !progress && <p className="muted small center-text">Searching…</p>}
        </div>
      </div>
    </Modal>
  );
}
