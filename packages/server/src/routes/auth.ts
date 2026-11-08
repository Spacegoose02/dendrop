import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isHexColor, isUsername, LIMITS, type AuthInfo, type ServerInfo } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { safeReturn } from "../auth/oidc.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { callsEnabled } from "../config.js";
import { HttpError } from "../errors.js";
import { toMe, type UserRecord } from "../users.js";

interface Credentials {
  username?: unknown;
  password?: unknown;
  displayName?: unknown;
}

export const MIN_PASSWORD = 10;

export function checkNew(ctx: Context, body: Credentials): { username: string; password: string; displayName: string } {
  const { username, password } = body;
  if (!isUsername(username)) throw new HttpError(400, "Usernames are 2 to 32 letters, numbers, dots, dashes or underscores");
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
  if (ctx.users.byUsername(username)) throw new HttpError(409, "That username is taken");
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, LIMITS.displayNameLength) : username;
  return { username, password, displayName };
}

export function authRoutes(app: FastifyInstance, ctx: Context): void {
  const { config, users, sessions, signin } = ctx;
  const secure = config.publicUrl.startsWith("https://") || !!config.tls;

  const signIn = (req: FastifyRequest, reply: FastifyReply, user: UserRecord) => {
    const { token, maxAgeSeconds } = sessions.create(user.id, req.headers["user-agent"]);
    void reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge: maxAgeSeconds });
  };

  app.get("/api/auth/info", async (): Promise<AuthInfo> => {
    const s = signin.settings();
    const live = signin.live(s);
    return {
      needsSetup: users.count() === 0,
      oidc: { enabled: live.tinyauth, name: config.oidc.name },
      google: { enabled: live.google },
      localLogin: live.password,
      signup: live.password && s.signup,
    };
  });

  /** Makes the first account, the super admin. Only works while there are no accounts. */
  app.post<{ Body: Credentials }>("/api/auth/setup", async (req, reply) => {
    if (users.count() > 0) throw new HttpError(409, "Dendrop is already set up");
    if (!signin.settings().passwordLogin) throw new HttpError(403, "Password sign-in is off; sign in with single sign-on to become the admin");
    const n = checkNew(ctx, req.body ?? {});
    const user = users.create({ username: n.username, displayName: n.displayName, passwordHash: await hashPassword(n.password), isSuperAdmin: true });
    signIn(req, reply, user);
    return toMe(user);
  });

  app.post<{ Body: Credentials }>("/api/auth/signup", async (req, reply) => {
    const s = signin.settings();
    if (!s.passwordLogin || !s.signup) throw new HttpError(403, "Sign-up is off; ask the admin for an account");
    const n = checkNew(ctx, req.body ?? {});
    const user = users.create({ username: n.username, displayName: n.displayName, passwordHash: await hashPassword(n.password) });
    signIn(req, reply, user);
    return toMe(user);
  });

  app.post<{ Body: Credentials }>("/api/auth/login", async (req, reply) => {
    if (!signin.settings().passwordLogin) throw new HttpError(403, "Password sign-in is off");
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

  // TinyAuth keeps its /api/auth/oidc/... paths, so redirect URIs already set up still work.
  for (const [path, service] of [
    ["oidc", ctx.oidc],
    ["google", ctx.google],
  ] as const) {
    app.get<{ Querystring: { returnTo?: string } }>(`/api/auth/${path}/start`, async (req, reply) => {
      if (!service.enabled) throw new HttpError(404, `Sign-in with ${service.name} isn't set up`);
      return reply.redirect(await service.start(req.query.returnTo ?? "/"));
    });

    app.get(`/api/auth/${path}/callback`, async (req, reply) => {
      if (!service.enabled) throw new HttpError(404, `Sign-in with ${service.name} isn't set up`);
      try {
        const { user, returnTo, linked } = await service.finish(new URL(req.url, config.publicUrl));
        if (!linked) signIn(req, reply, user);
        const to = safeReturn(returnTo);
        return reply.redirect(linked ? `${to}${to.includes("?") ? "&" : "?"}linked=${service.provider}` : to);
      } catch (err) {
        req.log.warn({ err }, `${service.name} sign-in failed`);
        const message = encodeURIComponent(err instanceof Error ? err.message : "Sign-in failed");
        // Someone already signed in was linking; tell them in the app, not on the sign-in page.
        return reply.redirect(req.user ? `/?signin_error=${message}` : `/login?error=${message}`);
      }
    });
  }

  app.get("/api/me", async (req) => toMe(requireUser(req)));

  app.patch<{ Body: { displayName?: unknown; readReceipts?: unknown; shareActivity?: unknown; nameColor?: unknown; textColor?: unknown } }>("/api/me", async (req) => {
    const user = requireUser(req);
    const { displayName: name, readReceipts, shareActivity, nameColor, textColor } = req.body ?? {};
    if (nameColor !== undefined && nameColor !== null && !isHexColor(nameColor)) throw new HttpError(400, "nameColor is a #rrggbb color or null");
    if (textColor !== undefined && textColor !== null && !isHexColor(textColor)) throw new HttpError(400, "textColor is a #rrggbb color or null");
    if (name !== undefined && (typeof name !== "string" || !name.trim())) throw new HttpError(400, "A display name can't be empty");
    if (readReceipts !== undefined && typeof readReceipts !== "boolean") throw new HttpError(400, "readReceipts is true or false");
    if (shareActivity !== undefined && typeof shareActivity !== "boolean") throw new HttpError(400, "shareActivity is true or false");
    const updated = toMe(
      users.update(user.id, {
        displayName: typeof name === "string" ? name.trim().slice(0, LIMITS.displayNameLength) : undefined,
        readReceipts: readReceipts as boolean | undefined,
        shareActivity: shareActivity as boolean | undefined,
        nameColor: nameColor as string | null | undefined,
        textColor: textColor as string | null | undefined,
      }),
    );
    if (shareActivity !== undefined && shareActivity !== user.shareActivity) ctx.lootden.shareChanged(user.id);
    // Names and colors show everywhere, so tell everyone who can see them.
    if (name !== undefined || nameColor !== undefined || textColor !== undefined) ctx.profiles.announce(user.id);
    return updated;
  });

  app.get("/api/server", async (req): Promise<ServerInfo> => {
    requireUser(req);
    return { maxUploadBytes: config.maxUploadBytes, calls: callsEnabled(config), lootdenUrl: ctx.lootden.settings().url || null, gifs: ctx.gifs.settings().enabled };
  });
}
