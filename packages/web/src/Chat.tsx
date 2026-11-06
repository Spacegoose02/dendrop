import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { INLINE_IMAGE_TYPES, LIMITS, type Attachment, type Conversation, type Me, type Message } from "@dendrop/shared";
import { api, apiForm } from "./api.ts";
import { EMOJI } from "./emoji.ts";
import { Avatar } from "./Avatar.tsx";
import { conversationTitle, type History } from "./util.ts";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [dragging, setDragging] = useState(false);
  const lastMarked = useRef(0);

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

  // Tell the server how far this person has read, whenever new messages show while the window
  // is in front.
  const newest = history?.messages.at(-1)?.id ?? 0;
  useEffect(() => {
    const mark = () => {
      if (!newest || newest <= lastMarked.current || document.visibilityState !== "visible" || !document.hasFocus()) return;
      lastMarked.current = newest;
      void api(`/api/conversations/${conversation.id}/read`, { body: { messageId: newest } }).catch(() => {
        lastMarked.current = 0;
      });
    };
    mark();
    addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [conversation.id, newest]);

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = [...list];
    setFiles((f) => [...f, ...incoming].slice(0, LIMITS.attachmentsPerMessage));
    inputRef.current?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    setShowEmoji(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

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
    if ((!body && files.length === 0) || sending) return;
    const sendingFiles = files;
    setDraft("");
    setFiles([]);
    setError(null);
    stickToBottom.current = true;
    setSending(true);
    try {
      const url = `/api/conversations/${conversation.id}/messages`;
      let m: Message;
      if (sendingFiles.length > 0) {
        const form = new FormData();
        form.append("body", body);
        for (const f of sendingFiles) form.append("file", f, f.name);
        m = await apiForm<Message>(url, form);
      } else {
        m = await api<Message>(url, { body: { body } });
      }
      setHistory((h) => (h && !h.messages.some((x) => x.id === m.id) ? { ...h, messages: [...h.messages, m] } : (h ?? { messages: [m], hasMore: false })));
    } catch (err) {
      setDraft(body);
      setFiles(sendingFiles);
      setError((err as Error).message);
    } finally {
      setSending(false);
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

  const messages = history?.messages ?? [];
  // "Seen" goes under my newest message that someone else has read.
  const myLast = [...messages].reverse().find((m) => m.authorId === me.id);
  const seenBy = myLast
    ? conversation.reads.filter((r) => r.userId !== me.id && r.messageId !== null && r.messageId >= myLast.id).map((r) => members.get(r.userId)?.displayName ?? "Someone")
    : [];
  const typingNames = typingIds.filter((id) => id !== me.id).map((id) => members.get(id)?.displayName ?? "Someone");

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

      <div
        className={`messages ${dragging ? "dragging" : ""}`}
        ref={listRef}
        onScroll={onScroll}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
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
                    <>
                      {m.body && (
                        <p className="msg-body">
                          {m.body}
                          {m.editedAt && <span className="muted small"> (edited)</span>}
                        </p>
                      )}
                      {m.attachments.length > 0 && (
                        <div className="attachments">
                          {m.attachments.map((a) => (
                            <AttachmentView key={a.id} a={a} />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {m.id === myLast?.id && seenBy.length > 0 && (
                    <div className="seen small muted">{conversation.isGroup ? `Seen by ${seenBy.join(", ")}` : "Seen"}</div>
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
        {files.length > 0 && (
          <div className="pending-files">
            {files.map((f, i) => (
              <span className="file-chip" key={`${f.name}-${i}`}>
                <span className="ellipsis">{f.name}</span>
                <span className="muted small">{bytes(f.size)}</span>
                <button className="ghost" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <button className="ghost icon" onClick={() => fileRef.current?.click()} title="Add files" aria-label="Add files">
            ＋
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={LIMITS.messageLength}
            placeholder={`Message ${title}`}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <div className="emoji-wrap">
            <button className="ghost icon" onClick={() => setShowEmoji(!showEmoji)} title="Emoji" aria-label="Emoji" aria-expanded={showEmoji}>
              🙂
            </button>
            {showEmoji && (
              <div className="emoji-picker" role="listbox" aria-label="Emoji">
                {EMOJI.map((e) => (
                  <button key={e} className="ghost" onClick={() => insertEmoji(e)} aria-label={e}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="primary send" onClick={() => void send()} disabled={sending || (!draft.trim() && files.length === 0)} aria-label="Send">
            {sending ? "…" : "Send"}
          </button>
        </div>
        <div className="typing small muted" aria-live="polite">
          {typingNames.length === 1 && `${typingNames[0]} is typing…`}
          {typingNames.length > 1 && `${typingNames.join(", ")} are typing…`}
        </div>
      </footer>
    </section>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  if (INLINE_IMAGE_TYPES.includes(a.contentType)) {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="attachment-image">
        <img src={a.url} alt={a.name} loading="lazy" />
      </a>
    );
  }
  return (
    <a href={a.url} className="attachment-file" download={a.name}>
      <span className="file-icon" aria-hidden>
        📄
      </span>
      <span className="ellipsis">{a.name}</span>
      <span className="muted small">{bytes(a.size)}</span>
    </a>
  );
}
