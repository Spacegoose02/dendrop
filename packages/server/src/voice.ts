import { SOUNDBOARD_COOLDOWN_MS, type SoundboardPlay, type VoiceChannelState, type VoiceJoin, type VoiceMember, type WatchItem, type WatchSession } from "@dendrop/shared";
import { callsEnabled, type ServerConfig } from "./config.js";
import { now } from "./db.js";
import { HttpError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import { livekitToken, removeFromRoom, setCanPublish } from "./livekit.js";
import { newWatchItem, Watch } from "./watch.js";

/** Where a voice channel is: which server, and the conversation whose members can see it. */
export interface VoiceChannelRef {
  channelId: number;
  serverId: number;
  conversationId: number;
  /** A stage channel: only speakers talk. */
  stage: boolean;
}

/**
 * Who is in each voice channel. Like calls, it lives in memory while people are in; the media
 * goes through LiveKit, one room per channel. Nobody rings: people drop in and out.
 *
 * Someone is in at most one voice channel at a time, and everyone who can see a channel (its
 * conversation's members) is told who is in it.
 *
 * Stage channels are the same rooms with speakers and listeners. Stage moderators (see the
 * routes) come in as speakers, everyone else as a listener whose LiveKit token can't publish.
 * Listeners raise a hand; a moderator lets them speak, which the call server is told about
 * straight away (setCanPublish), and can move them back to the audience the same way.
 *
 * Watch together: anyone who can talk in the channel (everyone in a voice channel, speakers on
 * a stage) can put on a video, queue more, play, pause and skip. The video's state rides along
 * in voice.updated, so it goes when the last person leaves.
 */
export class VoiceService {
  private channels = new Map<number, { ref: VoiceChannelRef; members: VoiceMember[]; watch: WatchSession | null }>();
  /** When each person last played a soundboard sound. */
  private lastSound = new Map<number, number>();

  constructor(
    private readonly config: ServerConfig,
    private readonly gateway: Gateway,
    /** Who can see a channel right now: its conversation's members. */
    private readonly viewers: (conversationId: number) => number[],
    /** The server's clock in milliseconds; tests pass their own. */
    private readonly clock: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return callsEnabled(this.config);
  }

  roomName(channelId: number): string {
    return `dendrop-voice-${channelId}`;
  }

  state(channelId: number): VoiceChannelState | undefined {
    const c = this.channels.get(channelId);
    return c && { ...c.ref, members: c.members, watch: c.watch };
  }

  /** Voice channels with people in them that this person can see. */
  forUser(userId: number): VoiceChannelState[] {
    return [...this.channels.keys()].flatMap((id) => {
      const s = this.state(id)!;
      return this.viewers(s.conversationId).includes(userId) ? [s] : [];
    });
  }

  /** The voice channel someone is in, if any. */
  channelOf(userId: number): number | undefined {
    for (const [id, c] of this.channels) if (c.members.some((m) => m.userId === userId)) return id;
    return undefined;
  }

  /**
   * Joins a voice channel, leaving any other one first. The caller checks the person can see it.
   * On a stage, `moderator` says they come in as a speaker; everyone else listens.
   */
  async join(ref: VoiceChannelRef, user: { id: number; displayName: string }, url: string, moderator = false): Promise<VoiceJoin> {
    if (!this.enabled) throw new HttpError(404, "Voice isn't set up on this server");
    const current = this.channelOf(user.id);
    if (current !== undefined && current !== ref.channelId) this.leave(user.id);
    let c = this.channels.get(ref.channelId);
    if (!c) this.channels.set(ref.channelId, (c = { ref, members: [], watch: null }));
    let m = c.members.find((x) => x.userId === user.id);
    if (!m) {
      const speaker = !ref.stage || moderator;
      m = { userId: user.id, muted: !speaker, deafened: false, video: false, screen: false, joinedAt: now(), speaker, handRaised: false };
      c.members.push(m);
    }
    this.broadcast(ref.channelId);
    const token = await livekitToken(this.config, this.roomName(ref.channelId), user, m.speaker);
    return { voice: this.state(ref.channelId)!, url, token };
  }

  /** A stage listener raises or lowers their hand to ask to speak. */
  setHand(userId: number, raised: boolean): VoiceChannelState {
    const id = this.channelOf(userId);
    if (id === undefined) throw new HttpError(400, "You aren't in a voice channel");
    const c = this.channels.get(id)!;
    if (!c.ref.stage) throw new HttpError(400, "Hands are for stage channels");
    const m = c.members.find((x) => x.userId === userId)!;
    if (m.speaker && raised) throw new HttpError(400, "You can already speak");
    m.handRaised = raised;
    this.broadcast(id);
    return this.state(id)!;
  }

  /**
   * Lets someone on a stage speak, or moves them to the audience. The caller checks who may.
   * Moving someone to the audience turns off their mic, camera and screen.
   */
  setSpeaker(channelId: number, userId: number, speaker: boolean): VoiceChannelState {
    const c = this.channels.get(channelId);
    const m = c?.members.find((x) => x.userId === userId);
    if (!c || !m) throw new HttpError(404, "They aren't on this stage");
    if (!c.ref.stage) throw new HttpError(400, "Everyone can talk in a voice channel");
    m.handRaised = false;
    if (m.speaker !== speaker) {
      m.speaker = speaker;
      if (!speaker) Object.assign(m, { muted: true, video: false, screen: false });
      void setCanPublish(this.config, this.roomName(channelId), String(userId), speaker);
    }
    this.broadcast(channelId);
    return this.state(channelId)!;
  }

  /** What someone shows the others: muted, deafened, camera or screen on. */
  setState(userId: number, patch: Partial<Pick<VoiceMember, "muted" | "deafened" | "video" | "screen">>): VoiceChannelState {
    const id = this.channelOf(userId);
    if (id === undefined) throw new HttpError(400, "You aren't in a voice channel");
    const c = this.channels.get(id)!;
    const m = c.members.find((x) => x.userId === userId)!;
    for (const k of ["muted", "deafened", "video", "screen"] as const) {
      if (typeof patch[k] === "boolean") m[k] = patch[k];
    }
    // Deafened people can't hear, so they aren't heard either.
    if (m.deafened) m.muted = true;
    // Stage listeners only listen.
    if (!m.speaker) Object.assign(m, { muted: true, video: false, screen: false });
    this.broadcast(id);
    return this.state(id)!;
  }

  /**
   * Plays a soundboard sound to everyone in this person's voice channel (them included). The
   * caller checks the sound belongs to the channel's server. Stage listeners and deafened people
   * can't play sounds, and there's a short wait between sounds so nobody spams the room.
   */
  playSound(userId: number, play: SoundboardPlay, at = Date.now()): void {
    const id = this.channelOf(userId);
    if (id === undefined) throw new HttpError(400, "You aren't in a voice channel");
    const c = this.channels.get(id)!;
    const m = c.members.find((x) => x.userId === userId)!;
    if (!m.speaker) throw new HttpError(403, "Only speakers can play sounds on a stage");
    if (m.deafened) throw new HttpError(400, "Undeafen to play sounds");
    const last = this.lastSound.get(userId) ?? 0;
    if (at - last < SOUNDBOARD_COOLDOWN_MS) throw new HttpError(429, "One sound at a time: wait a moment");
    this.lastSound.set(userId, at);
    this.gateway.send(
      c.members.map((x) => x.userId),
      { type: "voice.sound", channelId: id, userId, play },
    );
  }

  // ---- Watch together ----------------------------------------------------------------

  /** The channel someone is in, checking they can run the video there (they can talk). */
  private watcher(userId: number) {
    const id = this.channelOf(userId);
    if (id === undefined) throw new HttpError(400, "Join the voice channel first");
    const c = this.channels.get(id)!;
    if (!c.members.find((m) => m.userId === userId)!.speaker) throw new HttpError(403, "Only speakers can pick what's on");
    return { id, c };
  }

  /** The voice channel this person is in and could put a video on in, for the routes' own checks. */
  watchChannel(userId: number): VoiceChannelRef {
    return this.watcher(userId).c.ref;
  }

  private changeWatch(userId: number, change: (w: WatchSession | null, at: number) => WatchSession | null): VoiceChannelState {
    const { id, c } = this.watcher(userId);
    c.watch = change(c.watch, this.clock());
    this.broadcast(id);
    return this.state(id)!;
  }

  private changePlaying(userId: number, change: (w: WatchSession, at: number) => WatchSession | null): VoiceChannelState {
    return this.changeWatch(userId, (w, at) => {
      if (!w) throw new HttpError(400, "Nothing's playing");
      return change(w, at);
    });
  }

  /** Puts a video on, or adds it to the queue when one is playing. */
  watchAdd(userId: number, item: Omit<WatchItem, "id" | "addedBy">): VoiceChannelState {
    return this.changeWatch(userId, (w, at) => Watch.add(w, newWatchItem({ ...item, addedBy: userId }), at));
  }

  /** Play, pause, or jump to a time (seconds). */
  watchControl(userId: number, patch: { playing?: boolean; position?: number }): VoiceChannelState {
    return this.changePlaying(userId, (w, at) => Watch.control(w, patch, at));
  }

  /** Skips to the next video. With itemId (from a device whose video ended), only if that one's still on. */
  watchNext(userId: number, itemId?: string): VoiceChannelState {
    return this.changePlaying(userId, (w, at) => Watch.next(w, at, itemId));
  }

  watchRemove(userId: number, itemId: string): VoiceChannelState {
    return this.changePlaying(userId, (w) => Watch.remove(w, itemId));
  }

  /** Stops watching for everyone. */
  watchStop(userId: number): VoiceChannelState {
    return this.changeWatch(userId, () => null);
  }

  /** Leaves whatever voice channel this person is in. */
  leave(userId: number): void {
    const id = this.channelOf(userId);
    if (id === undefined) return;
    const c = this.channels.get(id)!;
    c.members = c.members.filter((m) => m.userId !== userId);
    this.broadcast(id);
    if (c.members.length === 0) this.channels.delete(id);
  }

  /**
   * Takes people out of channels they can no longer see (removed from the server, the channel
   * was locked or deleted), and drops them from the LiveKit room too so their token stops working.
   * `exists` says whether a channel is still there.
   */
  prune(exists: (channelId: number) => boolean): void {
    for (const [id, c] of [...this.channels]) {
      const gone = !exists(id);
      const viewers = gone ? new Set<number>() : new Set(this.viewers(c.ref.conversationId));
      const out = c.members.filter((m) => !viewers.has(m.userId));
      if (out.length === 0) continue;
      c.members = c.members.filter((m) => viewers.has(m.userId));
      for (const m of out) void removeFromRoom(this.config, this.roomName(id), String(m.userId));
      if (!gone) this.broadcast(id);
      // The people taken out hear about it too, so their app hangs up.
      this.gateway.send(
        out.map((m) => m.userId),
        { type: "voice.updated", voice: { ...c.ref, members: c.members, watch: c.watch } },
      );
      if (c.members.length === 0) this.channels.delete(id);
    }
  }

  private broadcast(channelId: number): void {
    const s = this.state(channelId);
    if (s) this.gateway.send(this.viewers(s.conversationId), { type: "voice.updated", voice: s });
  }

  closeAll(): void {
    this.channels.clear();
  }
}
