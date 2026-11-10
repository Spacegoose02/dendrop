/**
 * The iPhone app (packages/ios) runs this web client inside its WebView and rings calls on
 * iOS's own call screen (CallKit). This is the small bridge to it. In a browser, the PC app and
 * the Android app it does nothing.
 */

interface CapacitorBridge {
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
  nativeCallback?: (plugin: string, method: string, options: object, callback: (data: unknown, error?: unknown) => void) => string;
}

const bridge = (): CapacitorBridge | undefined => (window as { Capacitor?: CapacitorBridge }).Capacitor;

/** True inside the iPhone app. */
export function inIosApp(): boolean {
  const c = bridge();
  return c?.getPlatform?.() === "ios" && !!c.nativePromise && !!c.isPluginAvailable?.("Dendrop");
}

export interface NativeAnswer {
  /** Missing when the app couldn't tell which call it was (then: the one ringing). */
  conversationId?: number;
  video: boolean;
}

export interface NativeCallHandlers {
  /** Answered on the call screen: join that call. */
  onAnswered: (a: NativeAnswer) => void;
  /** Declined or hung up on the call screen (the app already told the server). */
  onEnded: (conversationId: number) => void;
}

/**
 * Starts listening to the call screen. Resolves with whether iOS rings for calls (so the page
 * shouldn't ring as well), and hands over a call that was answered before the page loaded.
 */
export async function connectNativeCalls(handlers: NativeCallHandlers): Promise<{ ringsNatively: boolean }> {
  const c = bridge();
  if (!inIosApp() || !c?.nativeCallback || !c.nativePromise) return { ringsNatively: false };
  c.nativeCallback("Dendrop", "addListener", { eventName: "callAnswered" }, (data) => {
    if (!data) return;
    // The app also keeps the answer for a page that wasn't loaded yet; this page has it now.
    c.nativePromise?.("Dendrop", "nativeCalls", {}).catch(() => {});
    handlers.onAnswered(data as NativeAnswer);
  });
  c.nativeCallback("Dendrop", "addListener", { eventName: "callEnded" }, (data) => {
    const cid = (data as { conversationId?: number } | null)?.conversationId;
    if (typeof cid === "number") handlers.onEnded(cid);
  });
  try {
    const state = (await c.nativePromise("Dendrop", "nativeCalls", {})) as { ringsNatively?: boolean; answered?: NativeAnswer };
    if (state.answered) handlers.onAnswered(state.answered);
    return { ringsNatively: !!state.ringsNatively };
  } catch {
    return { ringsNatively: false };
  }
}

/** Tells the app the page joined or left a call, so iOS shows it as a call and keeps it going with the screen off. */
export function reportCallState(conversationId: number | null, inCall: boolean): void {
  const c = bridge();
  if (!inIosApp() || !c?.nativePromise) return;
  c.nativePromise("Dendrop", "callState", { conversationId: conversationId ?? undefined, inCall }).catch(() => {});
}

/** True inside the Android app (with its native Dendrop plugin, which can make chat bubbles). */
export function inAndroidApp(): boolean {
  const c = bridge();
  return c?.getPlatform?.() === "android" && !!c.nativePromise && !!c.isPluginAvailable?.("Dendrop");
}

/**
 * Opens a chat in an Android chat bubble. Resolves null when it showed, or why it couldn't:
 * an older Android, notifications off, or bubbles turned off for the app.
 */
export async function openBubble(conversationId: number, title: string): Promise<string | null> {
  const c = bridge();
  if (!inAndroidApp() || !c?.nativePromise) return "Chat bubbles need the Android app.";
  try {
    const r = (await c.nativePromise("Dendrop", "bubble", { conversationId, title })) as { ok: boolean; reason?: string };
    if (r.ok) return null;
    if (r.reason === "unsupported") return "Chat bubbles need Android 11 or newer.";
    if (r.reason === "notifications-off") return "Turn on notifications for Dendrop to use chat bubbles.";
    if (r.reason === "bubbles-off") return "Bubbles are off for Dendrop. Turn them on in Android's settings for the app (Notifications, Bubbles).";
    return "Couldn't open a bubble.";
  } catch (err) {
    // An older app without bubbles.
    return (err as Error).message || "Update the Dendrop app to use chat bubbles.";
  }
}
