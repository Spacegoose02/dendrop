import { AccessToken } from "livekit-server-sdk";
import type { Call, CallJoin } from "@dendrop/shared";
import { callsEnabled, type ServerConfig } from "./config.js";
import { now } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";

/** How long a call rings with nobody picking up before it counts as missed. */
export const RING_MS = 45_000;

interface Live {
  call: Call;
  memberIds: number[];
  ringTimer?: NodeJS.Timeout;
}

/**
 * Calls in conversations. The media goes through LiveKit; this keeps track of who is
 * ringing and who is in, and hands out LiveKit tokens to members.
 */
export class CallService {
  private live = new Map<number, Live>();

  constructor(
    private readonly config: ServerConfig,
    private readonly gateway: Gateway,
    private readonly ringMs = RING_MS,
  ) {}

  get enabled(): boolean {
    return callsEnabled(this.config);
  }

  get(conversationId: number): Call | undefined {
    return this.live.get(conversationId)?.call;
  }

  /** Calls this person is in or being rung for, for a client that just connected. */
  forUser(userId: number): Call[] {
    return [...this.live.values()].filter((l) => l.memberIds.includes(userId)).map((l) => l.call);
  }

  roomName(conversationId: number): string {
    return `dendrop-conversation-${conversationId}`;
  }

  /**
   * Starts a call, or joins the one already going. Returns what the client needs to connect;
   * `url` is the LiveKit address for this client (the built-in one is reached through Dendrop's).
   */
  async join(conversationId: number, memberIds: number[], user: { id: number; displayName: string }, video: boolean, url: string): Promise<CallJoin> {
    if (!this.enabled) throw new HttpError(404, "Calls aren't set up on this server");
    let l = this.live.get(conversationId);
    if (!l) {
      l = {
        memberIds,
        call: { conversationId, startedBy: user.id, startedAt: now(), video, joined: [], ringing: memberIds.filter((m) => m !== user.id) },
      };
      this.live.set(conversationId, l);
      const started = l;
      started.ringTimer = setTimeout(() => {
        // Nobody else picked up.
        if (started.call.joined.length <= 1) this.end(conversationId, true);
        else this.stopRinging(conversationId);
      }, this.ringMs);
      started.ringTimer.unref?.();
    }
    l.memberIds = memberIds;
    if (!l.call.joined.includes(user.id)) l.call.joined.push(user.id);
    l.call.ringing = l.call.ringing.filter((m) => m !== user.id);
    this.broadcast(l);
    return { call: l.call, url, token: await this.token(conversationId, user) };
  }

  /** Stops ringing this person. In a 1:1 call that ends it. */
  decline(conversationId: number, userId: number): void {
    const l = this.live.get(conversationId);
    if (!l || !l.call.ringing.includes(userId)) return;
    l.call.ringing = l.call.ringing.filter((m) => m !== userId);
    if (l.call.ringing.length === 0 && l.call.joined.length <= 1) {
      this.end(conversationId, false);
      return;
    }
    this.broadcast(l);
  }

  /** Leaves the call. The last one out ends it, and so does either person in a 1:1 call. */
  leave(conversationId: number, userId: number): void {
    const l = this.live.get(conversationId);
    if (!l || !l.call.joined.includes(userId)) return;
    l.call.joined = l.call.joined.filter((m) => m !== userId);
    if (l.call.joined.length === 0 || l.memberIds.length === 2) {
      this.end(conversationId, false);
      return;
    }
    this.broadcast(l);
  }

  /** Someone's last connection closed: take them out of every call. */
  leaveAll(userId: number): void {
    for (const id of [...this.live.keys()]) this.leave(id, userId);
  }

  private stopRinging(conversationId: number): void {
    const l = this.live.get(conversationId);
    if (!l || l.call.ringing.length === 0) return;
    l.call.ringing = [];
    this.broadcast(l);
  }

  private end(conversationId: number, missed: boolean): void {
    const l = this.live.get(conversationId);
    if (!l) return;
    clearTimeout(l.ringTimer);
    this.live.delete(conversationId);
    this.gateway.send(l.memberIds, { type: "call.ended", conversationId, missed });
  }

  private broadcast(l: Live): void {
    this.gateway.send(l.memberIds, { type: "call.updated", call: l.call });
  }

  private async token(conversationId: number, user: { id: number; displayName: string }): Promise<string> {
    const t = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: String(user.id),
      name: user.displayName,
      ttl: "4h",
    });
    t.addGrant({ roomJoin: true, room: this.roomName(conversationId), canPublish: true, canSubscribe: true, canPublishData: false });
    return t.toJwt();
  }

  closeAll(): void {
    for (const l of this.live.values()) clearTimeout(l.ringTimer);
    this.live.clear();
  }
}
