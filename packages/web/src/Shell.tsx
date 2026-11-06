import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, Friend, Me, Message, PublicUser, ServerEvent } from "@dendrop/shared";
import { api, connectGateway, logout } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Friends } from "./Friends.tsx";
import { Avatar } from "./Avatar.tsx";
import { conversationTitle, type History } from "./util.ts";

export type View = { kind: "friends" } | { kind: "conversation"; id: number };

/**
 * The main layout: server rail, sidebar (DMs), main pane (friends or a chat).
 * Holds the live state the gateway keeps up to date.
 */
export function Shell({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<View>({ kind: "friends" });
  /** On phones only one column shows: the DM list, or what's open. */
  const [showMain, setShowMain] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [histories, setHistories] = useState<Record<number, History>>({});
  const [typing, setTyping] = useState<Record<number, Record<number, number>>>({});
  const [unread, setUnread] = useState<Set<number>>(new Set());
  const viewRef = useRef(view);
  viewRef.current = view;

  const refresh = useCallback(async () => {
    const [f, c] = await Promise.all([api<Friend[]>("/api/friends"), api<Conversation[]>("/api/conversations")]);
    setFriends(f);
    setOnline(new Set(f.filter((x) => x.online).map((x) => x.user.id)));
    setConversations(c);
    // Anything open may have missed messages while disconnected; reload it on demand.
    setHistories({});
  }, []);

  const onEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case "ready":
          void refresh();
          break;
        case "friend.updated":
          setFriends((fs) => [...fs.filter((f) => f.user.id !== e.friend.user.id), e.friend]);
          if (e.friend.online !== undefined) {
            const { id } = e.friend.user;
            const isOn = e.friend.online;
            setOnline((s) => {
              const n = new Set(s);
              if (isOn) n.add(id);
              else n.delete(id);
              return n;
            });
          }
          break;
        case "friend.removed":
          setFriends((fs) => fs.filter((f) => f.user.id !== e.userId));
          break;
        case "presence":
          setOnline((s) => {
            const n = new Set(s);
            if (e.online) n.add(e.userId);
            else n.delete(e.userId);
            return n;
          });
          break;
        case "conversation.created":
          setConversations((cs) => [e.conversation, ...cs.filter((c) => c.id !== e.conversation.id)]);
          break;
        case "message.created": {
          const m = e.message;
          setHistories((h) => {
            const cur = h[m.conversationId];
            if (!cur || cur.messages.some((x) => x.id === m.id)) return h;
            return { ...h, [m.conversationId]: { ...cur, messages: [...cur.messages, m] } };
          });
          setConversations((cs) => {
            const c = cs.find((x) => x.id === m.conversationId);
            if (!c) {
              void api<Conversation[]>("/api/conversations").then(setConversations);
              return cs;
            }
            return [{ ...c, lastMessageAt: m.createdAt }, ...cs.filter((x) => x.id !== c.id)];
          });
          setTyping((t) => {
            const forConv = { ...(t[m.conversationId] ?? {}) };
            delete forConv[m.authorId];
            return { ...t, [m.conversationId]: forConv };
          });
          const v = viewRef.current;
          if (m.authorId !== me.id && !(v.kind === "conversation" && v.id === m.conversationId && document.hasFocus())) {
            setUnread((u) => new Set(u).add(m.conversationId));
          }
          break;
        }
        case "message.updated": {
          const m = e.message;
          setHistories((h) => {
            const cur = h[m.conversationId];
            if (!cur) return h;
            return { ...h, [m.conversationId]: { ...cur, messages: cur.messages.map((x) => (x.id === m.id ? m : x)) } };
          });
          break;
        }
        case "typing":
          setTyping((t) => ({ ...t, [e.conversationId]: { ...(t[e.conversationId] ?? {}), [e.userId]: Date.now() } }));
          break;
      }
    },
    [me.id, refresh],
  );

  const sendRef = useRef<(data: object) => void>(() => {});
  useEffect(() => {
    const gw = connectGateway(onEvent, setConnected);
    sendRef.current = gw.send;
    return gw.close;
  }, [onEvent]);

  // Typing indicators fade after a few seconds without a new ping.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 6000;
      setTyping((all) => {
        let changed = false;
        const next: typeof all = {};
        for (const [cid, users] of Object.entries(all)) {
          const fresh = Object.entries(users).filter(([, at]) => at >= cutoff);
          if (fresh.length !== Object.keys(users).length) changed = true;
          next[Number(cid)] = Object.fromEntries(fresh);
        }
        return changed ? next : all;
      });
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const open = (v: View) => {
    setView(v);
    setShowMain(true);
    if (v.kind === "conversation") {
      setUnread((u) => {
        const n = new Set(u);
        n.delete(v.id);
        return n;
      });
    }
  };

  const messageFriend = async (user: PublicUser) => {
    const c = await api<Conversation>("/api/conversations", { body: { userId: user.id } });
    setConversations((cs) => [c, ...cs.filter((x) => x.id !== c.id)]);
    open({ kind: "conversation", id: c.id });
  };

  const current = view.kind === "conversation" ? conversations.find((c) => c.id === view.id) : undefined;
  const incoming = friends.filter((f) => f.state === "incoming").length;

  return (
    <div className={`shell ${showMain ? "show-main" : ""}`}>
      <nav className="rail" aria-label="Servers">
        <button className="rail-item active" title="Direct messages" onClick={() => open({ kind: "friends" })}>
          <img src="/favicon.svg" alt="Direct messages" width={32} height={32} />
        </button>
        <div className="rail-sep" />
      </nav>

      <aside className="sidebar">
        <header className="sidebar-header">Direct messages</header>
        <div className="sidebar-body">
          <button className={`nav-item ${view.kind === "friends" ? "active" : ""}`} onClick={() => open({ kind: "friends" })}>
            <span className="nav-icon" aria-hidden>
              ☺
            </span>
            Friends
            {incoming > 0 && <span className="badge">{incoming}</span>}
          </button>
          <div className="section-label">Conversations</div>
          {conversations.length === 0 && <p className="muted small">No conversations yet.</p>}
          {conversations.map((c) => {
            const others = c.members.filter((m) => m.id !== me.id);
            const solo = !c.isGroup && others[0];
            return (
              <button
                key={c.id}
                className={`nav-item ${view.kind === "conversation" && view.id === c.id ? "active" : ""} ${unread.has(c.id) ? "unread" : ""}`}
                onClick={() => open({ kind: "conversation", id: c.id })}
              >
                <Avatar name={solo ? solo.displayName : (c.name ?? "#")} online={solo ? online.has(solo.id) : undefined} size={32} />
                <span className="nav-text">
                  <span className="ellipsis">{conversationTitle(c, me.id)}</span>
                  {c.isGroup && <span className="muted small">{c.members.length} members</span>}
                </span>
                {unread.has(c.id) && <span className="dot" aria-label="Unread" />}
              </button>
            );
          })}
        </div>
        <footer className="me">
          <Avatar name={me.displayName} online={connected} size={36} title={connected ? "Connected" : "Reconnecting…"} />
          <div className="me-names">
            <strong>{me.displayName}</strong>
            <span className="muted">@{me.username}</span>
          </div>
          <button className="ghost" onClick={() => void logout().then(onSignedOut)} title="Sign out">
            Sign out
          </button>
        </footer>
      </aside>

      <main className="main">
        {view.kind === "friends" && <Friends friends={friends} online={online} onMessage={messageFriend} onBack={() => setShowMain(false)} />}
        {view.kind === "conversation" && current && (
          <Chat
            key={current.id}
            me={me}
            conversation={current}
            online={online}
            history={histories[current.id]}
            setHistory={(h) => setHistories((all) => ({ ...all, [current.id]: h(all[current.id]) }))}
            typingIds={Object.keys(typing[current.id] ?? {}).map(Number)}
            sendTyping={() => sendRef.current({ type: "typing", conversationId: current.id })}
            onBack={() => setShowMain(false)}
          />
        )}
      </main>
    </div>
  );
}
