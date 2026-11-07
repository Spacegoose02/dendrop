import type { ServerEvent } from "@dendrop/shared";
import type { WebSocket } from "ws";

/** Live WebSocket connections per user, for pushing events. One server process, so in memory. */
export class Gateway {
  private sockets = new Map<number, Set<WebSocket>>();
  /** Bots' listeners (their gateway connections and events addresses), instead of sockets. */
  private sinks = new Map<number, Set<(event: ServerEvent) => void>>();

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

  closeAll(): void {
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, "Server shutting down");
    this.sockets.clear();
    this.sinks.clear();
  }
}
