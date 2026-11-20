import type { FastifyInstance, FastifyReply } from "fastify";
import { FailureLimiter } from "./auth/limiter.js";
import { HttpError } from "./errors.js";

/**
 * Spam limits: how fast one account can send messages, upload files and send friend requests.
 * They're per account, so one bad or hacked account can't flood a chat, and set well above what
 * a family chatting (or sharing a pile of holiday photos) ever does.
 *
 * Each kind has a short burst limit and a longer one, both sliding windows.
 */
export const SPAM_LIMITS = {
  /** Messages, polls, games, new threads and forum posts. */
  messages: [
    { max: 20, windowMs: 10_000 },
    { max: 120, windowMs: 5 * 60_000 },
  ],
  /** Files: each attachment counts, and so do new pictures, emojis, stickers and sounds. */
  uploads: [
    { max: 30, windowMs: 60_000 },
    { max: 100, windowMs: 60 * 60_000 },
  ],
  /** Friend requests by username (asking again, or for a username that isn't there, counts too). */
  friendRequests: [
    { max: 10, windowMs: 10 * 60_000 },
    { max: 30, windowMs: 24 * 60 * 60_000 },
  ],
} as const;

export type SpamKind = keyof typeof SPAM_LIMITS;

const NOUN: Record<SpamKind, string> = {
  messages: "send more messages",
  uploads: "upload more files",
  friendRequests: "send more friend requests",
};

/** "8 seconds", "3 minutes", "2 hours". */
export const waitWords = (ms: number): string => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.ceil(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
};

type Limits = Record<SpamKind, ReadonlyArray<{ max: number; windowMs: number }>>;

export class SpamGuard {
  private readonly limiters: Record<SpamKind, FailureLimiter[]>;

  constructor(limits: Limits = SPAM_LIMITS, clock: () => number = Date.now) {
    const make = (k: SpamKind) => limits[k].map((l) => new FailureLimiter(l.max, l.windowMs, clock));
    this.limiters = { messages: make("messages"), uploads: make("uploads"), friendRequests: make("friendRequests") };
  }

  /** No limits at all (for tests that aren't about them). */
  static off(): SpamGuard {
    const none = [{ max: Number.MAX_SAFE_INTEGER, windowMs: 1 }];
    return new SpamGuard({ messages: none, uploads: none, friendRequests: none });
  }

  /** Milliseconds until `userId` may do this again, or 0 if they may now. */
  waitMs(kind: SpamKind, userId: number): number {
    const key = String(userId);
    return Math.max(0, ...this.limiters[kind].map((l) => l.waitMs(key)));
  }

  /** A friendly 429 if `userId` is over the limit, without counting anything. */
  check(kind: SpamKind, userId: number, reply?: FastifyReply): void {
    const wait = this.waitMs(kind, userId);
    if (wait <= 0) return;
    if (reply) void reply.header("retry-after", Math.ceil(wait / 1000));
    throw new HttpError(429, `Easy, raccoon! That's a lot at once. You can ${NOUN[kind]} in ${waitWords(wait)}.`);
  }

  /** Like `check`, and counts this one when it's allowed. */
  take(kind: SpamKind, userId: number, reply?: FastifyReply): void {
    this.check(kind, userId, reply);
    for (const l of this.limiters[kind]) l.fail(String(userId));
  }
}

// What counts as what. Messages with files are counted per file where they're read (routes/dms.ts).
const MESSAGE_ROUTES = [
  /^\/api\/conversations\/\d+\/(messages|polls|games)(\/?|\?.*)$/,
  /^\/api\/messages\/\d+\/thread(\/?|\?.*)$/,
  /^\/api\/servers\/\d+\/channels\/\d+\/threads(\/?|\?.*)$/,
];
const UPLOAD_ROUTES = [/^\/api\/servers\/\d+\/(emojis|stickers|sounds)(\/?|\?.*)$/, /^\/api\/me\/(avatar|banner)(\/?|\?.*)$/];
const FRIEND_ROUTES = [/^\/api\/friends(\/?|\?.*)$/];

/** Applies the spam limits to signed-in people's requests, before the route reads the body. */
export function guardSpam(app: FastifyInstance, spam: SpamGuard): void {
  app.addHook("preHandler", async (req, reply) => {
    const user = req.user;
    if (!user || (req.method !== "POST" && req.method !== "PUT")) return;
    const url = req.url;
    if (req.method === "POST" && MESSAGE_ROUTES.some((r) => r.test(url))) {
      // A message with files is turned away early when uploads are used up, before it's read.
      if (/^multipart\//i.test(req.headers["content-type"] ?? "")) spam.check("uploads", user.id, reply);
      spam.take("messages", user.id, reply);
    } else if (UPLOAD_ROUTES.some((r) => r.test(url))) {
      spam.take("uploads", user.id, reply);
    } else if (req.method === "POST" && FRIEND_ROUTES.some((r) => r.test(url))) {
      spam.take("friendRequests", user.id, reply);
    }
  });
}
