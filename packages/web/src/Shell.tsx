import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Call, CallJoin, Conversation, Friend, Me, Message, PublicUser, ServerEvent, ServerInfo } from "@dendrop/shared";
import { api, connectGateway, logout } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Friends } from "./Friends.tsx";
import { Avatar } from "./Avatar.tsx";
import { IncomingCall } from "./IncomingCall.tsx";
import { NewGroup } from "./NewGroup.tsx";
import { Settings } from "./Settings.tsx";
import { conversationTitle, type History } from "./util.ts";

// The call code (LiveKit) is big, so it only loads when a call starts.
const CallPanel = lazy(() => import("./CallPanel.tsx").then((m) => ({ default: m.CallPanel })));

export type View = { kind: "friends" } | { kind: "conversation"; id: number };

/**
 * The main layout: server rail, sidebar (DMs), main pane (friends or a chat).
 * Holds the live state the gateway keeps up to date.
 */
export function Shell({ me: initialMe, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [me, setMe] = useState(initialMe);
  const [dialog, setDialog] = useState<"group" | "settings" | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [calls, setCalls] = useState<Record<number, Call>>({});
  /** The call this device is in. */
  const [inCall, setInCall] = useState<CallJoin | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
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
    const [f, c, info, live] = await Promise.all([
      api<Friend[]>("/api/friends"),
      api<Conversation[]>("/api/conversations"),
      api<ServerInfo>("/api/server"),
      api<Call[]>("/api/calls"),
    ]);
    setServer(info);
    setCalls(Object.fromEntries(live.map((x) => [x.conversationId, x])));
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
        case "read":
          setConversations((cs) =>
            cs.map((c) =>
              c.id === e.conversationId
                ? { ...c, reads: [...c.reads.filter((r) => r.userId !== e.userId), { userId: e.userId, messageId: e.messageId }] }
                : c,
            ),
          );
          break;
        case "call.updated":
          setCalls((cs) => ({ ...cs, [e.call.conversationId]: e.call }));
          break;
        case "call.ended":
          setCalls((cs) => {
            const n = { ...cs };
            delete n[e.conversationId];
            return n;
          });
          setInCall((c) => (c?.call.conversationId === e.conversationId ? null : c));
          break;
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

  const startCall = async (conversationId: number, video: boolean) => {
    if (inCall && inCall.call.conversationId !== conversationId) {
      if (!confirm("Leave your current call and join this one?")) return;
      void api(`/api/conversations/${inCall.call.conversationId}/call/leave`, { body: {} });
      setInCall(null);
    }
    setCallError(null);
    try {
      const j = await api<CallJoin>(`/api/conversations/${conversationId}/call`, { body: { video } });
      // Whoever answers with video starts with their camera on, like the caller.
      setInCall({ ...j, call: { ...j.call, video, startedBy: video ? me.id : j.call.startedBy } });
      open({ kind: "conversation", id: conversationId });
    } catch (err) {
      setCallError((err as Error).message);
    }
  };

  // Ring for a call that's ringing this person, unless they're already in one.
  const ringing = Object.values(calls).find((c) => c.ringing.includes(me.id) && c.conversationId !== inCall?.call.conversationId);

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
          <div className="section-label with-action">
            Conversations
            <button className="ghost" onClick={() => setDialog("group")} title="New group chat" aria-label="New group chat">
              ＋
            </button>
          </div>
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
          <button className="ghost" onClick={() => setDialog("settings")} title="Settings" aria-label="Settings">
            ⚙
          </button>
          <button className="ghost" onClick={() => void logout().then(onSignedOut)} title="Sign out">
            Sign out
          </button>
        </footer>
      </aside>

      <main className="main">
        {inCall && (
          <Suspense fallback={<div className="call-bar muted">Joining the call…</div>}>
          <CallPanel
            key={inCall.call.conversationId}
            me={me}
            join={inCall}
            conversation={conversations.find((c) => c.id === inCall.call.conversationId)}
            compact={!(view.kind === "conversation" && view.id === inCall.call.conversationId)}
            onOpen={() => open({ kind: "conversation", id: inCall.call.conversationId })}
            onLeft={() => setInCall(null)}
          />
          </Suspense>
        )}
        {callError && (
          <p className="error call-error" role="alert">
            {callError}{" "}
            <button className="link" onClick={() => setCallError(null)}>
              Dismiss
            </button>
          </p>
        )}
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
            callsEnabled={!!server?.calls}
            call={calls[current.id]}
            inThisCall={inCall?.call.conversationId === current.id}
            onCall={(video) => void startCall(current.id, video)}
            onBack={() => setShowMain(false)}
          />
        )}
      </main>
      {ringing && !dialog && (
        <IncomingCall
          me={me}
          call={ringing}
          conversation={conversations.find((c) => c.id === ringing.conversationId)}
          onAccept={(video) => void startCall(ringing.conversationId, video)}
          onDecline={() => {
            const cid = ringing.conversationId;
            // Hide it straight away; the server's update follows.
            setCalls((cs) => ({ ...cs, [cid]: { ...cs[cid]!, ringing: cs[cid]!.ringing.filter((id) => id !== me.id) } }));
            void api(`/api/conversations/${cid}/call/decline`, { body: {} });
          }}
        />
      )}
      {dialog === "group" && (
        <NewGroup
          friends={friends}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null);
            setConversations((cs) => [c, ...cs.filter((x) => x.id !== c.id)]);
            open({ kind: "conversation", id: c.id });
          }}
        />
      )}
      {dialog === "settings" && (
        <Settings
          me={me}
          onClose={() => setDialog(null)}
          onSaved={(m) => {
            setMe(m);
            // Turning receipts on or off changes whose reads this person can see.
            void api<Conversation[]>("/api/conversations").then(setConversations);
          }}
        />
      )}
    </div>
  );
}
