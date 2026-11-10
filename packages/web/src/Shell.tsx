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
  ScheduledEvent,
  Reminder,
  ServerEvent,
  ServerInfo,
  RailItem,
  Thread,
  UnreadCount,
  VoiceChannelState,
  VoiceJoin,
} from "@dendrop/shared";
import { isVoiceKind } from "@dendrop/shared";
import { api, connectGateway, logout } from "./api.ts";
import { PresencePicker, UnreadBadge } from "./Unread.tsx";
import { ServerRail } from "./Rail.tsx";
import { ForwardDialog, InboxPanel, setSaved, startForward, useForwarding, type InboxTab } from "./Inbox.tsx";
import { startWebPush } from "./webpush.ts";
import { channelTitle } from "./channels.ts";
import { EventReminderCard, EventsDialog } from "./Events.tsx";
import { BOT_REPLY_EVENT, type BotReplyDetail } from "./Bots.tsx";
import { Chat, type ChannelInfo } from "./Chat.tsx";
import { canPinIn, ForumView, PinsDialog, runsThreads, ThreadActions } from "./Threads.tsx";
import { excerptOf, ReminderTray, type FiredReminder } from "./Fun.tsx";
import { Friends } from "./Friends.tsx";
import { Avatar } from "./Avatar.tsx";
import { IncomingCall } from "./IncomingCall.tsx";
import { connectNativeCalls, reportCallState, type NativeAnswer } from "./native.ts";
import { PlayTogetherCard } from "./PlayTogether.tsx";
import { feedOverlayMessage, useGameOverlay } from "./gameOverlay.ts";
import { COUPLES_EVENT, LoveNotePopup, type CouplesEventDetail } from "./Couples.tsx";
import { LevelUpCard } from "./Levels.tsx";
import { needsWelcome, WelcomeScreen } from "./Welcome.tsx";
import { NewGroup } from "./NewGroup.tsx";
import { SettingsButton } from "./Settings.tsx";
import { EncryptionDialog, type EncryptionMode } from "./EncryptionDialog.tsx";
import { useVoiceKeybinds } from "./keybinds.ts";
import { keyring, loadIdentity, reveal, type Identity } from "./e2ee.ts";
import { conversationTitle, upsert, type History } from "./util.ts";
import { AdminDialog } from "./Admin.tsx";
import { loadBlocked, setBlocked } from "./Safety.tsx";
import { ActivityContext, ActivityLine, ChoresContext } from "./activity.tsx";
import { LootdenUrlContext } from "./GameLink.tsx";
import { FamilyDialog } from "./Family.tsx";
import { ChannelDialog, CreateServer, Directory, InviteDialog, InviteLinkDialog, ServerIcon, ServerSettings, ServerSidebar, type SettingsTab } from "./Servers.tsx";
import { can } from "./roles.ts";
import { ExpressionsContext } from "./expressions.tsx";
import { patchUser, ProfileCard, ProfileContext, ProfileEditorDialog, StatusLine, type ProfileTarget } from "./Profile.tsx";
import { setNotificationSettings } from "./notify.tsx";
import { closeSearch, openSearch, requestJump, SearchPanel, useSearchOpen } from "./Search.tsx";
import { playSoundboard } from "./soundboard.ts";

// The call code (LiveKit) is big, so it only loads when a call starts.
const CallPanel = lazy(() => import("./CallPanel.tsx").then((m) => ({ default: m.CallPanel })));
const VoicePanel = lazy(() => import("./VoicePanel.tsx").then((m) => ({ default: m.VoicePanel })));

export type View =
  | { kind: "friends" }
  | { kind: "conversation"; id: number }
  | { kind: "directory" }
  /** A channel, with one of its threads (or a forum's posts) open beside or instead of it. */
  | { kind: "channel"; serverId: number; channelId: number; threadId?: number };

type ServerDialog =
  | { kind: "create" }
  | { kind: "invite"; serverId: number }
  | { kind: "channel"; serverId: number; channel: Channel | null; channelKind?: ChannelKind; categoryId?: number | null }
  | { kind: "settings"; serverId: number; tab?: SettingsTab }
  | { kind: "welcome"; serverId: number }
  | { kind: "admin" }
  | { kind: "events"; serverId: number }
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
  /** Unread messages and pings per conversation; a conversation that's caught up isn't in it. */
  const [unread, setUnread] = useState<Map<number, { count: number; mentions: number }>>(new Map());
  const [dnd, setDnd] = useState<Set<number>>(new Set());
  const [inbox, setInbox] = useState<InboxTab | null>(null);
  const [rail, setRail] = useState<RailItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const forwarding = useForwarding();
  const [servers, setServers] = useState<ChatServer[]>([]);
  const [invites, setInvites] = useState<InvitePreview[]>([]);
  /** Automod alerts not looked at yet, per server (owners and admins only get them). */
  const [automodAlerts, setAutomodAlerts] = useState<Record<number, number>>({});
  /** A voice channel opened for a game you're playing with others, to join or not. */
  const [playInvite, setPlayInvite] = useState<PlayTogether | null>(null);
  /** Events in every server you're in, soonest first. */
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  /** An event you RSVP'd to starts soon (minutes > 0) or just started. */
  const [eventReminder, setEventReminder] = useState<{ event: ScheduledEvent; minutes: number } | null>(null);
  /** You just reached a new level in a server. */
  const [levelUp, setLevelUp] = useState<Extract<ServerEvent, { type: "level.up" }> | null>(null);
  /** Servers whose welcome screen you put off with "Later" (until the app reloads). */
  const welcomeLater = useRef(new Set<number>());
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(() => {
    // Opened from an invite link: …/invite/CODE.
    const m = /^\/invite\/([A-Za-z0-9_-]{8,32})\/?$/.exec(location.pathname);
    if (!m) return null;
    history.replaceState(null, "", "/");
    return { kind: "link", code: m[1]! };
  });
  /** Threads and forum posts seen so far, by id, kept live by the gateway. */
  const [threads, setThreads] = useState<Record<number, Thread>>({});
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const addThreads = useCallback((list: Thread[]) => setThreads((all) => ({ ...all, ...Object.fromEntries(list.map((t) => [t.id, t])) })), []);
  /** The pinned board, while it's open, and a counter that reloads it when pins change. */
  const [pinsOpen, setPinsOpen] = useState<{ serverId: number; channelId: number | null } | null>(null);
  const [pinsVersion, setPinsVersion] = useState(0);
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
  /** The profile card that's open, and whether your profile editor is. */
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
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
    void api<ScheduledEvent[]>("/api/events").then(setEvents, () => {});
    setVoice(Object.fromEntries(vc.map((v) => [v.channelId, v])));
    setServers(sv);
    setInvites(inv);
    setServer(info);
    setCalls(Object.fromEntries(live.map((x) => [x.conversationId, x])));
    setFriends(f);
    setOnline(new Set(f.filter((x) => x.online).map((x) => x.user.id)));
    setDnd(new Set(f.filter((x) => x.dnd).map((x) => x.user.id)));
    setConversations(c);
    void api<RailItem[]>("/api/me/rail").then(setRail, () => {});
    void api<UnreadCount[]>("/api/unread").then(
      (list) => setUnread(new Map(list.map((u) => [u.conversationId, { count: u.count, mentions: u.mentions }]))),
      () => {},
    );
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
          loadBlocked();
          break;
        case "blocks.updated":
          setBlocked(e.blocked);
          break;
        case "report.created":
          setAdminVersion((n) => n + 1);
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
          if (e.friend.dnd !== undefined) {
            const { id } = e.friend.user;
            const isDnd = e.friend.dnd;
            setDnd((s) => {
              const n = new Set(s);
              if (isDnd) n.add(id);
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
        case "user.updated": {
          // Someone's name, colors, picture or status changed: update every copy of them.
          const u = e.user;
          if (u.id === me.id) setMe((m) => ({ ...m, ...u, publicKey: m.publicKey }));
          setFriends((fs) => (fs.some((f) => f.user.id === u.id) ? fs.map((f) => (f.user.id === u.id ? { ...f, user: { ...f.user, ...u } } : f)) : fs));
          setConversations((cs) => patchUser.conversations(cs, u));
          setServers((list) => patchUser.servers(list, u));
          break;
        }
        case "play.together":
          setPlayInvite(e.invite);
          break;
        case "level.up":
          setLevelUp(e);
          break;
        case "presence":
          setOnline((s) => {
            const n = new Set(s);
            if (e.online) n.add(e.userId);
            else n.delete(e.userId);
            return n;
          });
          setDnd((s) => {
            const n = new Set(s);
            if (e.online && e.dnd) n.add(e.userId);
            else n.delete(e.userId);
            return n;
          });
          break;
        case "unread":
          setUnread((u) => {
            const n = new Map(u);
            if (e.unread.count > 0) n.set(e.unread.conversationId, { count: e.unread.count, mentions: e.unread.mentions });
            else n.delete(e.unread.conversationId);
            return n;
          });
          break;
        case "rail.updated":
          setRail(e.rail);
          break;
        case "saved.updated":
          setSaved(e.messageId, e.saved);
          break;
        case "me.updated":
          setMe((m) => ({ ...m, ...e.user, publicKey: m.publicKey ?? e.user.publicKey }));
          break;
        case "conversation.created":
          setConversations((cs) => [e.conversation, ...cs.filter((c) => c.id !== e.conversation.id)]);
          break;
        case "conversation.updated":
          setConversations((cs) => cs.map((c) => (c.id === e.conversation.id ? e.conversation : c)));
          break;
        case "message.created": {
          const m = e.message;
          feedOverlayMessage(m);
          void reveal(m).then((shown) =>
            setHistories((h) => {
              const cur = h[m.conversationId];
              if (!cur || cur.messages.some((x) => x.id === m.id)) return h;
              return { ...h, [m.conversationId]: { ...cur, messages: upsert(cur.messages, shown) } };
            }),
          );
          const isChannel =
            serversRef.current.some((sv) => sv.channels.some((ch) => ch.conversationId === m.conversationId)) ||
            Object.values(threadsRef.current).some((t) => t.conversationId === m.conversationId);
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
          // Muted conversations don't get an unread dot (unless you're pinged).
          if (e.muted && !e.mentioned) break;
          if ((m.authorId !== me.id || m.webhook) && !(viewConversation(v, serversRef.current) === m.conversationId && document.hasFocus())) {
            setUnread((u) => {
              const n = new Map(u);
              const cur = n.get(m.conversationId) ?? { count: 0, mentions: 0 };
              n.set(m.conversationId, { count: cur.count + 1, mentions: cur.mentions + (e.mentioned ? 1 : 0) });
              return n;
            });
          }
          break;
        }
        case "notifications.updated":
          setNotificationSettings(e.settings);
          break;
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
        case "voice.move":
          // A moderator moved you: the effect below joins the new channel.
          window.dispatchEvent(new CustomEvent("dendrop:voice-move", { detail: { serverId: e.serverId, channelId: e.channelId } }));
          break;
        case "voice.sound":
          // Only people in that voice channel get these.
          playSoundboard(e.play);
          break;
        case "server.updated":
          setServers((list) =>
            list.some((x) => x.id === e.server.id) ? list.map((x) => (x.id === e.server.id ? e.server : x)) : [...list, e.server],
          );
          setInvites((list) => list.filter((i) => i.server.id !== e.server.id));
          loadActivities();
          break;
        case "event.updated":
        case "event.reminder": {
          const ev = e.event;
          setEvents((list) => [...list.filter((x) => x.id !== ev.id), ev].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id));
          if (e.type === "event.reminder") setEventReminder({ event: ev, minutes: e.minutes });
          else setEventReminder((r) => (r && r.event.id === ev.id ? { ...r, event: ev } : r));
          break;
        }
        case "event.removed":
          setEvents((list) => list.filter((x) => x.id !== e.eventId));
          setEventReminder((r) => (r && r.event.id === e.eventId ? null : r));
          break;
        case "server.removed":
          setEvents((list) => list.filter((x) => x.serverId !== e.serverId));
          setServers((list) => list.filter((x) => x.id !== e.serverId));
          loadActivities();
          setView((v) => (v.kind === "channel" && v.serverId === e.serverId ? { kind: "friends" } : v));
          setServerDialog((d) => (d && "serverId" in d && d.serverId === e.serverId ? null : d));
          break;
        case "thread.updated":
          setThreads((all) => ({ ...all, [e.thread.id]: e.thread }));
          break;
        case "thread.removed":
          setThreads((all) => {
            const n = { ...all };
            delete n[e.threadId];
            return n;
          });
          setView((v) => (v.kind === "channel" && v.threadId === e.threadId ? { kind: "channel", serverId: v.serverId, channelId: v.channelId } : v));
          break;
        case "pins.updated":
          setPinsVersion((n) => n + 1);
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
        case "couples.updated":
          window.dispatchEvent(new CustomEvent<CouplesEventDetail>(COUPLES_EVENT, { detail: { conversationId: e.conversationId, noteFrom: e.noteFrom } }));
          break;
        case "typing":
          setTyping((t) => ({ ...t, [e.conversationId]: { ...(t[e.conversationId] ?? {}), [e.userId]: Date.now() } }));
          break;
      }
    },
    [me.id, refresh, loadActivities, loadChores],
  );

  const sendRef = useRef<(data: object) => void>(() => {});
  // Browser notifications (when they're on): hand the server this browser's subscription again.
  useEffect(() => startWebPush(), []);
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
        if (!u.has(cid)) return u;
        const n = new Map(u);
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

  // Moved by a moderator: drop into the channel they picked.
  useEffect(() => {
    const onMove = (ev: Event) => {
      const { serverId, channelId } = (ev as CustomEvent<{ serverId: number; channelId: number }>).detail;
      const sv = servers.find((x) => x.id === serverId);
      const ch = sv?.channels.find((c) => c.id === channelId);
      if (sv && ch) void joinVoice(sv, ch);
    };
    window.addEventListener("dendrop:voice-move", onMove);
    return () => window.removeEventListener("dendrop:voice-move", onMove);
  });

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

  // In the iPhone app, iOS's own call screen rings and answers (CallKit); the page joins the call.
  const [nativeRinging, setNativeRinging] = useState(false);
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;
  const nativeAnswer = useRef<{ pending: NativeAnswer | null; last: { cid: number; at: number } | null }>({ pending: null, last: null });
  const joinNativeAnswer = useCallback(() => {
    const a = nativeAnswer.current.pending;
    if (!a) return;
    const cid = a.conversationId ?? Object.values(callsRef.current).find((c) => c.ringing.includes(me.id))?.conversationId;
    if (cid === undefined) return; // Not loaded yet; tried again when calls arrive.
    nativeAnswer.current.pending = null;
    const last = nativeAnswer.current.last;
    if (last && last.cid === cid && Date.now() - last.at < 10_000) return;
    nativeAnswer.current.last = { cid, at: Date.now() };
    void startCallRef.current(cid, a.video);
  }, [me.id]);
  useEffect(() => {
    void connectNativeCalls({
      onAnswered: (a) => {
        nativeAnswer.current.pending = a;
        joinNativeAnswer();
      },
      onEnded: (cid) => {
        setInCall((c) => (c?.call.conversationId === cid ? null : c));
        setCalls((cs) => (cs[cid] ? { ...cs, [cid]: { ...cs[cid]!, ringing: cs[cid]!.ringing.filter((id) => id !== me.id) } } : cs));
      },
    }).then((r) => setNativeRinging(r.ringsNatively));
  }, [joinNativeAnswer, me.id]);
  useEffect(joinNativeAnswer, [calls, joinNativeAnswer]);
  const reportedCall = useRef<number | null>(null);
  const inCallId = inCall?.call.conversationId ?? null;
  useEffect(() => {
    if (inCallId === reportedCall.current) return;
    if (reportedCall.current !== null) reportCallState(reportedCall.current, false);
    if (inCallId !== null) reportCallState(inCallId, true);
    reportedCall.current = inCallId;
  }, [inCallId]);

  const kidRules = me.isKid && family?.rules && family.status ? { rules: family.rules, status: family.status } : null;
  /** A kid's word filter, for other people's statuses and profiles. */
  const profileFilter = kidRules?.rules.profanityFilter ? kidRules.rules.blockedWords : null;
  /** The freshest copy of someone the app already knows. */
  const knownUser = (id: number): PublicUser | undefined =>
    friends.find((f) => f.user.id === id)?.user ??
    conversations.flatMap((c) => [...c.members, ...c.guardians]).find((u) => u.id === id) ??
    servers.flatMap((sv) => sv.members.map((m) => m.user)).find((u) => u.id === id);
  const voiceServer = inVoice ? servers.find((x) => x.id === inVoice.voice.serverId) : undefined;
  // The PC app's in-game overlay (does nothing in a browser).
  useGameOverlay({
    me,
    inVoice,
    live: inVoice ? voice[inVoice.voice.channelId] : undefined,
    speaking,
    server: voiceServer,
    activity: activities[me.id],
    blockedWords: kidRules?.rules.profanityFilter ? kidRules.rules.blockedWords : null,
    canChat:
      !!inVoice &&
      !(kidRules && !kidRules.status.allowedNow) &&
      !(voiceServer?.timedOutUntil && Date.parse(voiceServer.timedOutUntil) > Date.now()),
  });
  const expressions = useMemo(() => ({ servers, gifs: !!server?.gifs && (!me.isKid || !!family?.rules?.gifs) }), [servers, server?.gifs, me.isKid, family?.rules?.gifs]);
  const openAlerts = familyAlerts.filter((a) => !a.resolvedAt).length;
  const current = view.kind === "conversation" ? conversations.find((c) => c.id === view.id) : undefined;
  const currentServer = view.kind === "channel" ? servers.find((x) => x.id === view.serverId) : undefined;
  const currentChannel = view.kind === "channel" ? currentServer?.channels.find((c) => c.id === view.channelId) : undefined;
  // New members see the server's welcome screen when they first open it.
  const welcomeDue = !!currentServer && needsWelcome(currentServer) && !welcomeLater.current.has(currentServer.id);
  useEffect(() => {
    if (welcomeDue && currentServer) setServerDialog((d) => d ?? { kind: "welcome", serverId: currentServer.id });
  }, [welcomeDue, currentServer?.id]);
  /** A channel shown through Chat: its conversation, with server nicknames as names. */
  const channelConversation = useMemo((): Conversation | undefined => {
    if (!currentServer || !currentChannel) return undefined;
    return {
      id: currentChannel.conversationId,
      isGroup: true,
      name: channelTitle(currentChannel),
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
  /** A server's events you can see: ones in channels you can't see any more are left out. */
  const eventsOf = (sv: ChatServer) => events.filter((x) => x.serverId === sv.id && (x.channelId === null || sv.channels.some((c) => c.id === x.channelId)));
  const serverUnread = (sv: ChatServer) => sv.channels.some((c) => unread.has(c.conversationId));
  const serverMentions = (sv: ChatServer) => sv.channels.reduce((n, c) => n + (unread.get(c.conversationId)?.mentions ?? 0), 0);
  const dialogServer = serverDialog && "serverId" in serverDialog ? servers.find((x) => x.id === serverDialog.serverId) : undefined;
  const incoming = friends.filter((f) => f.state === "incoming").length;

  /** The thread open in the current channel, if it's one of this channel's. */
  const currentThread = view.kind === "channel" && view.threadId ? threads[view.threadId] : undefined;
  const openThread = (serverId: number, t: Thread) => {
    addThreads([t]);
    open({ kind: "channel", serverId, channelId: t.channelId, threadId: t.id });
  };
  const closeThread = () => setView((v) => (v.kind === "channel" ? { kind: "channel", serverId: v.serverId, channelId: v.channelId } : v));
  /** Opens a message's thread, or starts one off it. */
  const startThread = async (serverId: number, messageId: number, threadId?: number) => {
    try {
      openThread(serverId, threadId ? await api<Thread>(`/api/threads/${threadId}`) : await api<Thread>(`/api/messages/${messageId}/thread`, { body: {} }));
    } catch (err) {
      alert((err as Error).message);
    }
  };

  /** A server channel or thread shown through Chat. */
  const channelChat = (conversation: Conversation, info: ChannelInfo, onBack: () => void = () => setShowMain(false)) => {
    const sv = servers.find((x) => x.id === info.serverId);
    return (
    <Chat
      key={conversation.id}
      me={meInServer}
      conversation={conversation}
      online={online}
      history={histories[conversation.id]}
      setHistory={(h) => setHistories((all) => ({ ...all, [conversation.id]: h(all[conversation.id]) }))}
      typingIds={Object.keys(typing[conversation.id] ?? {}).map(Number)}
      sendTyping={() => sendRef.current({ type: "typing", conversationId: conversation.id })}
      callsEnabled={false}
      call={undefined}
      inThisCall={false}
      onCall={() => {}}
      onBack={onBack}
      keyState={keyState}
      onEncryption={() => {}}
      kid={kidRules}
      channel={{ serverName: sv?.name, canMentionEveryone: !!sv && can(sv, "mentionEveryone"), ...info }}
    />
    );
  };

  /** A thread: beside its channel, or in place of a forum's list of posts. */
  const threadChat = (sv: ChatServer, ch: Channel, t: Thread) => {
    const forum = ch.kind === "forum";
    const readOnly = t.closed && !runsThreads(sv, ch) ? `This ${forum ? "post" : "thread"} is closed: you can read it, but not reply.` : null;
    return channelChat(
      { ...channelConversation!, id: t.conversationId, name: t.title },
      {
        serverId: sv.id,
        // A thread's pane is narrow: its intro says where it's from instead.
        topic: forum ? (t.tags.length ? t.tags.join(" · ") : "") : "",
        icon: forum ? "💬" : "🧵",
        canModerate: can(sv, "deleteMessages"),
        timedOutUntil: sv.timedOutUntil,
        canPin: canPinIn(sv, ch),
        readOnly,
        actions: (
          <>
            {forum && (
              <button className="ghost small-button" onClick={closeThread} title={`Back to ${ch.name}`}>
                ‹ All posts
              </button>
            )}
            <ThreadActions server={sv} me={me} thread={t} channel={ch} onDeleted={closeThread} />
            {!forum && (
              <button className="ghost icon" onClick={closeThread} title="Close the thread pane" aria-label="Close the thread pane">
                ✕
              </button>
            )}
          </>
        ),
        intro: (
          <p className="muted">
            {forum ? `The start of “${t.title}” in ${ch.name}.` : `A thread off a message in #${ch.name}. Everyone who can see #${ch.name} can read and reply.`}
          </p>
        ),
      },
      closeThread,
    );
  };

  // Search: Ctrl+F (or Ctrl+K) searches what's open; the 🔍 in a chat's header does too.
  const searchScope = useSearchOpen();
  const searchHere = () => {
    const cid = viewConversation(viewRef.current, serversRef.current);
    const v = viewRef.current;
    openSearch(v.kind === "channel" ? { serverId: v.serverId, conversationId: cid ?? undefined } : cid ? { conversationId: cid } : {});
  };
  const searchHereRef = useRef(searchHere);
  searchHereRef.current = searchHere;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "k")) {
        e.preventDefault();
        searchHereRef.current();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const openHit = (hit: { conversationId: number; messageId: number; serverId: number | null; channelId: number | null; threadId: number | null }) => {
    closeSearch();
    if (hit.serverId && hit.threadId) void startThread(hit.serverId, 0, hit.threadId);
    else if (hit.serverId && hit.channelId) open({ kind: "channel", serverId: hit.serverId, channelId: hit.channelId });
    else open({ kind: "conversation", id: hit.conversationId });
    requestJump(hit.conversationId, hit.messageId);
  };

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
        <ServerRail
          servers={servers}
          rail={rail}
          onRail={setRail}
          folderAlert={(ids) => {
            const in_ = servers.filter((x) => ids.includes(x.id));
            return { unread: in_.some(serverUnread), mentions: in_.reduce((n, x) => n + serverMentions(x), 0) };
          }}
          renderServer={(sv, extra) => (
            <button
              key={sv.id}
              className={`rail-server ${currentServer?.id === sv.id ? "active" : ""}`}
              title={sv.name}
              aria-label={sv.name}
              onClick={() => openServer(sv)}
              {...extra}
            >
              <ServerIcon server={sv} size={48} />
              {serverUnread(sv) && <span className="rail-dot" aria-label="Unread" />}
              {serverMentions(sv) > 0 && (
                <span className="rail-badge" aria-label={`${serverMentions(sv)} mentions`}>
                  {serverMentions(sv) > 99 ? "99+" : serverMentions(sv)}
                </span>
              )}
            </button>
          )}
        />
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
              if (isVoiceKind(c.kind) && server?.calls) void joinVoice(currentServer, c);
            }}
            onSettings={() => setServerDialog({ kind: "settings", serverId: currentServer.id })}
            automodAlerts={automodAlerts[currentServer.id] ?? 0}
            onModLog={() => {
              setAutomodAlerts((all) => ({ ...all, [currentServer.id]: 0 }));
              setServerDialog({ kind: "settings", serverId: currentServer.id, tab: "modlog" });
            }}
            onInvite={() => setServerDialog({ kind: "invite", serverId: currentServer.id })}
            events={eventsOf(currentServer)}
            onEvents={() => setServerDialog({ kind: "events", serverId: currentServer.id })}
            onWelcome={() => setServerDialog({ kind: "welcome", serverId: currentServer.id })}
            onChannel={(c, channelKind, categoryId) => setServerDialog({ kind: "channel", serverId: currentServer.id, channel: c, channelKind, categoryId })}
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
          <button className="nav-item" onClick={() => setInbox("mentions")}>
            <span className="nav-icon" aria-hidden>
              @
            </span>
            Mentions
          </button>
          <button className="nav-item" onClick={() => setInbox("saved")}>
            <span className="nav-icon" aria-hidden>
              🔖
            </span>
            Saved messages
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
                <Avatar name={solo ? solo.displayName : (c.name ?? "#")} src={solo ? solo.avatar : null} online={solo ? online.has(solo.id) : undefined} dnd={solo ? dnd.has(solo.id) : false} size={32} />
                <span className="nav-text">
                  <span className="ellipsis">{conversationTitle(c, me.id)}</span>
                  {c.isGroup && <span className="muted small">{c.members.length} members</span>}
                  {solo && <StatusLine user={solo} filter={profileFilter} />}
                  {solo && <ActivityLine userId={solo.id} />}
                </span>
                <UnreadBadge u={unread.get(c.id)} />
              </button>
            );
          })}
        </div>
        </>
        )}
        <footer className="me">
          <button className="ghost me-profile" onClick={() => setProfileTarget({ userId: me.id })} title="Your profile and status" aria-label="Your profile and status">
            <Avatar
              name={me.displayName}
              src={me.avatar}
              online={connected && me.presence !== "invisible"}
              dnd={connected && me.presence === "dnd"}
              size={36}
              title={!connected ? "Reconnecting…" : me.presence === "dnd" ? "Do not disturb" : me.presence === "invisible" ? "Invisible" : "Online"}
            />
            <span className="me-names">
              <strong className="ellipsis">{me.displayName}</strong>
              <StatusLine user={me} className="muted small ellipsis" />
              {!me.status && <span className="muted">@{me.username}</span>}
            </span>
          </button>
          <PresencePicker me={me} onChange={(m) => setMe((cur) => ({ ...cur, ...m, publicKey: cur.publicKey ?? m.publicKey }))} />
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
            picturesAllowed={!me.isKid || !!family?.rules?.profilePictures}
            keyState={keyState}
            onEncryption={(mode) => setEncryptionDialog(mode)}
            onFamily={() => setShowFamily(true)}
            onDeleted={onSignedOut}
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
              live={voice[inVoice.voice.channelId]}
              event={events.find((x) => x.channelId === inVoice.voice.channelId && x.status === "live")}
              server={servers.find((x) => x.id === inVoice.voice.serverId)}
              channel={servers.find((x) => x.id === inVoice.voice.serverId)?.channels.find((c) => c.id === inVoice.voice.channelId)}
              compact={!(view.kind === "channel" && view.channelId === inVoice.voice.channelId)}
              onOpen={() => open({ kind: "channel", serverId: inVoice.voice.serverId, channelId: inVoice.voice.channelId })}
              onLeft={() => setInVoice(null)}
              onSpeakers={(ids) => setSpeaking(new Set(ids))}
              watchYoutube={!!server?.watchYoutube}
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
        {currentServer && currentChannel && channelConversation && currentChannel.kind === "forum" && !currentThread && (
          <ForumView
            key={currentChannel.id}
            server={currentServer}
            channel={currentChannel}
            threads={Object.values(threads)}
            onLoaded={addThreads}
            onOpen={(t) => openThread(currentServer.id, t)}
            onBack={() => setShowMain(false)}
            canPost={
              kidRules && !kidRules.status.allowedNow
                ? (kidRules.status.reason ?? "Chat time is over for now.")
                : currentServer.timedOutUntil && Date.parse(currentServer.timedOutUntil) > Date.now()
                  ? "You're timed out in this server"
                  : null
            }
            onPins={() => setPinsOpen({ serverId: currentServer.id, channelId: currentChannel.id })}
          />
        )}
        {currentServer && currentChannel && channelConversation && currentChannel.kind === "forum" && currentThread && threadChat(currentServer, currentChannel, currentThread)}
        {currentServer && currentChannel && channelConversation && currentChannel.kind !== "forum" && (
          <div className={`channel-split ${currentThread ? "with-thread" : ""}`}>
            {channelChat(channelConversation, {
              serverId: currentServer.id,
              topic: currentChannel.topic,
              canModerate: can(currentServer, "deleteMessages"),
              timedOutUntil: currentServer.timedOutUntil,
              canPin: canPinIn(currentServer, currentChannel),
              readOnly: currentChannel.canPost === false ? "Only some people can post in this channel. You can still read it and react." : null,
              slowmode: can(currentServer, "manageChannels") || can(currentServer, "deleteMessages") ? 0 : (currentChannel.slowmode ?? 0),
              onPins: () => setPinsOpen({ serverId: currentServer.id, channelId: currentChannel.id }),
              onThread: (m) => void startThread(currentServer.id, m.id, m.thread?.id),
              voice: isVoiceKind(currentChannel.kind)
                ? {
                    count: voice[currentChannel.id]?.members.length ?? 0,
                    inIt: inVoice?.voice.channelId === currentChannel.id,
                    enabled: !!server?.calls,
                    onJoin: () => void joinVoice(currentServer, currentChannel),
                    stage: currentChannel.kind === "stage",
                  }
                : undefined,
            })}
            {currentThread && threadChat(currentServer, currentChannel, currentThread)}
          </div>
        )}
        {view.kind === "friends" && <Friends friends={friends} online={online} dnd={dnd} onMessage={messageFriend} onBack={() => setShowMain(false)} />}
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
      {searchScope && (
        <SearchPanel
          me={me}
          scope={searchScope}
          conversations={conversations}
          servers={servers}
          filter={kidRules?.rules.profanityFilter ? kidRules.rules.blockedWords : null}
          onOpen={openHit}
          onClose={closeSearch}
        />
      )}
      {inbox && (
        <InboxPanel
          me={me}
          tab={inbox}
          conversations={conversations}
          servers={servers}
          filter={kidRules?.rules.profanityFilter ? kidRules.rules.blockedWords : null}
          onOpen={(t) => {
            setInbox(null);
            openHit(t);
          }}
          onClose={() => setInbox(null)}
        />
      )}
      {forwarding && (
        <ForwardDialog
          me={me}
          message={forwarding}
          conversations={conversations}
          servers={servers}
          onDone={(where) => {
            startForward(null);
            setToast(`Forwarded to ${where}`);
          }}
          onClose={() => startForward(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
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
      {me.couplesKit && !me.isKid && <LoveNotePopup me={me} conversations={conversations} />}
      {encryptionDialog && (
        <EncryptionDialog me={me} mode={encryptionDialog} setMode={setEncryptionDialog} onDone={onUnlocked} onClose={() => setEncryptionDialog(null)} />
      )}
      {ringing && !dialog && !nativeRinging && (
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
      {eventReminder && !ringing && !dialog && inVoice?.voice.channelId !== eventReminder.event.channelId && (() => {
        const sv = servers.find((x) => x.id === eventReminder.event.serverId);
        if (!sv) return null;
        return (
          <EventReminderCard
            event={eventReminder.event}
            minutes={eventReminder.minutes}
            server={sv}
            callsEnabled={!!server?.calls}
            onClose={() => setEventReminder(null)}
            onOpen={() => {
              setEventReminder(null);
              setServerDialog({ kind: "events", serverId: sv.id });
            }}
            onJoin={(ch) => {
              setEventReminder(null);
              open({ kind: "channel", serverId: sv.id, channelId: ch.id });
              void joinVoice(sv, ch);
            }}
          />
        );
      })()}
      {serverDialog?.kind === "events" && dialogServer && (
        <EventsDialog
          server={dialogServer}
          events={eventsOf(dialogServer)}
          callsEnabled={!!server?.calls}
          onClose={() => setServerDialog(null)}
          onJoin={(ch) => {
            setServerDialog(null);
            open({ kind: "channel", serverId: dialogServer.id, channelId: ch.id });
            void joinVoice(dialogServer, ch);
          }}
        />
      )}
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
      {pinsOpen && servers.find((x) => x.id === pinsOpen.serverId) && (
        <PinsDialog
          server={servers.find((x) => x.id === pinsOpen.serverId)!}
          channelId={pinsOpen.channelId}
          version={pinsVersion}
          onClose={() => setPinsOpen(null)}
          onJump={(p) => {
            const sv = servers.find((x) => x.id === pinsOpen.serverId)!;
            setPinsOpen(null);
            if (p.threadId) void startThread(sv.id, p.message.id, p.threadId);
            else open({ kind: "channel", serverId: sv.id, channelId: p.channelId });
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
          categoryId={serverDialog.categoryId}
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
      {serverDialog?.kind === "welcome" && dialogServer && (
        <WelcomeScreen
          me={me}
          server={dialogServer}
          onClose={() => {
            welcomeLater.current.add(dialogServer.id);
            setServerDialog(null);
          }}
          onDone={(sv) => {
            setServers((list) => list.map((x) => (x.id === sv.id ? sv : x)));
            setServerDialog(null);
          }}
        />
      )}
      {levelUp && !ringing && (() => {
        const sv = servers.find((x) => x.id === levelUp.serverId);
        return sv ? <LevelUpCard server={sv} level={levelUp.level} rank={levelUp.rank} rankUp={levelUp.rankUp} onClose={() => setLevelUp(null)} /> : null;
      })()}
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
      {profileTarget && (
        <ProfileCard
          key={`${profileTarget.userId}:${profileTarget.serverId ?? ""}`}
          target={profileTarget}
          me={me}
          known={knownUser(profileTarget.userId)}
          servers={servers}
          online={online}
          filter={profileFilter}
          onClose={() => setProfileTarget(null)}
          onMessage={(u) => {
            setProfileTarget(null);
            void messageFriend(u);
          }}
          onEdit={() => {
            setProfileTarget(null);
            setEditingProfile(true);
          }}
          onOpenServer={(id) => {
            setProfileTarget(null);
            const sv = servers.find((x) => x.id === id);
            if (sv) openServer(sv);
          }}
        />
      )}
      {editingProfile && (
        <ProfileEditorDialog
          me={me}
          picturesAllowed={!me.isKid || !!family?.rules?.profilePictures}
          onSaved={(m) => setMe(m)}
          onClose={() => setEditingProfile(false)}
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
          <ExpressionsContext.Provider value={expressions}>
            <ProfileContext.Provider value={setProfileTarget}>{shell}</ProfileContext.Provider>
          </ExpressionsContext.Provider>
        </ChoresContext.Provider>
      </ActivityContext.Provider>
    </LootdenUrlContext.Provider>
  );
}
