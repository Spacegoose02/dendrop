import type { FastifyInstance } from "fastify";
import type { AdminAccount, AdminSignIn, MySignIns, SignInProvider, SignInSettings } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { HttpError } from "../errors.js";
import { toPublic, type UserRecord } from "../users.js";
import { MIN_PASSWORD } from "./auth.js";

const provider = (v: unknown): SignInProvider => {
  if (v === "tinyauth" || v === "google") return v;
  throw new HttpError(404, "No such sign-in");
};

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

const newPassword = (v: unknown): string => {
  if (typeof v !== "string" || v.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
  return v;
};

/** Linked sign-ins in Settings, and the super admin's sign-in switches and account list. */
export function signInRoutes(app: FastifyInstance, ctx: Context): void {
  const { users, signin, sessions, config } = ctx;
  const services = { tinyauth: ctx.oidc, google: ctx.google };

  /** The ways `u` could sign in with these settings. */
  const waysIn = (u: UserRecord, s: SignInSettings = signin.settings()): ("password" | SignInProvider)[] => {
    const live = signin.live(s);
    const ways: ("password" | SignInProvider)[] = [];
    if (u.passwordHash && live.password) ways.push("password");
    if (u.oidcSubject && live.tinyauth) ways.push("tinyauth");
    if (u.googleSubject && live.google) ways.push("google");
    return ways;
  };

  const managed = (u: UserRecord) => u.isKid && u.managedBy !== null;

  const mine = (u: UserRecord): MySignIns => {
    const s = signin.settings();
    const live = signin.live(s);
    const manager = managed(u) ? users.byId(u.managedBy!) : undefined;
    return {
      password: !!u.passwordHash,
      tinyauth: { name: config.oidc.name, linked: !!u.oidcSubject, available: live.tinyauth },
      google: { linked: !!u.googleSubject, email: u.googleEmail, available: live.google },
      canLink: s.linking && !managed(u),
      managedBy: manager ? toPublic(manager) : null,
    };
  };

  app.get("/api/me/signins", async (req) => mine(requireUser(req)));

  /** Starts linking a provider: returns the address to send the browser to. */
  app.post<{ Params: { provider: string } }>("/api/me/signins/:provider", async (req) => {
    const me = requireUser(req);
    const p = provider(req.params.provider);
    if (managed(me)) throw new HttpError(403, "Your parent looks after how this account signs in");
    if (!signin.settings().linking) throw new HttpError(403, "Linking sign-ins is switched off by the admin");
    const service = services[p];
    if (!service.enabled) throw new HttpError(404, `Sign-in with ${service.name} isn't set up`);
    return { url: await service.start("/", me.id) };
  });

  app.delete<{ Params: { provider: string } }>("/api/me/signins/:provider", async (req) => {
    const me = requireUser(req);
    const p = provider(req.params.provider);
    if (managed(me)) throw new HttpError(403, "Your parent looks after how this account signs in");
    const after = { ...me, oidcSubject: p === "tinyauth" ? null : me.oidcSubject, googleSubject: p === "google" ? null : me.googleSubject };
    if (waysIn(after).length === 0) throw new HttpError(409, "Add another way to sign in first, or you'd be locked out");
    return mine(users.setSignIn(me.id, p, null));
  });

  /** Sets or changes your password. Changing it needs the current one, and signs out your other devices. */
  app.put<{ Body: { current?: unknown; password?: unknown } }>("/api/me/password", async (req) => {
    const me = requireUser(req);
    if (managed(me)) throw new HttpError(403, "Ask your parent to change your password");
    const password = newPassword(req.body?.password);
    if (me.passwordHash && !(await verifyPassword(typeof req.body?.current === "string" ? req.body.current : "", me.passwordHash))) {
      throw new HttpError(403, "Your current password isn't right");
    }
    users.update(me.id, { passwordHash: await hashPassword(password) });
    sessions.endAllFor(me.id, req.cookies[SESSION_COOKIE]);
    return mine(users.byId(me.id)!);
  });

  // ---- The super admin's master control ---------------------------------------------

  const admin = (req: Parameters<typeof requireUser>[0]) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
    return me;
  };

  const adminView = (): AdminSignIn => ({
    settings: signin.settings(),
    configured: { tinyauth: signin.tinyauthConfigured, tinyauthName: config.oidc.name, google: signin.googleConfigured, publicUrl: !!config.publicUrl },
  });

  app.get("/api/admin/signin", async (req) => {
    admin(req);
    return adminView();
  });

  app.put<{ Body: Record<string, unknown> }>("/api/admin/signin", async (req) => {
    const me = admin(req);
    const body = req.body ?? {};
    // Check before saving that the admin making the change can still get in afterwards.
    const preview = { ...signin.settings() };
    for (const k of Object.keys(preview) as (keyof SignInSettings)[]) if (typeof body[k] === "boolean") preview[k] = body[k] as boolean;
    if (waysIn(me, preview).length === 0) throw new HttpError(409, "That would lock you out: link another way to sign in to your own account first");
    signin.save(body);
    return adminView();
  });

  const account = (u: UserRecord): AdminAccount => ({
    user: toPublic(u),
    isSuperAdmin: u.isSuperAdmin,
    isKid: u.isKid,
    managedBy: u.isKid && u.managedBy ? (users.byId(u.managedBy)?.displayName ?? null) : null,
    password: !!u.passwordHash,
    tinyauth: !!u.oidcSubject,
    google: u.googleSubject ? (u.googleEmail ?? "linked") : null,
    createdAt: u.createdAt,
  });

  app.get("/api/admin/accounts", async (req) => {
    admin(req);
    return users.all().map(account);
  });

  /** Removes someone's linked sign-in, e.g. a lost or shared Google account. */
  app.delete<{ Params: { id: string; provider: string } }>("/api/admin/accounts/:id/signins/:provider", async (req) => {
    admin(req);
    const u = users.byId(id(req.params.id));
    if (!u || u.isBot) throw new HttpError(404, "No such account");
    return account(users.setSignIn(u.id, provider(req.params.provider), null));
  });

  /** Sets someone's password, for when they're locked out. Signs them out everywhere. */
  app.put<{ Params: { id: string }; Body: { password?: unknown } }>("/api/admin/accounts/:id/password", async (req) => {
    admin(req);
    const u = users.byId(id(req.params.id));
    if (!u || u.isBot) throw new HttpError(404, "No such account");
    users.update(u.id, { passwordHash: await hashPassword(newPassword(req.body?.password)) });
    sessions.endAllFor(u.id);
    return account(users.byId(u.id)!);
  });
}
