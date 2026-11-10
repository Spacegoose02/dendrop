import type { ServerEvent } from "@dendrop/shared";
import type { WebSocket } from "ws";

/** Live WebSocket connections per user, for pushing events. One server process, so in memory. */
export class Gateway {
  private sockets = new Map<number, Set<WebSocket>>();
  /** Bots' listeners (their gateway connections and events addresses), instead of sockets. */
  private sinks = new Map<number, Set<(event: ServerEvent) => void>>();
  /**
   * Connections whose app says it's in the background or left alone (a phone's screen off, a
   * PC nobody's touched). Still connected, but nobody's looking, so phones get a push.
   */
  private idle = new WeakSet<WebSocket>();

  /** Sends a user's events to fn instead of a socket. Returns a function that stops it. */
  addSink(userId: number, fn: (event: ServerEvent) => void): () => void {
    let set = this.sinks.get(userId);
    if (!set) this.sinks.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.sinks.get(userId) === set) this.sinks.delete(userId);
    };
  }

  hasSink(userId: number): boolean {
    return (this.sinks.get(userId)?.size ?? 0) > 0;
  }

  add(userId: number, ws: WebSocket): { firstConnection: boolean } {
    let set = this.sockets.get(userId);
    const firstConnection = !set || set.size === 0;
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(ws);
    return { firstConnection };
  }

  remove(userId: number, ws: WebSocket): { lastConnection: boolean } {
    const set = this.sockets.get(userId);
    set?.delete(ws);
    if (set && set.size === 0) {
      this.sockets.delete(userId);
      return { lastConnection: true };
    }
    return { lastConnection: false };
  }

  isOnline(userId: number): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  /** The app on this connection is in front and being used (true), or in the background or idle (false). */
  setActive(ws: WebSocket, active: boolean): void {
    if (active) this.idle.delete(ws);
    else this.idle.add(ws);
  }

  /**
   * Whether someone has Dendrop open in front of them right now: what decides if their phone
   * needs a push. Apps that never say otherwise count as active while connected.
   */
  isActive(userId: number): boolean {
    for (const ws of this.sockets.get(userId) ?? []) if (!this.idle.has(ws)) return true;
    return false;
  }

  send(userIds: Iterable<number>, event: ServerEvent, except?: WebSocket): void {
    const data = JSON.stringify(event);
    for (const id of new Set(userIds)) {
      for (const ws of this.sockets.get(id) ?? []) {
        if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
      }
      for (const fn of this.sinks.get(id) ?? []) {
        try {
          fn(event);
        } catch {
          // A bot's listener failing never stops delivery to people.
        }
      }
    }
  }

  /** Closes someone's connections, for example when their account is deleted. */
  closeUser(userId: number, reason = "Signed out"): void {
    for (const ws of this.sockets.get(userId) ?? []) ws.close(4401, reason);
  }

  closeAll(): void {
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, "Server shutting down");
    this.sockets.clear();
    this.sinks.clear();
  }
}
