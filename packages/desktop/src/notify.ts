import type { Conversation, ServerEvent } from "@dendrop/shared";

/** What a notification says. Never the message text: it may show on a lock screen or be read over a shoulder. */
export interface NotificationContent {
  title: string;
  body: string;
  /** The conversation it's about, so repeats can be grouped. */
  conversationId?: number;
}

export interface NotifyOptions {
  meId: number;
  notifySender: boolean;
  /** Looks up a conversation (for the sender's or group's name); undefined when unknown. */
  conversation: (id: number) => Conversation | undefined;
}

/**
 * Turns a gateway event into a notification, or null when it shouldn't notify: your own
 * messages, edits, deletions, typing and presence. Only names and counts are ever shown.
 */
export function notificationFor(event: ServerEvent, o: NotifyOptions): NotificationContent | null {
  if (event.type === "message.created") {
    const m = event.message;
    if ((m.authorId === o.meId && !m.webhook) || m.deleted) return null;
    // The server says when someone's notification settings don't want this one (muted, or
    // "only mentions" and it isn't one). Older servers don't say: notify.
    if (event.notify === false) return null;
    let body = "New message";
    if (o.notifySender) {
      const c = o.conversation(m.conversationId);
      // A webhook's messages are shown under its own name, not its maker's.
      const author = m.webhook ? { displayName: m.webhook.name } : c?.members.find((u) => u.id === m.authorId);
      if (c?.isGroup && c.name) body = author ? `New message from ${author.displayName} in ${c.name}` : `New message in ${c.name}`;
      else if (author) body = `New message from ${author.displayName}`;
    }
    return { title: "Dendrop", body, conversationId: m.conversationId };
  }
  if (event.type === "friend.updated" && event.friend.state === "incoming") {
    return { title: "Dendrop", body: o.notifySender ? `${event.friend.user.displayName} sent you a friend request` : "New friend request" };
  }
  return null;
}

/**
 * Collapses bursts: a run of messages in one conversation notifies once, then again only
 * after `quietMs` without a notification for it.
 */
export class Throttle {
  private readonly last = new Map<string, number>();
  constructor(private readonly quietMs = 15_000) {}

  allow(key: string, now = Date.now()): boolean {
    const prev = this.last.get(key);
    this.last.set(key, now);
    return prev === undefined || now - prev >= this.quietMs;
  }
}

/** The bits of a WebSocket the watcher uses, so tests can drive it. */
export interface SocketLike {
  on(event: "open", fn: () => void): unknown;
  on(event: "message", fn: (data: unknown) => void): unknown;
  on(event: "close", fn: (code: number) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

export interface WatcherDeps {
  /** The server's origin, or "" when none is set. */
  origin(): string;
  /** The Cookie header for the server (the session the window signed in with), or "" if signed out. */
  cookies(origin: string): Promise<string>;
  open(url: string, headers: Record<string, string>): SocketLike;
  onEvent(event: ServerEvent, meId: number): void;
  /** Tells the app whether it has a live connection (for the tray). */
  onStatus?(online: boolean): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const SIGNED_OUT = 4401;
const OPEN = 1;

/**
 * Keeps the app's own connection to the gateway, with the window's sign-in, so new messages
 * notify even while the window is closed to the tray. Reconnects with backoff; when the server
 * says "sign in first" it waits for poke() (the session cookie changing) instead of retrying fast.
 */
export class GatewayWatcher {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private ping: unknown = null;
  private delay = 1000;
  private stopped = true;
  private meId = 0;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;

  constructor(private readonly deps: WatcherDeps) {
    this.setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  start(): void {
    this.stopped = false;
    if (!this.socket && !this.timer) void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }

  /** Something changed (sign-in, server address): reconnect now. */
  poke(): void {
    if (this.stopped) return;
    this.reset();
    this.delay = 1000;
    void this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN && this.meId > 0;
  }

  private reset(): void {
    if (this.timer) this.clearT(this.timer);
    if (this.ping) this.clearT(this.ping);
    this.timer = this.ping = null;
    const s = this.socket;
    this.socket = null;
    this.meId = 0;
    s?.close();
  }

  private retry(ms: number): void {
    if (this.stopped || this.timer) return;
    this.timer = this.setT(() => {
      this.timer = null;
      void this.connect();
    }, ms);
  }

  private async connect(): Promise<void> {
    const origin = this.deps.origin();
    if (this.stopped || !origin) return;
    const cookie = await this.deps.cookies(origin).catch(() => "");
    if (this.stopped || this.socket || this.timer) return;
    // Signed out: nothing to listen for until the window signs in (poke), but look again now and then.
    if (!cookie) return this.retry(5 * 60_000);
    const url = `${origin.replace(/^http/, "ws")}/api/gateway`;
    let socket: SocketLike;
    try {
      socket = this.deps.open(url, { Cookie: cookie });
    } catch {
      return this.retry(this.backoff());
    }
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.delay = 1000;
      this.ping = this.setT(() => this.sendPing(socket), 25_000);
    });
    socket.on("message", (data) => {
      if (socket !== this.socket) return;
      let event: ServerEvent;
      try {
        event = JSON.parse(String(data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "ready") {
        this.meId = event.user.id;
        this.deps.onStatus?.(true);
        return;
      }
      if (this.meId) this.deps.onEvent(event, this.meId);
    });
    socket.on("error", () => {});
    socket.on("close", (code) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.meId = 0;
      if (this.ping) this.clearT(this.ping);
      this.ping = null;
      this.deps.onStatus?.(false);
      this.retry(code === SIGNED_OUT ? 5 * 60_000 : this.backoff());
    });
  }

  private sendPing(socket: SocketLike): void {
    if (socket !== this.socket) return;
    if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "ping" }));
    this.ping = this.setT(() => this.sendPing(socket), 25_000);
  }

  private backoff(): number {
    const d = this.delay;
    this.delay = Math.min(this.delay * 2, 60_000);
    return d;
  }
}
