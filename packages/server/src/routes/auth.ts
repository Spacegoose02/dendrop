import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isUsername, LIMITS, type AuthInfo, type ServerInfo } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { safeReturn } from "../auth/oidc.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { HttpError } from "../errors.js";
import { toMe, type UserRecord } from "../users.js";

interface Credentials {
  username?: unknown;
  password?: unknown;
  displayName?: unknown;
}

const MIN_PASSWORD = 10;

function checkNew(ctx: Context, body: Credentials): { username: string; password: string; displayName: string } {
  const { username, password } = body;
  if (!isUsername(username)) throw new HttpError(400, "Usernames are 2 to 32 letters, numbers, dots, dashes or underscores");
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
  if (ctx.users.byUsername(username)) throw new HttpError(409, "That username is taken");
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, LIMITS.displayNameLength) : username;
  return { username, password, displayName };
}

export function authRoutes(app: FastifyInstance, ctx: Context): void {
  const { config, users, sessions, oidc } = ctx;
  const secure = config.publicUrl.startsWith("https://");

  const signIn = (req: FastifyRequest, reply: FastifyReply, user: UserRecord) => {
    const { token, maxAgeSeconds } = sessions.create(user.id, req.headers["user-agent"]);
    void reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge: maxAgeSeconds });
  };

  app.get("/api/auth/info", async (): Promise<AuthInfo> => ({
    needsSetup: users.count() === 0,
    oidc: { enabled: oidc.enabled, name: config.oidc.name },
    localLogin: config.localLogin,
    signup: config.localLogin && config.signup,
  }));

  /** Makes the first account, the super admin. Only works while there are no accounts. */
  app.post<{ Body: Credentials }>("/api/auth/setup", async (req, reply) => {
    if (users.count() > 0) throw new HttpError(409, "Dendrop is already set up");
    if (!config.localLogin) throw new HttpError(403, "Password sign-in is off; sign in with single sign-on to become the admin");
    const n = checkNew(ctx, req.body ?? {});
    const user = users.create({ username: n.username, displayName: n.displayName, passwordHash: await hashPassword(n.password), isSuperAdmin: true });
    signIn(req, reply, user);
    return toMe(user);
  });

  app.post<{ Body: Credentials }>("/api/auth/signup", async (req, reply) => {
    if (!config.localLogin || !config.signup) throw new HttpError(403, "Sign-up is off; ask the admin for an account");
    const n = checkNew(ctx, req.body ?? {});
    const user = users.create({ username: n.username, displayName: n.displayName, passwordHash: await hashPassword(n.password) });
    signIn(req, reply, user);
    return toMe(user);
  });

  app.post<{ Body: Credentials }>("/api/auth/login", async (req, reply) => {
    if (!config.localLogin) throw new HttpError(403, "Password sign-in is off");
    const { username, password } = req.body ?? {};
    const user = typeof username === "string" ? users.byUsername(username) : undefined;
    // Always run a hash, so a wrong username takes as long as a wrong password.
    const ok = await verifyPassword(typeof password === "string" ? password : "", user?.passwordHash ?? "scrypt$16384$8$1$AAAA$AAAA");
    if (!user || !ok) throw new HttpError(401, "Wrong username or password");
    signIn(req, reply, user);
    return toMe(user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) sessions.end(token);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get<{ Querystring: { returnTo?: string } }>("/api/auth/oidc/start", async (req, reply) => {
    if (!oidc.enabled) throw new HttpError(404, "Single sign-on isn't set up");
    return reply.redirect(await oidc.start(req.query.returnTo ?? "/"));
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    if (!oidc.enabled) throw new HttpError(404, "Single sign-on isn't set up");
    try {
      const { user, returnTo } = await oidc.finish(new URL(req.url, config.publicUrl));
      signIn(req, reply, user);
      return reply.redirect(safeReturn(returnTo));
    } catch (err) {
      req.log.warn({ err }, "OIDC sign-in failed");
      return reply.redirect(`/login?error=${encodeURIComponent(err instanceof Error ? err.message : "Sign-in failed")}`);
    }
  });

  app.get("/api/me", async (req) => toMe(requireUser(req)));

  app.patch<{ Body: { displayName?: unknown; readReceipts?: unknown } }>("/api/me", async (req) => {
    const user = requireUser(req);
    const { displayName: name, readReceipts } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) throw new HttpError(400, "A display name can't be empty");
    if (readReceipts !== undefined && typeof readReceipts !== "boolean") throw new HttpError(400, "readReceipts is true or false");
    return toMe(
      users.update(user.id, {
        displayName: typeof name === "string" ? name.trim().slice(0, LIMITS.displayNameLength) : undefined,
        readReceipts: readReceipts as boolean | undefined,
      }),
    );
  });

  app.get("/api/server", async (req): Promise<ServerInfo> => {
    requireUser(req);
    const l = config.livekit;
    return { maxUploadBytes: config.maxUploadBytes, calls: !!(l.url && l.apiKey && l.apiSecret) };
  });
}
