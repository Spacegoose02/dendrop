import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ClientEvent } from "@dendrop/shared";
import { AutomodService } from "./automod.js";
import { BotService, type BotFetch } from "./bots.js";
import { OidcService } from "./auth/oidc.js";
import { SignInService } from "./signin.js";
import { SESSION_COOKIE, SessionService } from "./auth/sessions.js";
import type { ServerConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import { FamilyService, type WebhookPost } from "./family.js";
import { Gateway } from "./gateway.js";
import { GifService, type GifFetch } from "./gifs.js";
import { DendutyLink, type DendutyFetch } from "./denduty.js";
import type { LevelService } from "./levels.js";
import { builtinLivekit } from "./livekit.js";
import { LootdenLink, type LootdenFetch } from "./lootden.js";
import { PushService } from "./push.js";
import { pushRoutes } from "./routes/push.js";
import { authRoutes } from "./routes/auth.js";
import { signInRoutes } from "./routes/signin.js";
import { botRoutes } from "./routes/bots.js";
import { dmRoutes } from "./routes/dms.js";
import { expressionRoutes } from "./routes/expressions.js";
import { funRoutes } from "./routes/fun.js";
import { familyRoutes, guardKids } from "./routes/family.js";
import { dendutyRoutes } from "./routes/denduty.js";
import { lootdenRoutes } from "./routes/lootden.js";
import { guardChannelConversations, serverRoutes } from "./routes/servers.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { toMe, UserRepo, type UserRecord } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRecord;
  }
}

/** Everything the routes share. */
export interface Context {
  config: ServerConfig;
  db: Db;
  users: UserRepo;
  sessions: SessionService;
  /** TinyAuth (or another OpenID Connect provider). */
  oidc: OidcService;
  /** Sign in with Google. */
  google: OidcService;
  /** The super admin's sign-in switches. */
  signin: SignInService;
  gateway: Gateway;
  push: PushService;
  /** Kid accounts, parents, rules and alerts. */
  family: FamilyService;
  /** Server channel rules: blocked words, spam, links, new accounts; and timeouts. */
  automod: AutomodService;
  /** The link to LootDen: who's playing what. */
  lootden: LootdenLink;
  /** The link to Den Duty: kids' chores, and its events posted into channels. */
  denduty: DendutyLink;
  /** Bot accounts, the bot API's tokens and events, and buttons on bots' messages. */
  bots: BotService;
  /** GIF search through GIPHY, off until a super admin sets it up. */
  gifs: GifService;
  /** Set by the server routes: sends a server's members its new state (and prunes voice). */
  serverChanged?: (serverId: number) => void;
  /** Set by the server routes: XP and raccoon ranks. */
  levels?: LevelService;
  /** Set by the server routes: how many people are in a voice channel. */
  voiceCount?: (channelId: number) => number;
  /** Set by the server routes: who is in a voice channel. */
  voiceMembers?: (channelId: number) => number[];
  /** Hooks for the gateway, so features can react to events from clients. */
  onClientEvent: ((user: UserRecord, event: ClientEvent) => void)[];
  onPresence: ((userId: number, online: boolean) => void)[];
  /** Set by the fun routes: sends out reminders due by `at` (runs by itself every few seconds). */
  fireReminders?: (at?: Date) => void;
  /** How long calls ring before they count as missed; shorter in tests. */
  callRingMs?: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Context;
}

export async function buildApp(
  config: ServerConfig,
  db: Db = openDb(path.join(config.dataDir, "dendrop.db")),
  options: { callRingMs?: number; pushPost?: ConstructorParameters<typeof PushService>[2]; webhookPost?: WebhookPost; lootdenFetch?: LootdenFetch; dendutyFetch?: DendutyFetch; botFetch?: BotFetch; gifFetch?: GifFetch } = {},
): Promise<BuiltApp> {
  const logger = process.env.NODE_ENV === "test" ? false : { level: process.env.DENDROP_LOG_LEVEL ?? "info" };
  // Built-in HTTPS (config.tls) is the same app on an https server; the types are the plain one's.
  const app = (
    config.tls
      ? Fastify({ logger, trustProxy: true, https: readTls(config.tls) })
      : Fastify({ logger, trustProxy: true })
  ) as unknown as FastifyInstance;
  const users = new UserRepo(db);
  const signin = new SignInService(db, config);
  const gateway = new Gateway();
  const family = new FamilyService(db, users, gateway, { publicUrl: config.publicUrl }, options.webhookPost);
  const push = new PushService(db, { publicUrl: config.publicUrl, allowHttp: config.pushAllowHttp }, options.pushPost);
  const automod = new AutomodService(db, users, gateway, { publicUrl: config.publicUrl });
  const ctx: Context = {
    config,
    db,
    users,
    sessions: new SessionService(db, users),
    oidc: new OidcService(config, users, signin, "tinyauth"),
    google: new OidcService(config, users, signin, "google"),
    signin,
    gateway,
    push,
    family,
    automod,
    lootden: new LootdenLink(db, users, gateway, options.lootdenFetch),
    denduty: new DendutyLink(db, users, gateway, family, push, options.dendutyFetch),
    bots: new BotService(db, users, gateway, automod, family, push, options.botFetch, (msg, err) => app.log.warn({ err }, msg)),
    gifs: new GifService(db, family, config.dataDir, options.gifFetch),
    onClientEvent: [],
    onPresence: [],
    callRingMs: options.callRingMs,
  };
  // LootDen's play limits feed kids' time rules, when a parent turns that on.
  family.playLimits = (kidId, at) => ctx.lootden.kidLimits(kidId, at);
  // GIF links pass automod's link rule while GIFs are on.
  automod.extraAllowedHosts = () => ctx.gifs.linkHosts();

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) req.log.error(err);
    void reply.code(status).send({ error: status >= 500 ? "Something went wrong on the server" : err.message });
  });

  app.addHook("onRequest", async (req) => {
    req.user = ctx.sessions.resolve(req.cookies[SESSION_COOKIE]);
  });

  app.addHook("onClose", async () => {
    ctx.gateway.closeAll();
    ctx.gifs.close();
    db.close();
  });

  guardChannelConversations(app, ctx);
  guardKids(app, ctx);

  app.get("/api/health", async () => ({ status: "ok" }));

  await app.register(async (api) => authRoutes(api, ctx));
  await app.register(async (api) => signInRoutes(api, ctx));
  await app.register(async (api) => dmRoutes(api, ctx));
  await app.register(async (api) => expressionRoutes(api, ctx));
  await app.register(async (api) => funRoutes(api, ctx));
  await app.register(async (api) => pushRoutes(api, ctx));
  await app.register(async (api) => serverRoutes(api, ctx));
  await app.register(async (api) => familyRoutes(api, ctx));
  await app.register(async (api) => webhookRoutes(api, ctx));
  await app.register(async (api) => lootdenRoutes(api, ctx));
  await app.register(async (api) => dendutyRoutes(api, ctx));
  await app.register(async (api) => botRoutes(api, ctx));
  await app.register(async (api) => gatewayRoute(api, ctx));
  builtinLivekit(app, config);

  serveWeb(app, config);
  return { app, ctx };
}

/** Rejects the request unless someone is signed in, and returns who. */
export function requireUser(req: FastifyRequest): UserRecord {
  if (!req.user) throw new HttpError(401, "Sign in first");
  return req.user;
}

/** The WebSocket gateway: pushes events to signed-in clients and takes typing pings. */
function readTls(tls: NonNullable<ServerConfig["tls"]>): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(tls.cert), key: readFileSync(tls.key) };
  } catch (err) {
    throw new Error(`Can't read the HTTPS certificate (${tls.cert}) or key (${tls.key}): ${(err as Error).message}`);
  }
}

function gatewayRoute(app: FastifyInstance, ctx: Context): void {
  app.get("/api/gateway", { websocket: true }, (socket, req) => {
    const user = req.user;
    // Browsers send cookies with WebSocket requests from any site, so check where it came from.
    if (!user || !originAllowed(req, ctx.config)) {
      socket.close(4401, "Sign in first");
      return;
    }
    const { firstConnection } = ctx.gateway.add(user.id, socket);
    socket.send(JSON.stringify({ type: "ready", user: toMe(user) }));
    if (firstConnection) for (const fn of ctx.onPresence) fn(user.id, true);

    socket.on("message", (raw) => {
      let event: ClientEvent;
      try {
        event = JSON.parse(String(raw)) as ClientEvent;
      } catch {
        return;
      }
      if (event?.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      for (const fn of ctx.onClientEvent) {
        try {
          fn(user, event);
        } catch (err) {
          req.log.warn({ err }, "gateway event failed");
        }
      }
    });
    socket.on("close", () => {
      const { lastConnection } = ctx.gateway.remove(user.id, socket);
      if (lastConnection) for (const fn of ctx.onPresence) fn(user.id, false);
    });
  });
}

export function originAllowed(req: FastifyRequest, config: ServerConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Not a browser (the desktop and Android apps, tests).
  if (config.publicUrl && origin === new URL(config.publicUrl).origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Serves the built web client, with index.html for every app route. */
function serveWeb(app: FastifyInstance, config: ServerConfig): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = config.webDir ?? path.resolve(here, "../../../web/dist");
  const index = path.join(webDir, "index.html");
  if (!existsSync(index)) {
    app.get("/", async (_req, reply) => reply.type("text/plain").send("Dendrop server is running. The web client isn't built (npm run build)."));
    return;
  }
  void app.register(fastifyStatic, { root: webDir, wildcard: false });
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}
