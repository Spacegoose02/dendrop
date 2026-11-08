import { useEffect, useRef, useState } from "react";
import { maskBlockedWords, type Activity, type ChatServer, type Me, type Message, type VoiceChannelState, type VoiceJoin } from "@dendrop/shared";
import { api } from "./api.ts";

/**
 * Feeds the PC app's in-game overlay: which voice channel you're in, who's talking, the
 * channel's last few messages and what LootDen says you're playing. The app decides when to
 * show it (see packages/desktop/src/overlay.ts) and sends quick messages typed in it back here.
 * In a browser this does nothing.
 */

interface DesktopOverlay {
  overlayState?: (state: object | null) => Promise<void>;
  onOverlayChat?: (cb: (text: string) => Promise<void>) => () => void;
}
const desktop = (): DesktopOverlay | undefined => (window as unknown as { dendrop?: DesktopOverlay }).dendrop;

/** Messages posted anywhere, so the overlay can keep its channel's latest. Shell sends them in. */
export const overlayMessages = new EventTarget();
export const feedOverlayMessage = (m: Message) => overlayMessages.dispatchEvent(new CustomEvent("message", { detail: m }));

interface Line {
  id: number;
  author: string;
  text: string;
}

const KEEP = 6;

export function useGameOverlay({
  me,
  inVoice,
  live,
  speaking,
  server,
  activity,
  blockedWords,
  canChat,
}: {
  me: Me;
  inVoice: VoiceJoin | null;
  live: VoiceChannelState | undefined;
  speaking: Set<number>;
  server: ChatServer | undefined;
  /** What LootDen says you're playing. */
  activity: Activity | undefined;
  /** For kid accounts with the word filter on: words to hide in what the overlay shows. */
  blockedWords: string[] | null;
  /** You can send in the channel now (not timed out, chat time not over). */
  canChat: boolean;
}): void {
  const bridge = desktop();
  const conversationId = inVoice?.voice.conversationId ?? null;
  const [lines, setLines] = useState<Line[]>([]);
  const nameRef = useRef<(id: number) => string>(() => "Someone");
  const filterRef = useRef(blockedWords);
  filterRef.current = blockedWords;

  const nameOf = (id: number) => {
    const m = server?.members.find((x) => x.user.id === id);
    return m ? (m.nickname ?? m.user.displayName) : id === me.id ? me.displayName : "Someone";
  };
  nameRef.current = nameOf;

  // The channel's newest messages: the last few from history when you join, then live ones.
  useEffect(() => {
    setLines([]);
    if (!bridge?.overlayState || conversationId === null) return;
    const toLine = (m: Message): Line | null => {
      if (m.deleted || m.keyVersion !== null) return null;
      let text = m.body.trim() || (m.attachments.length ? "📎 sent a file" : m.poll ? "📊 started a poll" : "");
      if (!text) return null;
      if (filterRef.current) text = maskBlockedWords(text, filterRef.current);
      return { id: m.id, author: m.webhook?.name ?? nameRef.current(m.authorId), text };
    };
    let cancelled = false;
    void api<{ messages: Message[] } | Message[]>(`/api/conversations/${conversationId}/messages?limit=${KEEP}`)
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r) ? r : r.messages;
        const recent = list.flatMap((m) => toLine(m) ?? []);
        setLines((cur) => [...recent, ...cur.filter((l) => !recent.some((x) => x.id === l.id))].sort((a, b) => a.id - b.id).slice(-KEEP));
      })
      .catch(() => {});
    const onMessage = (e: Event) => {
      const m = (e as CustomEvent<Message>).detail;
      if (m.conversationId !== conversationId) return;
      const line = toLine(m);
      if (line) setLines((cur) => [...cur.filter((l) => l.id !== line.id), line].slice(-KEEP));
    };
    overlayMessages.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      overlayMessages.removeEventListener("message", onMessage);
    };
  }, [bridge, conversationId]);

  // What to show, sent whenever it changes (the app ignores repeats cheaply).
  const channel = inVoice ? server?.channels.find((c) => c.id === inVoice.voice.channelId) : undefined;
  const members = (live ?? inVoice?.voice)?.members ?? [];
  const state = inVoice
    ? {
        channel: channel?.name ?? "voice",
        server: server?.name ?? null,
        members: members.map((m) => ({
          id: m.userId,
          name: nameOf(m.userId),
          speaking: speaking.has(m.userId),
          muted: m.muted,
          deafened: m.deafened,
          screen: m.screen,
          me: m.userId === me.id,
        })),
        messages: lines,
        playing: activity && activity.title !== "a game" ? activity.title : activity ? "a game" : null,
        watching: live?.watch?.current.title ?? null,
        canChat,
      }
    : null;
  const json = JSON.stringify(state);
  useEffect(() => {
    void bridge?.overlayState?.(state).catch(() => {});
    // The JSON stands for the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, json]);

  // Leaving the page (or this hook going away) clears it.
  useEffect(() => () => void bridge?.overlayState?.(null).catch(() => {}), [bridge]);

  // Quick messages typed in the overlay go to the voice channel's chat.
  useEffect(() => {
    if (!bridge?.onOverlayChat || conversationId === null) return;
    return bridge.onOverlayChat(async (text) => {
      await api<Message>(`/api/conversations/${conversationId}/messages`, { body: { body: text } });
    });
  }, [bridge, conversationId]);
}
