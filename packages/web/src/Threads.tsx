import { useEffect, useState } from "react";
import { LIMITS, type Channel, type ChatServer, type Me, type PinnedMessage, type Thread } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { RichText } from "./expressions.tsx";
import { Modal } from "./Modal.tsx";
import { can } from "./roles.ts";

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

const nameIn = (server: ChatServer, userId: number | null) => {
  const m = server.members.find((x) => x.user.id === userId);
  return m ? (m.nickname ?? m.user.displayName) : "Someone who left";
};

/** Whether you can rename, close or retag a thread: whoever started it, and people who can manage channels. */
export const canEditThread = (server: ChatServer, me: Me, t: Thread) => t.createdBy === me.id || can(server, "manageChannels");

/**
 * A forum channel: its posts, newest activity first, with tag filters and a form for a new post.
 * `threads` is the live list Shell keeps from the gateway; this loads the channel's posts into it.
 */
export function ForumView({
  server,
  channel,
  threads,
  onLoaded,
  onOpen,
  onBack,
  canPost,
  onPins,
}: {
  server: ChatServer;
  channel: Channel;
  threads: Thread[];
  onLoaded: (list: Thread[]) => void;
  onOpen: (t: Thread) => void;
  onBack: () => void;
  /** Null when you can post, else why not (timed out, chat time over). */
  canPost: string | null;
  onPins: () => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api<Thread[]>(`/api/servers/${server.id}/channels/${channel.id}/threads?closed=true`)
      .then(onLoaded)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
    // onLoaded is a fresh function each render; load once per channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, channel.id]);

  const shown = threads
    .filter((t) => t.channelId === channel.id && (showClosed || !t.closed) && (!tag || t.tags.includes(tag)))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));

  return (
    <section className="pane forum">
      <header className="pane-header">
        <button className="ghost back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <span className="channel-hash" aria-hidden>
          💬
        </span>
        <h2 className="ellipsis">{channel.name}</h2>
        {channel.topic && <span className="muted small ellipsis channel-topic">{channel.topic}</span>}
        <span className="header-actions">
          <button className="ghost icon" onClick={onPins} title="Pinned messages" aria-label="Pinned messages">
            📌
          </button>
          <button className="primary small-button" onClick={() => setComposing(true)} disabled={!!canPost} title={canPost ?? undefined}>
            New post
          </button>
        </span>
      </header>
      <div className="forum-body">
        <div className="forum-filters">
          {channel.tags.length > 0 && (
            <div className="chips" role="group" aria-label="Filter by tag">
              <button className={`chip ${tag === null ? "on" : ""}`} aria-pressed={tag === null} onClick={() => setTag(null)}>
                All
              </button>
              {channel.tags.map((t) => (
                <button key={t} className={`chip ${tag === t ? "on" : ""}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <label className="toggle inline small">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            <span>Show closed posts</span>
          </label>
        </div>
        {error && <p className="error small">{error}</p>}
        {loading && <p className="muted center-text">Loading…</p>}
        {!loading && shown.length === 0 && (
          <div className="empty muted">
            {threads.some((t) => t.channelId === channel.id) ? "No posts match." : "No posts yet. Start the first one!"}
          </div>
        )}
        <ul className="forum-posts">
          {shown.map((t) => (
            <li key={t.id}>
              <button className={`forum-post ${t.closed ? "closed" : ""}`} onClick={() => onOpen(t)}>
                <span className="forum-post-title">
                  {t.closed && (
                    <span aria-label="Closed" title="Closed">
                      🔒{" "}
                    </span>
                  )}
                  <strong className="ellipsis">{t.title}</strong>
                </span>
                {t.tags.length > 0 && (
                  <span className="forum-tags">
                    {t.tags.map((x) => (
                      <span key={x} className="tag-pill small">
                        {x}
                      </span>
                    ))}
                  </span>
                )}
                {t.preview && (
                  <span className="forum-preview muted small">
                    <RichText inline text={t.preview} />
                  </span>
                )}
                <span className="forum-meta muted small">
                  <Avatar name={nameIn(server, t.createdBy)} size={18} />
                  {nameIn(server, t.createdBy)} · 💬 {Math.max(0, t.messageCount - 1)} · {when(t.lastMessageAt ?? t.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {composing && (
        <NewPost
          server={server}
          channel={channel}
          onClose={() => setComposing(false)}
          onPosted={(t) => {
            setComposing(false);
            onLoaded([t]);
            onOpen(t);
          }}
        />
      )}
    </section>
  );
}

function NewPost({ server, channel, onClose, onPosted }: { server: ChatServer; channel: Channel; onClose: () => void; onPosted: (t: Thread) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onPosted(await api<Thread>(`/api/servers/${server.id}/channels/${channel.id}/threads`, { body: { title, body, tags } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`New post in ${channel.name}`} onClose={onClose}>
      {channel.topic && <p className="muted small">{channel.topic}</p>}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.threadTitle} autoFocus />
      </label>
      <label>
        Message
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={LIMITS.messageLength} />
      </label>
      {channel.tags.length > 0 && (
        <>
          <div className="section-label">Tags · up to {LIMITS.tagsPerPost}</div>
          <div className="chips">
            {channel.tags.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${tags.includes(t) ? "on" : ""}`}
                aria-pressed={tags.includes(t)}
                disabled={!tags.includes(t) && tags.length >= LIMITS.tagsPerPost}
                onClick={() => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={busy || !title.trim() || !body.trim()} onClick={() => void submit()}>
        {busy ? "Posting…" : "Post"}
      </button>
    </Modal>
  );
}

/** The header buttons on an open thread: rename, close or reopen, retag, delete. */
export function ThreadActions({ server, me, thread, channel, onDeleted }: { server: ChatServer; me: Me; thread: Thread; channel: Channel; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const mod = can(server, "manageChannels");
  const canDelete = mod || can(server, "deleteMessages");
  const patch = async (body: object) => {
    try {
      await api(`/api/threads/${thread.id}`, { method: "PATCH", body });
    } catch (err) {
      alert((err as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete "${thread.title}" and every message in it? This can't be undone.`)) return;
    try {
      await api(`/api/threads/${thread.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      alert((err as Error).message);
    }
  };
  if (!canEditThread(server, me, thread) && !canDelete) return null;
  return (
    <>
      {canEditThread(server, me, thread) && (
        <button className="ghost icon" onClick={() => setEditing(true)} title="Edit thread" aria-label="Edit thread">
          ✎
        </button>
      )}
      {canEditThread(server, me, thread) && (!thread.closed || mod) && (
        <button
          className="ghost icon"
          onClick={() => void patch({ closed: !thread.closed })}
          title={thread.closed ? "Reopen: let people reply again" : "Close: make it read only"}
          aria-label={thread.closed ? "Reopen thread" : "Close thread"}
        >
          {thread.closed ? "🔓" : "🔒"}
        </button>
      )}
      {canDelete && (
        <button className="ghost icon danger" onClick={() => void remove()} title="Delete thread" aria-label="Delete thread">
          🗑
        </button>
      )}
      {editing && <EditThread thread={thread} channel={channel} onClose={() => setEditing(false)} onSave={(b) => patch(b).then(() => setEditing(false))} />}
    </>
  );
}

function EditThread({ thread, channel, onClose, onSave }: { thread: Thread; channel: Channel; onClose: () => void; onSave: (b: { title: string; tags?: string[] }) => void }) {
  const [title, setTitle] = useState(thread.title);
  const [tags, setTags] = useState(thread.tags);
  const forum = channel.kind === "forum";
  return (
    <Modal title={forum ? "Edit post" : "Edit thread"} onClose={onClose}>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.threadTitle} autoFocus />
      </label>
      {forum && channel.tags.length > 0 && (
        <div className="chips">
          {channel.tags.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${tags.includes(t) ? "on" : ""}`}
              aria-pressed={tags.includes(t)}
              disabled={!tags.includes(t) && tags.length >= LIMITS.tagsPerPost}
              onClick={() => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <button className="primary wide" disabled={!title.trim()} onClick={() => onSave(forum ? { title, tags } : { title })}>
        Save
      </button>
    </Modal>
  );
}

/**
 * The pinned board: everything pinned in the server's channels and threads you can see, newest
 * first, or one channel's. `version` changes whenever a pin changes, to reload.
 */
export function PinsDialog({
  server,
  channelId,
  version,
  onJump,
  onClose,
}: {
  server: ChatServer;
  channelId: number | null;
  version: number;
  onJump: (p: PinnedMessage) => void;
  onClose: () => void;
}) {
  const [only, setOnly] = useState<number | null>(channelId);
  const [pins, setPins] = useState<PinnedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<PinnedMessage[]>(`/api/servers/${server.id}/pins${only ? `?channelId=${only}` : ""}`)
      .then(setPins)
      .catch((err: Error) => setError(err.message));
  }, [server.id, only, version]);
  const channelName = (id: number) => server.channels.find((c) => c.id === id)?.name ?? "a channel";
  const here = channelId ? server.channels.find((c) => c.id === channelId) : undefined;
  const unpin = async (p: PinnedMessage) => {
    try {
      await api(`/api/messages/${p.message.id}/pin`, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Pinned board" onClose={onClose} wide>
      {here && (
        <div className="chips" role="group" aria-label="Which pins">
          <button className={`chip ${only === null ? "on" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>
            Whole server
          </button>
          <button className={`chip ${only === here.id ? "on" : ""}`} aria-pressed={only === here.id} onClick={() => setOnly(here.id)}>
            {here.kind === "forum" ? "💬" : "#"} {here.name}
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {!pins && !error && <p className="muted">Loading…</p>}
      {pins?.length === 0 && (
        <p className="muted">
          Nothing pinned yet. {can(server, "pinMessages") ? "Hover a message and press 📌 to pin it here." : "People who can pin messages can put the important ones here."}
        </p>
      )}
      <ul className="pin-board">
        {pins?.map((p) => (
          <li key={p.message.id} className="pin-card">
            <div className="pin-where muted small">
              # {channelName(p.channelId)}
              {p.threadTitle && <> · 🧵 {p.threadTitle}</>} · pinned {when(p.pinnedAt)}
              {p.pinnedBy && ` by ${nameIn(server, p.pinnedBy)}`}
            </div>
            <div className="pin-msg">
              <Avatar name={p.message.webhook?.name ?? nameIn(server, p.message.authorId)} size={28} />
              <div>
                <strong>{p.message.webhook?.name ?? nameIn(server, p.message.authorId)}</strong> <span className="muted small">{when(p.message.createdAt)}</span>
                <p className="msg-body">
                  <RichText text={p.message.body} />
                </p>
                {p.message.attachments.length > 0 && <span className="muted small">📎 {p.message.attachments.map((a) => a.name).join(", ")}</span>}
              </div>
            </div>
            <div className="pin-actions">
              <button className="ghost small-button" onClick={() => onJump(p)}>
                Jump
              </button>
              {can(server, "pinMessages") && (
                <button className="ghost small-button" onClick={() => void unpin(p)}>
                  Unpin
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
