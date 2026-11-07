import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { INLINE_IMAGE_TYPES, LIMITS, type Attachment, type Call, type Conversation, type Me, type Message } from "@dendrop/shared";
import { api, apiForm, ApiError } from "./api.ts";
import { EMOJI } from "./emoji.ts";
import { Avatar } from "./Avatar.tsx";
import { decryptFile, encryptFile, encryptMessage, keyring, reveal, type ChatMessage, type FileMeta } from "./e2ee.ts";
import { EncryptionInfo } from "./EncryptionInfo.tsx";
import { conversationTitle, upsert, type History } from "./util.ts";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

/** Messages from the same person within 5 minutes share one header. */
const continues = (prev: ChatMessage | undefined, m: ChatMessage) =>
  !!prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && day(prev.createdAt) === day(m.createdAt);

/** What Chat needs to know when it shows a server channel instead of a DM. */
export interface ChannelInfo {
  serverId: number;
  topic: string;
  /** The owner and admins can delete anyone's message. */
  canModerate: boolean;
  /** Set for a voice channel: its text chat shows here, with a button to drop into the voice. */
  voice?: { count: number; inIt: boolean; enabled: boolean; onJoin: () => void };
}

export function Chat({
  me,
  conversation,
  online,
  history,
  setHistory,
  typingIds,
  sendTyping,
  onBack,
  callsEnabled,
  call,
  inThisCall,
  onCall,
  keyState,
  onEncryption,
  channel,
}: {
  me: Me;
  conversation: Conversation;
  online: Set<number>;
  history: History | undefined;
  setHistory: (fn: (h: History | undefined) => History) => void;
  typingIds: number[];
  sendTyping: () => void;
  onBack: () => void;
  callsEnabled: boolean;
  call: Call | undefined;
  inThisCall: boolean;
  onCall: (video: boolean) => void;
  keyState: "loading" | "off" | "locked" | "on";
  onEncryption: () => void;
  /** Set for a server channel: plain messages (no end-to-end keys), a topic, and moderators. */
  channel?: ChannelInfo;
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
  const [showInfo, setShowInfo] = useState(false);

  const members = new Map(conversation.members.map((m) => [m.id, m]));
  const others = conversation.members.filter((m) => m.id !== me.id);
  const title = conversationTitle(conversation, me.id);

  // First load of this conversation.
  useEffect(() => {
    if (history) return;
    api<Message[]>(`/api/conversations/${conversation.id}/messages`)
      .then(async (raw) => {
        const messages = await Promise.all(raw.map(reveal));
        setHistory(() => ({ messages, hasMore: raw.length >= LIMITS.pageSize }));
      })
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
      const raw = await api<Message[]>(`/api/conversations/${conversation.id}/messages?before=${first.id}`);
      const older = await Promise.all(raw.map(reveal));
      setHistory((h) => ({ messages: [...older, ...(h?.messages ?? [])], hasMore: raw.length >= LIMITS.pageSize }));
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
      // A key can change under us (someone reset theirs), so try once more with a fresh view.
      let m: Message;
      try {
        m = await post(conversation, body, sendingFiles);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        m = await post(await api<Conversation>(`/api/conversations/${conversation.id}`), body, sendingFiles);
      }
      const shown = await reveal(m);
      setHistory((h) => (h ? { ...h, messages: upsert(h.messages, shown) } : { messages: [shown], hasMore: false }));
    } catch (err) {
      setDraft(body);
      setFiles(sendingFiles);
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  /** Sends a message: encrypted once the conversation has a key, plain until everyone has set up. */
  const post = async (c: Conversation, body: string, sendingFiles: File[]): Promise<Message> => {
    const url = `/api/conversations/${c.id}/messages`;
    // Server channels aren't end-to-end encrypted yet, so they never make keys.
    const version = channel ? null : await keyring.forSending(c);
    if (version) {
      const encrypted = await Promise.all(sendingFiles.map((f) => encryptFile(c.id, version, f)));
      const cipher = await encryptMessage(c.id, me.id, version, body, encrypted.map((x) => x.meta));
      if (encrypted.length === 0) return api<Message>(url, { body: { body: cipher, keyVersion: version } });
      const form = new FormData();
      form.append("body", cipher);
      form.append("keyVersion", String(version));
      for (const x of encrypted) form.append("file", x.blob, "file");
      return apiForm<Message>(url, form);
    }
    if (sendingFiles.length === 0) return api<Message>(url, { body: { body } });
    const form = new FormData();
    form.append("body", body);
    for (const f of sendingFiles) form.append("file", f, f.name);
    return apiForm<Message>(url, form);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "ArrowUp" && !draft) {
      const mine = [...(history?.messages ?? [])].reverse().find((m) => m.authorId === me.id && !m.deleted && !m.locked);
      if (mine) {
        e.preventDefault();
        setEditing({ id: mine.id, text: mine.text });
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
    if (!text || !original || text === original.text) return;
    try {
      const edit = async (c: Conversation) => {
        const version = channel ? null : await keyring.forSending(c);
        const body = version ? await encryptMessage(c.id, me.id, version, text, original.files ?? []) : text;
        return api<Message>(`/api/messages/${original.id}`, { method: "PATCH", body: { body, keyVersion: version } });
      };
      try {
        await edit(conversation);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        await edit(await api<Conversation>(`/api/conversations/${conversation.id}`));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (m: ChatMessage) => {
    if (!confirm("Delete this message? It can't be brought back.")) return;
    try {
      // Moderators remove other people's channel messages through the server's own route.
      const url = channel && m.authorId !== me.id ? `/api/servers/${channel.serverId}/messages/${m.id}` : `/api/messages/${m.id}`;
      await api<Message>(url, { method: "DELETE" });
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
        {channel ? (
          <span className="channel-hash" aria-hidden>
            {channel.voice ? "🔊" : "#"}
          </span>
        ) : !conversation.isGroup && others[0] ? (
          <Avatar name={others[0].displayName} online={online.has(others[0].id)} size={28} />
        ) : (
          <Avatar name={title} size={28} />
        )}
        <h2 className="ellipsis">{title}</h2>
        {conversation.e2ee && (
          <button className="ghost lock-badge" onClick={() => setShowInfo(true)} title="End-to-end encrypted. Click to check security codes.">
            🔒
          </button>
        )}
        {channel ? (
          channel.topic && <span className="muted small ellipsis channel-topic">{channel.topic}</span>
        ) : (
          conversation.isGroup && <span className="muted small">{conversation.members.length} members</span>
        )}
        {channel?.voice?.enabled && !channel.voice.inIt && (
          <span className="header-actions">
            <button className="accept small-button" onClick={channel.voice.onJoin}>
              {channel.voice.count > 0 ? `Join voice (${channel.voice.count})` : "Join voice"}
            </button>
          </span>
        )}
        {callsEnabled && !inThisCall && (
          <span className="header-actions">
            {call && call.joined.length > 0 ? (
              <button className="accept small-button" onClick={() => onCall(false)}>
                Join call ({call.joined.length})
              </button>
            ) : (
              <>
                <button className="ghost icon" onClick={() => onCall(false)} title="Voice call" aria-label="Voice call">
                  📞
                </button>
                <button className="ghost icon" onClick={() => onCall(true)} title="Video call" aria-label="Video call">
                  🎥
                </button>
              </>
            )}
          </span>
        )}
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
            {channel ? (
              <p className="muted">
                This is the start of {title}. Everyone who can see this channel can read it. Server channels aren't end-to-end encrypted.
              </p>
            ) : (
              <p className="muted">
                This is the start of your conversation.{" "}
                {conversation.e2ee ? "New messages are end-to-end encrypted: only the people in it can read them." : "Only the people in it can see it."}
              </p>
            )}
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
              <div className={`msg ${grouped ? "grouped" : ""}`} tabIndex={(mine || channel?.canModerate) && !m.deleted ? 0 : undefined}>
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
                  ) : m.locked ? (
                    <p className="msg-body deleted">🔒 {m.locked}</p>
                  ) : (
                    <>
                      {m.text && (
                        <p className="msg-body">
                          {m.text}
                          {m.editedAt && <span className="muted small"> (edited)</span>}
                        </p>
                      )}
                      {m.attachments.length > 0 && (
                        <div className="attachments">
                          {m.attachments.map((a, j) =>
                            m.keyVersion ? (
                              <EncryptedAttachment key={a.id} m={m} a={a} meta={m.files?.[j]} />
                            ) : (
                              <AttachmentView key={a.id} a={a} />
                            ),
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {m.id === myLast?.id && seenBy.length > 0 && (
                    <div className="seen small muted">{conversation.isGroup ? `Seen by ${seenBy.join(", ")}` : "Seen"}</div>
                  )}
                </div>
                {(mine || channel?.canModerate) && !m.deleted && editing?.id !== m.id && (
                  <div className="msg-actions">
                    {mine && !m.locked && (
                      <button className="ghost" onClick={() => setEditing({ id: m.id, text: m.text })} title="Edit">
                        Edit
                      </button>
                    )}
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
        {!channel && <EncryptionBanner me={me} conversation={conversation} keyState={keyState} onEncryption={onEncryption} />}
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
      {showInfo && <EncryptionInfo me={me} conversation={conversation} onClose={() => setShowInfo(false)} />}
    </section>
  );
}

/** Says when a conversation isn't encrypted yet, and why. */
function EncryptionBanner({
  me,
  conversation,
  keyState,
  onEncryption,
}: {
  me: Me;
  conversation: Conversation;
  keyState: "loading" | "off" | "locked" | "on";
  onEncryption: () => void;
}) {
  if (keyState === "loading") return null;
  if (keyState === "off" || keyState === "locked") {
    return (
      <p className="e2ee-banner">
        {keyState === "off" ? "Turn on encryption so this conversation is private, even from the server." : "Unlock encryption on this device to read and send encrypted messages."}{" "}
        <button className="link" onClick={onEncryption}>
          {keyState === "off" ? "Set it up" : "Unlock"}
        </button>
      </p>
    );
  }
  if (conversation.e2ee) return null;
  const waiting = conversation.members.filter((m) => m.id !== me.id && !m.publicKey).map((m) => m.displayName);
  if (waiting.length === 0) return null;
  return (
    <p className="e2ee-banner">
      Not end-to-end encrypted yet: waiting for {waiting.join(", ")} to turn on encryption. Messages switch over by themselves once they do.
    </p>
  );
}

/** An encrypted file: pictures are decrypted and shown, other files decrypt when downloaded. */
function EncryptedAttachment({ m, a, meta }: { m: ChatMessage; a: Attachment; meta: FileMeta | undefined }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = !!meta && INLINE_IMAGE_TYPES.includes(meta.ty);

  useEffect(() => {
    if (!meta || !isImage) return;
    let made: string | null = null;
    let cancelled = false;
    decryptFile(m, a, meta)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [m, a, meta, isImage]);

  const download = async () => {
    if (!meta) return;
    try {
      const href = URL.createObjectURL(await decryptFile(m, a, meta));
      const link = document.createElement("a");
      link.href = href;
      link.download = meta.n;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
      setFailed(true);
    }
  };

  if (!meta || failed) return <span className="attachment-file muted">🔒 A file that couldn't be decrypted</span>;
  if (isImage) {
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" className="attachment-image">
        <img src={url} alt={meta.n} />
      </a>
    ) : (
      <span className="attachment-file muted">Decrypting {meta.n}…</span>
    );
  }
  return (
    <button className="attachment-file" onClick={() => void download()}>
      <span className="file-icon" aria-hidden>
        📄
      </span>
      <span className="ellipsis">{meta.n}</span>
      <span className="muted small">{bytes(meta.s)}</span>
    </button>
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
