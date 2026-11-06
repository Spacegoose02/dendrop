import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { LIMITS, type Conversation, type Me, type Message } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { conversationTitle, type History } from "./util.ts";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

/** Messages from the same person within 5 minutes share one header. */
const continues = (prev: Message | undefined, m: Message) =>
  !!prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && day(prev.createdAt) === day(m.createdAt);

export function Chat({
  me,
  conversation,
  online,
  history,
  setHistory,
  typingIds,
  sendTyping,
  onBack,
}: {
  me: Me;
  conversation: Conversation;
  online: Set<number>;
  history: History | undefined;
  setHistory: (fn: (h: History | undefined) => History) => void;
  typingIds: number[];
  sendTyping: () => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastTypingSent = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const members = new Map(conversation.members.map((m) => [m.id, m]));
  const others = conversation.members.filter((m) => m.id !== me.id);
  const title = conversationTitle(conversation, me.id);

  // First load of this conversation.
  useEffect(() => {
    if (history) return;
    api<Message[]>(`/api/conversations/${conversation.id}/messages`)
      .then((messages) => setHistory(() => ({ messages, hasMore: messages.length >= LIMITS.pageSize })))
      .catch((err: Error) => setError(err.message));
  }, [conversation.id, history, setHistory]);

  useEffect(() => inputRef.current?.focus(), [conversation.id]);

  // Keep the view at the newest message unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [history?.messages.length, typingIds.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && history?.hasMore && !loadingOlder) void loadOlder();
  };

  const loadOlder = async () => {
    const first = history?.messages[0];
    const el = listRef.current;
    if (!first || !el) return;
    setLoadingOlder(true);
    const before = el.scrollHeight;
    try {
      const older = await api<Message[]>(`/api/conversations/${conversation.id}/messages?before=${first.id}`);
      setHistory((h) => ({ messages: [...older, ...(h?.messages ?? [])], hasMore: older.length >= LIMITS.pageSize }));
      requestAnimationFrame(() => {
        el.scrollTop += el.scrollHeight - before;
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    setError(null);
    stickToBottom.current = true;
    try {
      const m = await api<Message>(`/api/conversations/${conversation.id}/messages`, { body: { body } });
      setHistory((h) => (h && !h.messages.some((x) => x.id === m.id) ? { ...h, messages: [...h.messages, m] } : (h ?? { messages: [m], hasMore: false })));
    } catch (err) {
      setDraft(body);
      setError((err as Error).message);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "ArrowUp" && !draft) {
      const mine = [...(history?.messages ?? [])].reverse().find((m) => m.authorId === me.id && !m.deleted);
      if (mine) {
        e.preventDefault();
        setEditing({ id: mine.id, text: mine.body });
      }
    }
  };

  const onDraft = (text: string) => {
    setDraft(text);
    if (text && Date.now() - lastTypingSent.current > 3000) {
      lastTypingSent.current = Date.now();
      sendTyping();
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    const original = history?.messages.find((m) => m.id === editing.id);
    setEditing(null);
    if (!text || text === original?.body) return;
    try {
      await api<Message>(`/api/messages/${editing.id}`, { method: "PATCH", body: { body: text } });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (m: Message) => {
    if (!confirm("Delete this message? It can't be brought back.")) return;
    try {
      await api<Message>(`/api/messages/${m.id}`, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const typingNames = typingIds.filter((id) => id !== me.id).map((id) => members.get(id)?.displayName ?? "Someone");
  const messages = history?.messages ?? [];

  return (
    <section className="pane chat">
      <header className="pane-header">
        <button className="ghost back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        {!conversation.isGroup && others[0] ? (
          <Avatar name={others[0].displayName} online={online.has(others[0].id)} size={28} />
        ) : (
          <Avatar name={title} size={28} />
        )}
        <h2 className="ellipsis">{title}</h2>
        {conversation.isGroup && <span className="muted small">{conversation.members.length} members</span>}
      </header>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {!history && <p className="muted center-text">Loading…</p>}
        {history && !history.hasMore && (
          <div className="chat-start">
            <h3>{title}</h3>
            <p className="muted">This is the start of your conversation. Only the people in it can read it.</p>
          </div>
        )}
        {loadingOlder && <p className="muted center-text small">Loading older messages…</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || day(prev.createdAt) !== day(m.createdAt);
          const grouped = !newDay && continues(prev, m);
          const author = members.get(m.authorId);
          const mine = m.authorId === me.id;
          return (
            <div key={m.id}>
              {newDay && <div className="day-sep">{day(m.createdAt)}</div>}
              <div className={`msg ${grouped ? "grouped" : ""}`} tabIndex={mine && !m.deleted ? 0 : undefined}>
                {grouped ? (
                  <span className="msg-time-gutter">{time(m.createdAt)}</span>
                ) : (
                  <Avatar name={author?.displayName ?? "?"} size={36} />
                )}
                <div className="msg-content">
                  {!grouped && (
                    <div className="msg-head">
                      <strong>{author?.displayName ?? "Someone who left"}</strong>
                      <span className="muted small">{time(m.createdAt)}</span>
                    </div>
                  )}
                  {editing?.id === m.id ? (
                    <div className="edit">
                      <textarea
                        autoFocus
                        value={editing.text}
                        maxLength={LIMITS.messageLength}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void saveEdit();
                          } else if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      <span className="muted small">Enter to save · Esc to cancel</span>
                    </div>
                  ) : m.deleted ? (
                    <p className="msg-body deleted">Message deleted</p>
                  ) : (
                    <p className="msg-body">
                      {m.body}
                      {m.editedAt && <span className="muted small"> (edited)</span>}
                    </p>
                  )}
                </div>
                {mine && !m.deleted && editing?.id !== m.id && (
                  <div className="msg-actions">
                    <button className="ghost" onClick={() => setEditing({ id: m.id, text: m.body })} title="Edit">
                      Edit
                    </button>
                    <button className="ghost danger" onClick={() => void remove(m)} title="Delete">
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="composer">
        {error && <p className="error small">{error}</p>}
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={LIMITS.messageLength}
          placeholder={`Message ${title}`}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="typing small muted" aria-live="polite">
          {typingNames.length === 1 && `${typingNames[0]} is typing…`}
          {typingNames.length > 1 && `${typingNames.join(", ")} are typing…`}
        </div>
      </footer>
    </section>
  );
}
