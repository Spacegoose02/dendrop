import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  findBlockedWords,
  INLINE_IMAGE_TYPES,
  LIMITS,
  maskBlockedWords,
  type Attachment,
  type Call,
  type Conversation,
  type GameKind,
  type KidRules,
  type KidStatus,
  type Me,
  type Message,
  type NudgeKind,
  type Reaction,
} from "@dendrop/shared";
import { api, apiForm, ApiError } from "./api.ts";
import {
  ExpressionPicker,
  fromTokens,
  GifView,
  gifIn,
  Reactions,
  RichText,
  stickerIn,
  StickerView,
  suggest,
  toTokens,
  usableEmoji,
  useExpressions,
} from "./expressions.tsx";
import { ActivityLine } from "./activity.tsx";
import { GameLinks } from "./GameLink.tsx";
import { MessageButtons } from "./Bots.tsx";
import { AudioPlayer, FunMenu, GameCard, NudgeCard, PollCard, PollDialog, RemindMenu, slashCommand, VoiceRecorder, type NewPoll } from "./Fun.tsx";
import { Avatar } from "./Avatar.tsx";
import { ProfileLink, StatusLine } from "./Profile.tsx";
import { decryptFile, encryptFile, encryptMessage, keyring, reveal, type ChatMessage, type FileMeta } from "./e2ee.ts";
import { EncryptionInfo } from "./EncryptionInfo.tsx";
import { CouplesKitDialog, useCouplesKit } from "./Couples.tsx";
import { useColors } from "./colors.ts";
import { conversationTitle, upsert, type History } from "./util.ts";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

/** Messages from the same person within 5 minutes share one header. */
const continues = (prev: ChatMessage | undefined, m: ChatMessage) =>
  !!prev && prev.authorId === m.authorId && prev.webhook?.name === m.webhook?.name && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && day(prev.createdAt) === day(m.createdAt);

/** What Chat needs to know when it shows a server channel instead of a DM. */
export interface ChannelInfo {
  serverId: number;
  topic: string;
  /** The owner and admins can delete anyone's message. */
  canModerate: boolean;
  /** Set while you're timed out in this server: you can read but not post. */
  timedOutUntil?: string | null;
  /** Set for a voice channel: its text chat shows here, with a button to drop into the voice. */
  voice?: { count: number; inIt: boolean; enabled: boolean; onJoin: () => void; stage?: boolean };
  /** The mark before the title (a thread shows 🧵). Defaults to # or 🔊. */
  icon?: string;
  /** Starts or opens the thread off a message. Unset inside a thread (threads don't nest). */
  onThread?: (m: Message) => void;
  /** Whether you can pin and unpin messages here. */
  canPin?: boolean;
  /** Opens the pinned board. */
  onPins?: () => void;
  /** Set when you can't post here (a closed thread): why. */
  readOnly?: string | null;
  /** Extra buttons for the header (a thread's close and rename). */
  actions?: ReactNode;
  /** What the start of the history says instead of the channel's usual line. */
  intro?: ReactNode;
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
  kid,
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
  /** Set when this is a kid account: the family filter and whether chat time is on. */
  kid?: { rules: KidRules; status: KidStatus } | null;
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
  /** The emoji, GIF and sticker picker under the composer, or the reaction picker on a message. */
  const [picker, setPicker] = useState<"composer" | "gifs" | { reactTo: number; above: boolean } | null>(null);
  /** Opens the reaction picker on a message: above it in the lower half of the screen, below it in the upper half. */
  const openReactions = (messageId: number, from: Element) => {
    const open = typeof picker === "object" && picker?.reactTo === messageId;
    setPicker(open ? null : { reactTo: messageId, above: from.getBoundingClientRect().top > window.innerHeight / 2 });
  };
  /** Where to put the cursor once the draft has re-rendered (after inserting an emoji). */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [draft]);
  /** Which ":name" suggestion is picked while typing one. */
  const [suggestAt, setSuggestAt] = useState(0);
  const expressions = useExpressions();
  const emojis = usableEmoji(expressions.servers, channel?.serverId);
  // Kids get GIFs only once a parent allows them (the server checks too).
  const gifsOn = expressions.gifs && (!kid || kid.rules.gifs);
  const [dragging, setDragging] = useState(false);
  const lastMarked = useRef(0);
  const [showInfo, setShowInfo] = useState(false);
  // The couples kit: only for 1:1 chats between two adult accounts (the server checks too).
  const couplesPossible = !channel && !conversation.isGroup && !me.isKid && !kid && conversation.members.length === 2 && conversation.guardians.length === 0;
  const { kit: couplesKit } = useCouplesKit(conversation.id, couplesPossible);
  const showCouples = couplesPossible && !!couplesKit?.eligible;
  const couplesAsked = couplesKit?.state === "invited" && couplesKit.invitedBy !== me.id;
  const [couplesOpen, setCouplesOpen] = useState(false);
  /** Messages whose filtered words were already reported to the kid's parents. */
  const reported = useRef(new Set<number>());
  const [helpSent, setHelpSent] = useState(false);
  /** The polls and games menu, the poll maker, the reminder menu on a message, and the voice recorder. */
  const [funOpen, setFunOpen] = useState(false);
  const [pollDraft, setPollDraft] = useState<Partial<NewPoll> | null>(null);
  const [remindFor, setRemindFor] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  /** A raccoon nudge just came in: shake the chat for a moment. */
  const [shake, setShake] = useState(false);
  const shookFor = useRef(new Set<number>());
  const filter = kid?.rules.profanityFilter ? kid.rules.blockedWords : null;
  const timeUp = kid && !kid.status.allowedNow ? (kid.status.reason ?? "Chat time is over for now.") : null;
  // A server timeout ends on its own: re-render when it does.
  const [, setTick] = useState(0);
  const timedOutUntil = channel?.timedOutUntil && Date.parse(channel.timedOutUntil) > Date.now() ? channel.timedOutUntil : null;
  useEffect(() => {
    if (!timedOutUntil) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(Date.parse(timedOutUntil) - Date.now() + 500, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [timedOutUntil]);
  /** Tells the kid's parents about a filtered word (never which one), which opens this chat to them. */
  const report = (type: "profanity" | "help") =>
    api(`/api/family/alerts`, { body: { type, conversationId: conversation.id } }).catch(() => {});

  const members = new Map(conversation.members.map((m) => [m.id, m]));
  const colorsOf = useColors();
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
    // Every change to the list (new messages, reactions growing the last one) while at the bottom.
  }, [history?.messages, typingIds.length]);

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

  const newestMessage = history?.messages.at(-1);
  useEffect(() => {
    const m = newestMessage;
    if (!m?.nudge || m.authorId === me.id || shookFor.current.has(m.id) || Date.now() - Date.parse(m.createdAt) > 15_000) return;
    shookFor.current.add(m.id);
    setShake(true);
    const t = setTimeout(() => setShake(false), 800);
    return () => clearTimeout(t);
  }, [newestMessage, me.id]);

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
    setPicker(null);
    pendingCaret.current = start + emoji.length;
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
    const cmd = files.length === 0 ? slashCommand(draft) : null;
    if (cmd) {
      setDraft("");
      if (cmd.kind === "game") void startGame(cmd.game, cmd.dice);
      else if (cmd.kind === "poll") setPollDraft({ question: cmd.question });
      else if (channel) setError("Nudges are for DMs and group chats.");
      else void sendNudge(cmd.nudge);
      return;
    }
    const body = toTokens(draft.trim(), emojis);
    if ((!body && files.length === 0) || sending) return;
    if (filter && findBlockedWords(body, filter).length) {
      setError("That message has a word your family filter blocks. Your parents get a heads-up (not the word).");
      void report("profanity");
      return;
    }
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
      setDraft(fromTokens(body, emojis));
      setFiles(sendingFiles);
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  /** Sends a sticker, a GIF or a voice message as a message of its own, leaving the draft alone. */
  const sendOnly = async (body: string, extraFiles: File[] = []) => {
    setPicker(null);
    setError(null);
    stickToBottom.current = true;
    try {
      let m: Message;
      try {
        m = await post(conversation, body, extraFiles);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        m = await post(await api<Conversation>(`/api/conversations/${conversation.id}`), body, extraFiles);
      }
      const shown = await reveal(m);
      setHistory((h) => (h ? { ...h, messages: upsert(h.messages, shown) } : { messages: [shown], hasMore: false }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** Shows a poll, game or nudge the server just sent back (the gateway brings it too). */
  const showChanged = async (raw: Message) => {
    const shown = await reveal(raw);
    setHistory((h) => (h ? { ...h, messages: upsert(h.messages, shown) } : { messages: [shown], hasMore: false }));
  };

  /** Posts a poll: its words are encrypted like a message once the chat has a key. */
  const createPoll = async (p: NewPoll) => {
    if (filter && findBlockedWords([p.question, ...p.options].join("\n"), filter).length) {
      void report("profanity");
      throw new Error("That poll has a word your family filter blocks. Your parents get a heads-up (not the word).");
    }
    stickToBottom.current = true;
    const make = async (c: Conversation) => {
      const url = `/api/conversations/${c.id}/polls`;
      const settings = { multi: p.multi, closesInMinutes: p.closesInMinutes };
      const version = channel ? null : await keyring.forSending(c);
      if (!version) return api<Message>(url, { body: { ...settings, question: p.question, options: p.options } });
      const body = await encryptMessage(c.id, me.id, version, p.question, [], p.options);
      return api<Message>(url, { body: { ...settings, body, keyVersion: version, optionCount: p.options.length } });
    };
    let m: Message;
    try {
      m = await make(conversation);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
      m = await make(await api<Conversation>(`/api/conversations/${conversation.id}`));
    }
    await showChanged(m);
  };

  const startGame = async (kind: GameKind, dice?: string) => {
    setError(null);
    stickToBottom.current = true;
    try {
      await showChanged(await api<Message>(`/api/conversations/${conversation.id}/games`, { body: { kind, dice } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const sendNudge = async (kind: NudgeKind) => {
    setError(null);
    stickToBottom.current = true;
    try {
      await showChanged(await api<Message>(`/api/conversations/${conversation.id}/nudges`, { body: { kind } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** Adds your reaction, or takes it back. */
  const toggleReaction = async (m: ChatMessage, emoji: string, mine: boolean) => {
    setPicker(null);
    try {
      const reactions = await api<Reaction[]>(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, { method: mine ? "DELETE" : "PUT" });
      setHistory((h) => (h ? { ...h, messages: h.messages.map((x) => (x.id === m.id ? { ...x, reactions } : x)) } : { messages: [], hasMore: true }));
    } catch (err) {
      setError((err as Error).message);
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
    if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      pickSuggestion(suggestions[Math.min(suggestAt, suggestions.length - 1)]!.insert);
      return;
    }
    if (suggestions.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      setSuggestAt((i) => (i + (e.key === "ArrowUp" ? suggestions.length - 1 : 1)) % suggestions.length);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "ArrowUp" && !draft) {
      const mine = [...(history?.messages ?? [])].reverse().find((m) => m.authorId === me.id && !m.webhook && !m.deleted && !m.locked);
      if (mine) {
        e.preventDefault();
        setEditing({ id: mine.id, text: fromTokens(mine.text, emojis) });
      }
    }
  };

  // ":rac" before the cursor offers matching emoji.
  const caret = inputRef.current?.selectionStart ?? draft.length;
  const typed = /(?:^|\s):([A-Za-z0-9_]{2,32})$/.exec(draft.slice(0, caret));
  const suggestions = typed ? suggest(typed[1]!, emojis) : [];
  const pickSuggestion = (insert: string) => {
    if (!typed) return;
    const start = caret - typed[1]!.length - 1;
    const text = draft.slice(0, start) + insert + " " + draft.slice(caret);
    setDraft(text);
    setSuggestAt(0);
    pendingCaret.current = start + insert.length + 1;
  };

  const onDraft = (text: string) => {
    setDraft(text);
    setSuggestAt(0);
    if (text && Date.now() - lastTypingSent.current > 3000) {
      lastTypingSent.current = Date.now();
      sendTyping();
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = toTokens(editing.text.trim(), emojis);
    const original = history?.messages.find((m) => m.id === editing.id);
    setEditing(null);
    if (!text || !original || text === original.text) return;
    if (filter && findBlockedWords(text, filter).length) {
      setError("That edit has a word your family filter blocks.");
      void report("profanity");
      return;
    }
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
    if (!confirm(kid ? "Delete this message? Your parents get a copy of deleted messages." : "Delete this message? It can't be brought back.")) return;
    try {
      // Moderators remove other people's channel messages through the server's own route.
      const url = channel && (m.authorId !== me.id || m.webhook) ? `/api/servers/${channel.serverId}/messages/${m.id}` : `/api/messages/${m.id}`;
      await api<Message>(url, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const messages = history?.messages ?? [];
  // "Seen" goes under my newest message that someone else has read.
  const myLast = [...messages].reverse().find((m) => m.authorId === me.id && !m.webhook);
  const seenBy = myLast
    ? conversation.reads.filter((r) => r.userId !== me.id && r.messageId !== null && r.messageId >= myLast.id).map((r) => members.get(r.userId)?.displayName ?? "Someone")
    : [];
  const canReact = !timeUp && !timedOutUntil;
  const togglePin = async (m: ChatMessage) => {
    try {
      await api(`/api/messages/${m.id}/pin`, { method: m.pinned ? "DELETE" : "PUT" });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const nameOf = (id: number) => members.get(id)?.displayName ?? "Someone";
  const typingNames = typingIds.filter((id) => id !== me.id).map((id) => members.get(id)?.displayName ?? "Someone");

  return (
    <section className={`pane chat ${shake ? "nudged" : ""}`}>
      <header className="pane-header">
        <button className="ghost back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        {channel ? (
          <span className="channel-hash" aria-hidden>
            {channel.icon ?? (channel.voice ? (channel.voice.stage ? "🎙️" : "🔊") : "#")}
          </span>
        ) : !conversation.isGroup && others[0] ? (
          <ProfileLink userId={others[0].id}>
            <Avatar name={others[0].displayName} src={others[0].avatar} online={online.has(others[0].id)} size={28} />
          </ProfileLink>
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
        ) : conversation.isGroup ? (
          <span className="muted small">{conversation.members.length} members</span>
        ) : (
          others[0] && (
            <>
              <StatusLine user={others[0]} filter={filter} />
              <ActivityLine userId={others[0].id} />
            </>
          )
        )}
        {(channel?.onPins || channel?.actions) && (
          <span className="header-actions">
            {channel.actions}
            {channel.onPins && (
              <button className="ghost icon" onClick={channel.onPins} title="Pinned messages" aria-label="Pinned messages">
                📌
              </button>
            )}
          </span>
        )}
        {channel?.voice?.enabled && !channel.voice.inIt && (
          <span className="header-actions">
            <button className="accept small-button" onClick={channel.voice.onJoin}>
              {channel.voice.stage
                ? channel.voice.count > 0
                  ? `Join stage (${channel.voice.count})`
                  : "Join stage"
                : channel.voice.count > 0
                  ? `Join voice (${channel.voice.count})`
                  : "Join voice"}
            </button>
          </span>
        )}
        {(showCouples || (callsEnabled && !inThisCall)) && (
          <span className="header-actions">
            {showCouples && (
              <button
                className="ghost icon couples-button"
                onClick={() => setCouplesOpen(true)}
                title={couplesAsked ? `${others[0]?.displayName} asked to turn on the couples kit` : "Couples kit"}
                aria-label="Couples kit"
              >
                💞{couplesAsked && <span className="dot" />}
              </button>
            )}
            {callsEnabled &&
              !inThisCall &&
              (call && call.joined.length > 0 ? (
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
              ))}
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
            {channel?.intro ? (
              channel.intro
            ) : channel ? (
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
          const author = m.webhook ? undefined : members.get(m.authorId);
          const authorName = m.webhook ? m.webhook.name : (author?.displayName ?? "Someone who left");
          const mine = m.authorId === me.id && !m.webhook;
          // Your own colors come from your account, so a change shows here straight away.
          const colors = m.webhook ? {} : colorsOf(mine ? me : author);
          const shown = filter && m.text ? maskBlockedWords(m.text, filter) : m.text;
          if (shown !== m.text && !mine && !reported.current.has(m.id)) {
            reported.current.add(m.id);
            void report("profanity");
          }
          return (
            <div key={m.id}>
              {newDay && <div className="day-sep">{day(m.createdAt)}</div>}
              <div className={`msg ${grouped ? "grouped" : ""}`} tabIndex={!m.deleted ? 0 : undefined}>
                {grouped ? (
                  <span className="msg-time-gutter">{time(m.createdAt)}</span>
                ) : (
                  <ProfileLink userId={m.webhook ? undefined : author?.id} serverId={channel?.serverId} className="msg-avatar">
                    <Avatar name={m.webhook ? m.webhook.name : (author?.displayName ?? "?")} src={m.webhook ? null : author?.avatar} size={36} />
                  </ProfileLink>
                )}
                <div className="msg-content">
                  {!grouped && (
                    <div className="msg-head">
                      <ProfileLink userId={m.webhook ? undefined : author?.id} serverId={channel?.serverId}>
                        <strong style={colors.name}>{authorName}</strong>
                      </ProfileLink>
                      {m.webhook && (
                        <span className="bot-tag" title="Posted by a webhook">
                          app
                        </span>
                      )}
                      {!m.webhook && author?.isBot && (
                        <span className="bot-tag" title="A bot">
                          bot
                        </span>
                      )}
                      <span className="muted small">{time(m.createdAt)}</span>
                      {m.pinned && (
                        <span className="pin-mark small" title="Pinned">
                          📌
                        </span>
                      )}
                    </div>
                  )}
                  {grouped && m.pinned && (
                    <span className="pin-mark small grouped-pin" title="Pinned">
                      📌
                    </span>
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
                      {m.poll ? (
                        <PollCard m={m} meId={me.id} nameOf={nameOf} mask={(t) => (filter ? maskBlockedWords(t, filter) : t)} disabled={!canReact} onChanged={(x) => void showChanged(x)} onError={setError} />
                      ) : m.game ? (
                        <GameCard m={m} meId={me.id} nameOf={nameOf} disabled={!canReact} onChanged={(x) => void showChanged(x)} onError={setError} onRematch={(kind, dice) => void startGame(kind, dice)} />
                      ) : m.nudge ? (
                        <NudgeCard kind={m.nudge} mine={mine} name={authorName} />
                      ) : m.text && stickerIn(m.text) ? (
                        <StickerView {...stickerIn(m.text)!} />
                      ) : m.text && gifIn(m.text) ? (
                        <GifView id={gifIn(m.text)!} link={m.text.trim()} />
                      ) : (
                        m.text && (
                          <p className="msg-body" style={colors.text}>
                            <RichText text={shown} />
                            {m.editedAt && <span className="muted small"> (edited)</span>}
                          </p>
                        )
                      )}
                      {m.text && !m.poll && <GameLinks text={m.text} />}
                      <MessageButtons m={m} />
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
                  {!m.deleted && (
                    <Reactions
                      reactions={m.reactions ?? []}
                      meId={me.id}
                      nameOf={(id) => (id === me.id ? "You" : (members.get(id)?.displayName ?? "Someone"))}
                      onToggle={(emoji, mineR) => void toggleReaction(m, emoji, mineR)}
                      onAdd={(el) => openReactions(m.id, el)}
                      disabled={!canReact}
                    />
                  )}
                  {m.thread && (
                    <button className="thread-chip" onClick={() => channel?.onThread?.(m)} disabled={!channel?.onThread}>
                      <span aria-hidden>🧵</span>
                      <strong className="ellipsis">{m.thread.title}</strong>
                      <span className="muted small">
                        {m.thread.messageCount === 1 ? "1 reply" : `${m.thread.messageCount} replies`}
                        {m.thread.lastMessageAt && ` · ${time(m.thread.lastMessageAt)}`}
                      </span>
                    </button>
                  )}
                  {m.id === myLast?.id && seenBy.length > 0 && (
                    <div className="seen small muted">{conversation.isGroup ? `Seen by ${seenBy.join(", ")}` : "Seen"}</div>
                  )}
                </div>
                {typeof picker === "object" && picker?.reactTo === m.id && (
                  <div className={`reaction-pop ${picker.above ? "above" : "below"}`}>
                    <ExpressionPicker
                      mode="reaction"
                      currentServerId={channel?.serverId}
                      onEmoji={(emoji) => void toggleReaction(m, emoji, !!m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(me.id))}
                      onClose={() => setPicker(null)}
                    />
                  </div>
                )}
                {remindFor === m.id && <RemindMenu messageId={m.id} onDone={setNotice} onClose={() => setRemindFor(null)} />}
                {!m.deleted && editing?.id !== m.id && (
                  <div className="msg-actions">
                    {canReact && !m.locked && channel?.onThread && !m.thread && (
                      <button className="ghost" onClick={() => channel.onThread!(m)} title="Start a thread" aria-label="Start a thread">
                        🧵
                      </button>
                    )}
                    {channel?.canPin && !m.locked && (
                      <button className="ghost" onClick={() => void togglePin(m)} title={m.pinned ? "Unpin" : "Pin to the board"} aria-label={m.pinned ? "Unpin" : "Pin"}>
                        {m.pinned ? "Unpin" : "📌"}
                      </button>
                    )}
                    {canReact && !m.locked && (
                      <button className="ghost" data-picker-toggle onClick={(e) => openReactions(m.id, e.currentTarget)} title="Add a reaction" aria-label="Add a reaction">
                        ☺+
                      </button>
                    )}
                    {!m.locked && (
                      <button className="ghost" data-fun-toggle onClick={() => setRemindFor(remindFor === m.id ? null : m.id)} title="Remind me about this" aria-label="Remind me about this">
                        ⏰
                      </button>
                    )}
                    {mine && !m.locked && !m.poll && !m.game && !m.nudge && (
                      <button className="ghost" onClick={() => setEditing({ id: m.id, text: fromTokens(m.text, emojis) })} title="Edit">
                        Edit
                      </button>
                    )}
                    {(mine || channel?.canModerate) && (
                      <button className="ghost danger" onClick={() => void remove(m)} title="Delete">
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="composer">
        {!channel && <EncryptionBanner me={me} conversation={conversation} keyState={keyState} onEncryption={onEncryption} />}
        {conversation.guardians.length > 0 && (
          <p className="family-banner small">
            👪 {conversation.guardians.map((g) => g.displayName).join(" and ")}{" "}
            {kid
              ? "can read this chat if they get an alert about it."
              : `${conversation.guardians.length > 1 ? "are parents" : "is a parent"} of a kid here, and can read this chat if they get an alert about it.`}
            {kid && (
              <>
                {" "}
                <button
                  className="link"
                  disabled={helpSent}
                  onClick={() => {
                    setHelpSent(true);
                    void report("help");
                  }}
                >
                  {helpSent ? "Asked them to look" : "Ask them to look"}
                </button>
              </>
            )}
          </p>
        )}
        {timeUp && <p className="family-banner small">⏰ {timeUp} You can still read messages.</p>}
        {channel?.readOnly && <p className="family-banner small">🔒 {channel.readOnly}</p>}
        {timedOutUntil && (
          <p className="family-banner small timeout-banner">
            ⏳ You're timed out in this server until{" "}
            {new Date(timedOutUntil).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. You can still read messages.
          </p>
        )}
        {error && <p className="error small">{error}</p>}
        {notice && (
          <p className="small notice" role="status">
            {notice}
          </p>
        )}
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
        {suggestions.length > 0 && (
          <div className="emoji-suggest" role="listbox" aria-label="Emoji">
            {suggestions.map((x, i) => (
              <button
                key={x.label + i}
                role="option"
                aria-selected={i === Math.min(suggestAt, suggestions.length - 1)}
                className={`ghost ${i === Math.min(suggestAt, suggestions.length - 1) ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSuggestion(x.insert);
                }}
              >
                {x.custom ? <RichText inline text={`<${x.custom.animated ? "a" : ""}:${x.custom.name}:${x.custom.id}>`} /> : x.emoji} <span className="small">{x.label}</span>
              </button>
            ))}
          </div>
        )}
        {recording && (
          <VoiceRecorder
            onError={setError}
            onDone={(file) => {
              setRecording(false);
              if (file) void sendOnly("", [file]);
            }}
          />
        )}
        <div className="composer-row" hidden={recording} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <button className="ghost icon" onClick={() => fileRef.current?.click()} title="Add files" aria-label="Add files">
            ＋
          </button>
          <div className="emoji-wrap">
            <button
              className="ghost icon"
              data-fun-toggle
              onClick={() => setFunOpen(!funOpen)}
              disabled={!canReact}
              title="Polls, games and nudges"
              aria-label="Polls, games and nudges"
              aria-expanded={funOpen}
            >
              🎲
            </button>
            {funOpen && (
              <FunMenu
                onPoll={() => setPollDraft({})}
                onGame={(kind, dice) => void startGame(kind, dice)}
                onNudge={channel ? undefined : (kind) => void sendNudge(kind)}
                onClose={() => setFunOpen(false)}
              />
            )}
          </div>
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
            {gifsOn && (
              <button className="ghost icon gif-button" data-picker-toggle onClick={() => setPicker(picker === "gifs" ? null : "gifs")} title="GIFs" aria-label="GIFs" aria-expanded={picker === "gifs"}>
                GIF
              </button>
            )}
            <button
              className="ghost icon"
              data-picker-toggle
              onClick={() => setPicker(picker === "composer" ? null : "composer")}
              title="Emoji, GIFs and stickers"
              aria-label="Emoji, GIFs and stickers"
              aria-expanded={picker === "composer"}
            >
              🙂
            </button>
            {(picker === "composer" || picker === "gifs") && (
              <ExpressionPicker
                key={picker}
                mode="composer"
                initialTab={picker === "gifs" ? "gifs" : "emoji"}
                currentServerId={channel?.serverId}
                onEmoji={insertEmoji}
                onSticker={timeUp || timedOutUntil ? undefined : (token) => void sendOnly(token)}
                onGif={gifsOn && !timeUp && !timedOutUntil ? (link) => void sendOnly(link) : undefined}
                onClose={() => setPicker(null)}
              />
            )}
          </div>
          {!draft.trim() && files.length === 0 && typeof MediaRecorder !== "undefined" && (
            <button className="ghost icon" onClick={() => setRecording(true)} disabled={!!timeUp || !!timedOutUntil || !!channel?.readOnly} title="Record a voice message" aria-label="Record a voice message">
              🎤
            </button>
          )}
          <button className="primary send" onClick={() => void send()} disabled={sending || !!timeUp || !!timedOutUntil || !!channel?.readOnly || (!draft.trim() && files.length === 0)} aria-label="Send">
            {sending ? "…" : "Send"}
          </button>
        </div>
        <div className="typing small muted" aria-live="polite">
          {typingNames.length === 1 && `${typingNames[0]} is typing…`}
          {typingNames.length > 1 && `${typingNames.join(", ")} are typing…`}
        </div>
      </footer>
      {showInfo && <EncryptionInfo me={me} conversation={conversation} onClose={() => setShowInfo(false)} />}
      {pollDraft && <PollDialog encrypted={!channel && !!conversation.e2ee} initial={pollDraft} onCreate={createPoll} onClose={() => setPollDraft(null)} />}
      {couplesOpen && showCouples && <CouplesKitDialog me={me} conversation={conversation} onClose={() => setCouplesOpen(false)} />}
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
export function EncryptedAttachment({ m, a, meta, keyOverride }: { m: ChatMessage; a: Attachment; meta: FileMeta | undefined; keyOverride?: CryptoKey }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = !!meta && INLINE_IMAGE_TYPES.includes(meta.ty);

  useEffect(() => {
    if (!meta || !isImage) return;
    let made: string | null = null;
    let cancelled = false;
    decryptFile(m, a, meta, keyOverride)
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
  }, [m, a, meta, isImage, keyOverride]);

  const download = async () => {
    if (!meta) return;
    try {
      const href = URL.createObjectURL(await decryptFile(m, a, meta, keyOverride));
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
  if (meta.ty.startsWith("audio/")) return <AudioPlayer name={meta.n} load={() => decryptFile(m, a, meta, keyOverride)} />;
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

export function AttachmentView({ a }: { a: Attachment }) {
  if (a.contentType.startsWith("audio/")) {
    return (
      <AudioPlayer
        name={a.name}
        load={async () => {
          const res = await fetch(a.url, { credentials: "same-origin" });
          if (!res.ok) throw new Error(`Download failed (${res.status})`);
          return new Blob([await res.arrayBuffer()], { type: a.contentType });
        }}
      />
    );
  }
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
