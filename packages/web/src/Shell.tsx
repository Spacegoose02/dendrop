import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Activity,
  Call,
  CallJoin,
  Channel,
  ChannelKind,
  ChatServer,
  ChoresToday,
  Conversation,
  FamilyAlert,
  FamilyInfo,
  Friend,
  InvitePreview,
  Me,
  PlayTogether,
  PublicUser,
  Reminder,
  ServerEvent,
  ServerInfo,
  VoiceChannelState,
  VoiceJoin,
} from "@dendrop/shared";
import { api, connectGateway, logout } from "./api.ts";
import { BOT_REPLY_EVENT, type BotReplyDetail } from "./Bots.tsx";
import { Chat } from "./Chat.tsx";
import { excerptOf, ReminderTray, type FiredReminder } from "./Fun.tsx";
import { Friends } from "./Friends.tsx";
import { Avatar } from "./Avatar.tsx";
import { IncomingCall } from "./IncomingCall.tsx";
import { PlayTogetherCard } from "./PlayTogether.tsx";
import { NewGroup } from "./NewGroup.tsx";
import { SettingsButton } from "./Settings.tsx";
import { EncryptionDialog, type EncryptionMode } from "./EncryptionDialog.tsx";
import { useVoiceKeybinds } from "./keybinds.ts";
import { keyring, loadIdentity, reveal, type Identity } from "./e2ee.ts";
import { conversationTitle, upsert, type History } from "./util.ts";
import { AdminDialog } from "./Admin.tsx";
import { ActivityContext, ActivityLine, ChoresContext } from "./activity.tsx";
import { LootdenUrlContext } from "./GameLink.tsx";
import { FamilyDialog } from "./Family.tsx";
import { ChannelDialog, CreateServer, Directory, InviteDialog, InviteLinkDialog, ServerIcon, ServerSettings, ServerSidebar, type SettingsTab } from "./Servers.tsx";
import { can } from "./roles.ts";
import { ExpressionsContext } from "./expressions.tsx";

// The call code (LiveKit) is big, so it only loads when a call starts.
const CallPanel = lazy(() => import("./CallPanel.tsx").then((m) => ({ default: m.CallPanel })));
const VoicePanel = lazy(() => import("./VoicePanel.tsx").then((m) => ({ default: m.VoicePanel })));

export type View =
  | { kind: "friends" }
  | { kind: "conversation"; id: number }
  | { kind: "directory" }
  | { kind: "channel"; serverId: number; channelId: number };

type ServerDialog =
  | { kind: "create" }
  | { kind: "invite"; serverId: number }
  | { kind: "channel"; serverId: number; channel: Channel | null; channelKind?: ChannelKind }
  | { kind: "settings"; serverId: number; tab?: SettingsTab }
  | { kind: "admin" }
  | { kind: "link"; code: string };

/** The conversation behind a view, if it shows one. */
const viewConversation = (v: View, servers: ChatServer[]): number | null => {
  if (v.kind === "conversation") return v.id;
  if (v.kind !== "channel") return null;
  return servers.find((s) => s.id === v.serverId)?.channels.find((c) => c.id === v.channelId)?.conversationId ?? null;
};

/**
 * The main layout: server rail, sidebar (DMs), main pane (friends or a chat).
 * Holds the live state the gateway keeps up to date.
 */
export function Shell({ me: initialMe, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [me, setMe] = useState(initialMe);
  useVoiceKeybinds();
  const [dialog, setDialog] = useState<"group" | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [calls, setCalls] = useState<Record<number, Call>>({});
  /** The call this device is in. */
  const [inCall, setInCall] = useState<CallJoin | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  /** Reminders that went off and haven't been dismissed. */
  const [fired, setFired] = useState<FiredReminder[]>([]);
  useEffect(() => {
    api<Reminder[]>("/api/reminders")
      .then((list) => setFired((cur) => [...cur, ...list.filter((r) => r.firedAt && !cur.some((x) => x.reminder.id === r.id)).map((reminder) => ({ reminder, excerpt: null }))]))
      .catch(() => {});
  }, []);
  /** Back from linking Google or TinyAuth in Settings: say how it went, then tidy the address. */
  const [signInNotice, setSignInNotice] = useState<{ ok: boolean; text: string } | null>(() => {
    const q = new URLSearchParams(location.search);
    const linked = q.get("linked");
    const failed = q.get("signin_error");
    if (!linked && !failed) return null;
    history.replaceState(null, "", location.pathname);
    if (failed) return { ok: false, text: failed };
    return { ok: true, text: `${linked === "google" ? "Google" : "Single sign-on"} is linked. You can sign in with it now.` };
  });
  /** Who is in each voice channel you can see, by channel id. */
  const [voice, setVoice] = useState<Record<number, VoiceChannelState>>({});
  /** The voice channel this device is in. */
  const [inVoice, setInVoice] = useState<VoiceJoin | null>(null);
  const [speaking, setSpeaking] = useState<Set<number>>(new Set());
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<View>({ kind: "friends" });
  /** On phones only one column shows: the DM list, or what's open. */
  const [showMain, setShowMain] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  /** What people are playing, from LootDen. */
  const [activities, setActivities] = useState<Record<number, Activity>>({});
  const loadActivities = useCallback(() => void api<Record<number, Activity>>("/api/activities").then(setActivities, () => {}), []);
  /** Kids' chores today, from Den Duty: your own, or your kids'. */
  const [chores, setChores] = useState<Record<number, ChoresToday>>({});
  const loadChores = useCallback(() => void api<Record<number, ChoresToday>>("/api/chores").then(setChores, () => {}), []);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [histories, setHistories] = useState<Record<number, History>>({});
  const [typing, setTyping] = useState<Record<number, Record<number, number>>>({});
  const [unread, setUnread] = useState<Set<number>>(new Set());
  const [servers, setServers] = useState<ChatServer[]>([]);
  const [invites, setInvites] = useState<InvitePreview[]>([]);
  /** Automod alerts not looked at yet, per server (owners and admins only get them). */
  const [automodAlerts, setAutomodAlerts] = useState<Record<number, number>>({});
  /** A voice channel opened for a game you're playing with others, to join or not. */
  const [playInvite, setPlayInvite] = useState<PlayTogether | null>(null);
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(() => {
    // Opened from an invite link: …/invite/CODE.
    const m = /^\/invite\/([A-Za-z0-9_-]{8,32})\/?$/.exec(location.pathname);
    if (!m) return null;
    history.replaceState(null, "", "/");
    return { kind: "link", code: m[1]! };
  });
  /** Goes up when a request to make servers comes in, so the admin dialog reloads. */
  const [adminVersion, setAdminVersion] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  /** Encryption on this device: still checking, not set up for the account, set up but not unlocked here, or ready. */
  const [keyState, setKeyState] = useState<"loading" | "off" | "locked" | "on">("loading");
  const [encryptionDialog, setEncryptionDialog] = useState<EncryptionMode | null>(null);
  /** Kid-safe chat: your family (as a kid or a parent), and alerts about your kids. */
  const [family, setFamily] = useState<FamilyInfo | null>(null);
  const [familyAlerts, setFamilyAlerts] = useState<FamilyAlert[]>([]);
  const [showFamily, setShowFamily] = useState(false);
  const loadFamily = useCallback(async () => {
    const f = await api<FamilyInfo>("/api/family");
    setFamily(f);
    setMe((m) => ({ ...m, isKid: f.parents.length > 0 }));
    setFamilyAlerts(f.kids.length ? await api<FamilyAlert[]>("/api/family/alerts") : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadIdentity(initialMe.id, initialMe.publicKey).then((identity) => {
      if (cancelled) return;
      keyring.identity = identity;
      const state = identity ? "on" : initialMe.publicKey ? "locked" : "off";
      setKeyState(state);
      // Ask once per visit; "Not now" closes it until next time.
      if (state === "off") setEncryptionDialog("setup");
      if (state === "locked") setEncryptionDialog("unlock");
    });
    return () => {
      cancelled = true;
    };
  }, [initialMe.id, initialMe.publicKey]);

  const onUnlocked = (identity: Identity) => {
    keyring.identity = identity;
    setKeyState("on");
    setEncryptionDialog(null);
    setMe((m) => ({ ...m, publicKey: identity.publicKey }));
    // Load everything again, now that it can be read.
    void refresh();
  };

  const refresh = useCallback(async () => {
    const [f, c, info, live, sv, inv, vc] = await Promise.all([
      api<Friend[]>("/api/friends"),
      api<Conversation[]>("/api/conversations"),
      api<ServerInfo>("/api/server"),
      api<Call[]>("/api/calls"),
      api<ChatServer[]>("/api/servers"),
      api<InvitePreview[]>("/api/invites"),
      api<VoiceChannelState[]>("/api/voice"),
    ]);
    setVoice(Object.fromEntries(vc.map((v) => [v.channelId, v])));
    setServers(sv);
    setInvites(inv);
    setServer(info);
    setCalls(Object.fromEntries(live.map((x) => [x.conversationId, x])));
    setFriends(f);
    setOnline(new Set(f.filter((x) => x.online).map((x) => x.user.id)));
    setConversations(c);
    void loadFamily().catch(() => {});
    loadActivities();
    loadChores();
    // Anything open may have missed messages while disconnected; reload it on demand.
    setHistories({});
  }, []);

  const onEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case "ready":
          setMe((m) => ({ ...m, ...e.user, publicKey: m.publicKey ?? e.user.publicKey }));
          void refresh();
          break;
        case "family.updated":
          setFamily(e.family);
          loadChores();
          setMe((m) => ({ ...m, isKid: e.family.parents.length > 0 }));
          if (e.family.kids.length) void api<FamilyAlert[]>("/api/family/alerts").then(setFamilyAlerts);
          break;
        case "automod.alert":
          setAutomodAlerts((all) => ({ ...all, [e.event.serverId]: (all[e.event.serverId] ?? 0) + 1 }));
          break;
        case "family.alert":
          setFamilyAlerts((list) => [e.alert, ...list.filter((a) => a.id !== e.alert.id)]);
          break;
        case "friend.updated":
          setFriends((fs) => [...fs.filter((f) => f.user.id !== e.friend.user.id), e.friend]);
          if (e.friend.state === "friends") loadActivities();
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
          loadActivities();
          break;
        case "chores":
          setChores((all) => {
            const n = { ...all };
            if (e.chores) n[e.userId] = e.chores;
            else delete n[e.userId];
            return n;
          });
          break;
        case "activity":
          setActivities((all) => {
            const n = { ...all };
            if (e.activity) n[e.userId] = e.activity;
            else delete n[e.userId];
            return n;
          });
          break;
        case "play.together":
          setPlayInvite(e.invite);
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
        case "conversation.updated":
          setConversations((cs) => cs.map((c) => (c.id === e.conversation.id ? e.conversation : c)));
          break;
        case "message.created": {
          const m = e.message;
          void reveal(m).then((shown) =>
            setHistories((h) => {
              const cur = h[m.conversationId];
              if (!cur || cur.messages.some((x) => x.id === m.id)) return h;
              return { ...h, [m.conversationId]: { ...cur, messages: upsert(cur.messages, shown) } };
            }),
          );
          const isChannel = serversRef.current.some((sv) => sv.channels.some((ch) => ch.conversationId === m.conversationId));
          if (!isChannel) setConversations((cs) => {
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
          if ((m.authorId !== me.id || m.webhook) && !(viewConversation(v, serversRef.current) === m.conversationId && document.hasFocus())) {
            setUnread((u) => new Set(u).add(m.conversationId));
          }
          break;
        }
        case "message.updated": {
          const m = e.message;
          void reveal(m).then((shown) =>
            setHistories((h) => {
              const cur = h[m.conversationId];
              if (!cur) return h;
              return { ...h, [m.conversationId]: { ...cur, messages: cur.messages.map((x) => (x.id === m.id ? shown : x)) } };
            }),
          );
          break;
        }
        case "message.reactions":
          setHistories((h) => {
            const cur = h[e.conversationId];
            if (!cur) return h;
            return { ...h, [e.conversationId]: { ...cur, messages: cur.messages.map((x) => (x.id === e.messageId ? { ...x, reactions: e.reactions } : x)) } };
          });
          break;
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
        case "voice.updated": {
          const v = e.voice;
          setVoice((all) => {
            const n = { ...all };
            if (v.members.length) n[v.channelId] = v;
            else delete n[v.channelId];
            return n;
          });
          // Taken out by the server (lost access, or the channel went away).
          setInVoice((cur) => (cur && cur.voice.channelId === v.channelId && !v.members.some((m) => m.userId === me.id) ? null : cur));
          break;
        }
        case "server.updated":
          setServers((list) =>
            list.some((x) => x.id === e.server.id) ? list.map((x) => (x.id === e.server.id ? e.server : x)) : [...list, e.server],
          );
          setInvites((list) => list.filter((i) => i.server.id !== e.server.id));
          loadActivities();
          break;
        case "server.removed":
          setServers((list) => list.filter((x) => x.id !== e.serverId));
          loadActivities();
          setView((v) => (v.kind === "channel" && v.serverId === e.serverId ? { kind: "friends" } : v));
          setServerDialog((d) => (d && "serverId" in d && d.serverId === e.serverId ? null : d));
          break;
        case "server.invited":
          setInvites((list) => [e.invite, ...list.filter((i) => i.code !== e.invite.code)]);
          break;
        case "server.request":
          if (e.request.user.id === me.id) setMe((m) => ({ ...m, canCreateServers: m.isSuperAdmin || e.request.status === "approved" }));
          setAdminVersion((n) => n + 1);
          break;
        case "interaction.reply":
          window.dispatchEvent(new CustomEvent<BotReplyDetail>(BOT_REPLY_EVENT, { detail: { messageId: e.messageId, content: e.content } }));
          break;
        case "reminder": {
          const { reminder, message } = e;
          void (message ? reveal(message) : Promise.resolve(null)).then((shown) => {
            const excerpt = shown ? excerptOf(shown) : null;
            setFired((f) => [...f.filter((x) => x.reminder.id !== reminder.id), { reminder, excerpt }]);
            if (document.visibilityState !== "visible" && typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification("Dendrop reminder", { body: excerpt ?? "A message you wanted to come back to" });
            }
          });
          break;
        }
        case "typing":
          setTyping((t) => ({ ...t, [e.conversationId]: { ...(t[e.conversationId] ?? {}), [e.userId]: Date.now() } }));
          break;
      }
    },
    [me.id, refresh, loadActivities, loadChores],
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

  const dismissReminder = (r: Reminder) => {
    setFired((f) => f.filter((x) => x.reminder.id !== r.id));
    void api(`/api/reminders/${r.id}`, { method: "DELETE" }).catch(() => {});
  };

  const open = (v: View) => {
    setView(v);
    setShowMain(true);
    const cid = viewConversation(v, serversRef.current);
    if (cid !== null) {
      setUnread((u) => {
        const n = new Set(u);
        n.delete(cid);
        return n;
      });
    }
  };

  /** Opens a server at a channel (its first one by default). */
  const openServer = (sv: ChatServer, channelId?: number) => {
    setServers((list) => (list.some((x) => x.id === sv.id) ? list.map((x) => (x.id === sv.id ? sv : x)) : [...list, sv]));
    serversRef.current = serversRef.current.some((x) => x.id === sv.id) ? serversRef.current : [...serversRef.current, sv];
    setInvites((list) => list.filter((i) => i.server.id !== sv.id));
    open({ kind: "channel", serverId: sv.id, channelId: channelId ?? sv.channels[0]?.id ?? 0 });
  };

  const messageFriend = async (user: PublicUser) => {
    const c = await api<Conversation>("/api/conversations", { body: { userId: user.id } });
    setConversations((cs) => [c, ...cs.filter((x) => x.id !== c.id)]);
    open({ kind: "conversation", id: c.id });
  };

  const leaveVoice = () => {
    void api("/api/voice/leave", { body: {} }).catch(() => {});
    setInVoice(null);
  };

  /** Drops into a voice channel: one voice channel or call at a time. */
  const joinVoice = async (sv: ChatServer, c: Channel) => {
    if (inVoice?.voice.channelId === c.id) return;
    if (inCall) {
      if (!confirm("Leave your call and join this voice channel?")) return;
      void api(`/api/conversations/${inCall.call.conversationId}/call/leave`, { body: {} });
      setInCall(null);
    }
    // The server moves you; this just stops the old room here first.
    setInVoice(null);
    setCallError(null);
    try {
      setInVoice(await api<VoiceJoin>(`/api/servers/${sv.id}/channels/${c.id}/voice`, { body: {} }));
    } catch (err) {
      setCallError((err as Error).message);
    }
  };

  const startCall = async (conversationId: number, video: boolean) => {
    if (inVoice) {
      if (!confirm("Leave the voice channel and join this call?")) return;
      leaveVoice();
    }
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

  const kidRules = me.isKid && family?.rules && family.status ? { rules: family.rules, status: family.status } : null;
  const expressions = useMemo(() => ({ servers, gifs: !!server?.gifs && (!me.isKid || !!family?.rules?.gifs) }), [servers, server?.gifs, me.isKid, family?.rules?.gifs]);
  const openAlerts = familyAlerts.filter((a) => !a.resolvedAt).length;
  const current = view.kind === "conversation" ? conversations.find((c) => c.id === view.id) : undefined;
  const currentServer = view.kind === "channel" ? servers.find((x) => x.id === view.serverId) : undefined;
  const currentChannel = view.kind === "channel" ? currentServer?.channels.find((c) => c.id === view.channelId) : undefined;
  /** A channel shown through Chat: its conversation, with server nicknames as names. */
  const channelConversation = useMemo((): Conversation | undefined => {
    if (!currentServer || !currentChannel) return undefined;
    return {
      id: currentChannel.conversationId,
      isGroup: true,
      name: currentChannel.kind === "voice" ? currentChannel.name : `#${currentChannel.name}`,
      // A role color wins over someone's own name color in a server.
      members: currentServer.members.map((m) => ({ ...m.user, displayName: m.nickname ?? m.user.displayName, nameColor: m.color ?? m.user.nameColor })),
      lastMessageAt: null,
      createdAt: currentServer.createdAt,
      reads: [],
      e2ee: null,
      guardians: [],
    };
  }, [currentServer, currentChannel]);
  /** You, as Chat shows your own messages in the open server: in your highest role's color, if it has one. */
  const myRoleColor = currentServer?.members.find((m) => m.user.id === me.id)?.color ?? null;
  const meInServer = useMemo(() => (myRoleColor ? { ...me, nameColor: myRoleColor } : me), [me, myRoleColor]);
  const serverUnread = (sv: ChatServer) => sv.channels.some((c) => unread.has(c.conversationId));
  const dialogServer = serverDialog && "serverId" in serverDialog ? servers.find((x) => x.id === serverDialog.serverId) : undefined;
  const incoming = friends.filter((f) => f.state === "incoming").length;

  const shell = (
    <div className={`shell ${showMain ? "show-main" : ""}`}>
      <nav className="rail" aria-label="Servers">
        <button
          className={`rail-item ${view.kind === "friends" || view.kind === "conversation" ? "active" : ""}`}
          title="Direct messages"
          onClick={() => open(current ? view : { kind: "friends" })}
        >
          <img src="/favicon.svg" alt="Direct messages" width={32} height={32} />
        </button>
        <div className="rail-sep" />
        {servers.map((sv) => (
          <button
            key={sv.id}
            className={`rail-server ${currentServer?.id === sv.id ? "active" : ""}`}
            title={sv.name}
            aria-label={sv.name}
            onClick={() => openServer(sv)}
          >
            <ServerIcon server={sv} size={48} />
            {serverUnread(sv) && <span className="rail-dot" aria-label="Unread" />}
          </button>
        ))}
        <button
          className={`rail-item rail-add ${view.kind === "directory" ? "active" : ""}`}
          title="Find or create a server"
          aria-label="Find or create a server"
          onClick={() => open({ kind: "directory" })}
        >
          ＋{invites.length > 0 && <span className="rail-badge">{invites.length}</span>}
        </button>
      </nav>

      <aside className="sidebar">
        {currentServer ? (
          <ServerSidebar
            server={currentServer}
            activeChannel={view.kind === "channel" ? view.channelId : null}
            unread={unread}
            voice={voice}
            speaking={speaking}
            inVoice={inVoice?.voice.channelId ?? null}
            onOpen={(c) => {
              open({ kind: "channel", serverId: currentServer.id, channelId: c.id });
              // Opening a voice channel drops you in.
              if (c.kind === "voice" && server?.calls) void joinVoice(currentServer, c);
            }}
            onSettings={() => setServerDialog({ kind: "settings", serverId: currentServer.id })}
            automodAlerts={automodAlerts[currentServer.id] ?? 0}
            onModLog={() => {
              setAutomodAlerts((all) => ({ ...all, [currentServer.id]: 0 }));
              setServerDialog({ kind: "settings", serverId: currentServer.id, tab: "modlog" });
            }}
            onInvite={() => setServerDialog({ kind: "invite", serverId: currentServer.id })}
            onChannel={(c, channelKind) => setServerDialog({ kind: "channel", serverId: currentServer.id, channel: c, channelKind })}
          />
        ) : (
        <>
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
                  {solo && <ActivityLine userId={solo.id} />}
                </span>
                {unread.has(c.id) && <span className="dot" aria-label="Unread" />}
              </button>
            );
          })}
        </div>
        </>
        )}
        <footer className="me">
          <Avatar name={me.displayName} online={connected} size={36} title={connected ? "Connected" : "Reconnecting…"} />
          <div className="me-names">
            <strong>{me.displayName}</strong>
            <span className="muted">@{me.username}</span>
          </div>
          {(me.isKid || !!family?.kids.length) && (
          <button
            className="ghost family-button"
            onClick={() => setShowFamily(true)}
            title={me.isKid ? "Your family" : "Family: kid accounts and alerts"}
            aria-label={openAlerts ? `Family, ${openAlerts} new alerts` : "Family"}
          >
            👪{openAlerts > 0 && <span className="dot" aria-hidden />}
          </button>
          )}
          <SettingsButton
            me={me}
            keyState={keyState}
            onEncryption={(mode) => setEncryptionDialog(mode)}
            onFamily={() => setShowFamily(true)}
            onSaved={(m) => {
              setMe(m);
              // Turning receipts on or off changes whose reads this person can see.
              void api<Conversation[]>("/api/conversations").then(setConversations);
            }}
          />
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
        {inVoice && (
          <Suspense fallback={<div className="call-bar muted">Joining voice…</div>}>
            <VoicePanel
              key={inVoice.voice.channelId}
              me={me}
              join={inVoice}
              server={servers.find((x) => x.id === inVoice.voice.serverId)}
              channel={servers.find((x) => x.id === inVoice.voice.serverId)?.channels.find((c) => c.id === inVoice.voice.channelId)}
              compact={!(view.kind === "channel" && view.channelId === inVoice.voice.channelId)}
              onOpen={() => open({ kind: "channel", serverId: inVoice.voice.serverId, channelId: inVoice.voice.channelId })}
              onLeft={() => setInVoice(null)}
              onSpeakers={(ids) => setSpeaking(new Set(ids))}
            />
          </Suspense>
        )}
        {signInNotice && (
          <p className={`call-error ${signInNotice.ok ? "" : "error"}`} role="status">
            {signInNotice.text}{" "}
            <button className="link" onClick={() => setSignInNotice(null)}>
              Dismiss
            </button>
          </p>
        )}
        <ReminderTray
          items={fired}
          titleOf={(cid) => {
            const c = conversations.find((x) => x.id === cid);
            if (c) return conversationTitle(c, me.id);
            const ch = servers.flatMap((sv) => sv.channels).find((x) => x.conversationId === cid);
            return ch ? `#${ch.name}` : "a chat";
          }}
          onOpen={(r) => {
            const ch = servers.flatMap((sv) => sv.channels).find((x) => x.conversationId === r.conversationId);
            open(ch ? { kind: "channel", serverId: ch.serverId, channelId: ch.id } : { kind: "conversation", id: r.conversationId });
            dismissReminder(r);
          }}
          onDismiss={dismissReminder}
        />
        {callError && (
          <p className="error call-error" role="alert">
            {callError}{" "}
            <button className="link" onClick={() => setCallError(null)}>
              Dismiss
            </button>
          </p>
        )}
        {view.kind === "directory" && (
          <Directory
            me={me}
            mine={servers}
            invites={invites}
            onJoined={(sv) => openServer(sv)}
            onDeclined={(code) => setInvites((list) => list.filter((i) => i.code !== code))}
            onCreate={() => setServerDialog({ kind: "create" })}
            onAdmin={() => setServerDialog({ kind: "admin" })}
            onBack={() => setShowMain(false)}
          />
        )}
        {view.kind === "channel" && currentServer && !channelConversation && (
          <div className="empty muted">{currentServer.channels.length ? "Pick a channel." : "This server has no channels yet."}</div>
        )}
        {currentServer && currentChannel && channelConversation && (
          <Chat
            key={channelConversation.id}
            me={meInServer}
            conversation={channelConversation}
            online={online}
            history={histories[channelConversation.id]}
            setHistory={(h) => setHistories((all) => ({ ...all, [channelConversation.id]: h(all[channelConversation.id]) }))}
            typingIds={Object.keys(typing[channelConversation.id] ?? {}).map(Number)}
            sendTyping={() => sendRef.current({ type: "typing", conversationId: channelConversation.id })}
            callsEnabled={false}
            call={undefined}
            inThisCall={false}
            onCall={() => {}}
            onBack={() => setShowMain(false)}
            keyState={keyState}
            onEncryption={() => {}}
            kid={kidRules}
            channel={{
              serverId: currentServer.id,
              topic: currentChannel.topic,
              canModerate: can(currentServer, "deleteMessages"),
              timedOutUntil: currentServer.timedOutUntil,
              voice:
                currentChannel.kind === "voice"
                  ? {
                      count: voice[currentChannel.id]?.members.length ?? 0,
                      inIt: inVoice?.voice.channelId === currentChannel.id,
                      enabled: !!server?.calls,
                      onJoin: () => void joinVoice(currentServer, currentChannel),
                    }
                  : undefined,
            }}
          />
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
            keyState={keyState}
            onEncryption={() => setEncryptionDialog(keyState === "off" ? "setup" : "unlock")}
            kid={kidRules}
          />
        )}
      </main>
      {showFamily && (
        <FamilyDialog
          me={me}
          family={family}
          alerts={familyAlerts}
          conversations={conversations}
          encryptionOn={keyState === "on"}
          onClose={() => setShowFamily(false)}
          onChanged={() => void loadFamily()}
        />
      )}
      {encryptionDialog && (
        <EncryptionDialog me={me} mode={encryptionDialog} setMode={setEncryptionDialog} onDone={onUnlocked} onClose={() => setEncryptionDialog(null)} />
      )}
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
      {playInvite && server?.calls && !ringing && !dialog && inVoice?.voice.channelId !== playInvite.channelId && (() => {
        const sv = servers.find((x) => x.id === playInvite.serverId);
        const ch = sv?.channels.find((c) => c.id === playInvite.channelId);
        if (!sv || !ch) return null;
        return (
          <PlayTogetherCard
            me={me}
            invite={playInvite}
            server={sv}
            onClose={() => setPlayInvite(null)}
            onJoin={() => {
              setPlayInvite(null);
              open({ kind: "channel", serverId: sv.id, channelId: ch.id });
              void joinVoice(sv, ch);
            }}
          />
        );
      })()}
      {serverDialog?.kind === "create" && (
        <CreateServer
          me={me}
          onClose={() => setServerDialog(null)}
          onCreated={(sv) => {
            setServerDialog(null);
            openServer(sv);
          }}
        />
      )}
      {serverDialog?.kind === "link" && !encryptionDialog && (
        <InviteLinkDialog
          code={serverDialog.code}
          onClose={() => setServerDialog(null)}
          onJoined={(sv) => {
            setServerDialog(null);
            openServer(sv);
          }}
        />
      )}
      {serverDialog?.kind === "admin" && <AdminDialog version={adminVersion} onClose={() => setServerDialog(null)} />}
      {serverDialog?.kind === "invite" && dialogServer && <InviteDialog server={dialogServer} friends={friends} onClose={() => setServerDialog(null)} />}
      {serverDialog?.kind === "channel" && dialogServer && (
        <ChannelDialog
          server={dialogServer}
          channel={serverDialog.channel}
          kind={serverDialog.channelKind}
          onClose={() => setServerDialog(null)}
          onDone={(made) => {
            setServerDialog(null);
            if (made) {
              // The server's update may not be here yet; add the channel so it can open now.
              setServers((list) => list.map((x) => (x.id === made.serverId && !x.channels.some((c) => c.id === made.id) ? { ...x, channels: [...x.channels, made] } : x)));
              open({ kind: "channel", serverId: made.serverId, channelId: made.id });
            }
          }}
        />
      )}
      {serverDialog?.kind === "settings" && dialogServer && (
        <ServerSettings
          me={me}
          server={dialogServer}
          initialTab={serverDialog.tab}
          onClose={() => setServerDialog(null)}
          onGone={() => {
            setServerDialog(null);
            setServers((list) => list.filter((x) => x.id !== dialogServer.id));
            setView({ kind: "friends" });
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
    </div>
  );
  return (
    <LootdenUrlContext.Provider value={server?.lootdenUrl ?? null}>
      <ActivityContext.Provider value={activities}>
        <ChoresContext.Provider value={chores}>
          <ExpressionsContext.Provider value={expressions}>{shell}</ExpressionsContext.Provider>
        </ChoresContext.Provider>
      </ActivityContext.Provider>
    </LootdenUrlContext.Provider>
  );
}
