import type { ServerEvent } from "@dendrop/shared";
import type { WebSocket } from "ws";

/** Live WebSocket connections per user, for pushing events. One server process, so in memory. */
export class Gateway {
  private sockets = new Map<number, Set<WebSocket>>();

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
    }
  }

  closeAll(): void {
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, "Server shutting down");
    this.sockets.clear();
  }
}
