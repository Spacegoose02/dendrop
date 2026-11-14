import { inIosApp } from "./native.ts";

/**
 * Pop-out chats: a chat or channel in a small window of its own, apart from the main one. The
 * window loads the app with ?popout=c<conversationId> or ?popout=s<serverId>.<channelId> and
 * shows just that chat.
 */
export type PopoutTarget = { kind: "conversation"; id: number } | { kind: "channel"; serverId: number; channelId: number };

export function parsePopout(search: string): PopoutTarget | null {
  const v = new URLSearchParams(search).get("popout") ?? "";
  let m = /^c(\d+)$/.exec(v);
  if (m) return { kind: "conversation", id: Number(m[1]) };
  m = /^s(\d+)\.(\d+)$/.exec(v);
  if (m) return { kind: "channel", serverId: Number(m[1]), channelId: Number(m[2]) };
  return null;
}

/** What this window shows, when it's a pop-out. */
export const popout: PopoutTarget | null = typeof location === "undefined" ? null : parsePopout(location.search);

/** Phones and tablets have no windows to pop out into. */
export const canPopOut = (): boolean =>
  !popout && !(window as { Capacitor?: unknown }).Capacitor && !inIosApp() && !matchMedia("(pointer: coarse) and (max-width: 900px)").matches;

/**
 * The PC app, when this page runs in it. The page comes from the server but the app is installed
 * on the PC, so a newer server can meet an older app. Apps before pop-outs sent every new window,
 * pop-outs too, to the system browser; only apps that say popOutWindows open them as app windows.
 */
const desktopApp = (): { popOutWindows?: boolean } | undefined => (window as { dendrop?: { popOutWindows?: boolean } }).dendrop;

/** Opens the chat in its own window. Says why it couldn't, for a toast, or null when it did. */
export function popOut(t: PopoutTarget): string | null {
  const app = desktopApp();
  if (app && !app.popOutWindows) return "Update the Dendrop PC app to pop chats out into their own app window.";
  const key = t.kind === "conversation" ? `c${t.id}` : `s${t.serverId}.${t.channelId}`;
  // One window per chat: popping out the same one again brings it to the front.
  const w = window.open(`/?popout=${key}`, `dendrop-${key}`, "popup,width=460,height=720");
  if (!w) return app ? "Couldn't open the pop-out window." : "Your browser blocked the pop-out window. Allow pop-ups for this site and try again.";
  w.focus();
  return null;
}
