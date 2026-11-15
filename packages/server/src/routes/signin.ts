import type { FastifyInstance } from "fastify";
import type { AdminAccount, AdminSignIn, MySignIns, SignInMove, SignInProvider, SignInSettings } from "@dendrop/shared";
import { requireUser, type Context } from "../app.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { HttpError } from "../errors.js";
import { couplesAllowed, toMe, toPublic, type UserRecord } from "../users.js";
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
  const waysIn = (u: UserRecord, s: SignInSettings = signin.settings()): ("password" | "passkey" | SignInProvider)[] => {
    const live = signin.live(s);
    const ways: ("password" | "passkey" | SignInProvider)[] = [];
    if (u.passwordHash && live.password) ways.push("password");
    if (u.oidcSubject && live.tinyauth) ways.push("tinyauth");
    if (u.googleSubject && live.google) ways.push("google");
    if (ctx.twofactor.passkeys(u.id).length) ways.push("passkey");
    return ways;
  };

  const managed = (u: UserRecord) => u.isKid && u.managedBy !== null;

  /** Why a provider can't be linked right now, or null. Setup hints only go to super admins. */
  const note = (u: UserRecord, p: SignInProvider, s: SignInSettings): string | null => {
    const name = services[p].name;
    const configured = p === "tinyauth" ? signin.tinyauthConfigured : signin.googleConfigured;
    if (!configured) {
      if (!u.isSuperAdmin) return null;
      return p === "tinyauth"
        ? "Not set up on this server yet: add DENDROP_OIDC_ISSUER, DENDROP_OIDC_CLIENT_ID and DENDROP_PUBLIC_URL, then restart Dendrop."
        : "Not set up on this server yet: add DENDROP_GOOGLE_CLIENT_ID, DENDROP_GOOGLE_CLIENT_SECRET and DENDROP_PUBLIC_URL, then restart Dendrop.";
    }
    if (!s[p]) return u.isSuperAdmin ? `${name} sign-in is switched off in Instance admin → Sign-in.` : `The admin has switched off signing in with ${name}.`;
    return null;
  };

  const mine = (u: UserRecord): MySignIns => {
    const s = signin.settings();
    const live = signin.live(s);
    const manager = managed(u) ? users.byId(u.managedBy!) : undefined;
    return {
      password: !!u.passwordHash,
      tinyauth: { name: config.oidc.name, linked: !!u.oidcSubject, available: live.tinyauth, account: u.oidcSubject ? (u.oidcEmail ?? u.oidcUsername) : null, note: note(u, "tinyauth", s) },
      google: { linked: !!u.googleSubject, email: u.googleEmail, available: live.google, note: note(u, "google", s) },
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

  // ---- Moving a login that a different account has ---------------------------------------
  // Linking a login that's already on another account (often one a first sign-in made by
  // itself) comes back here with an offer. The round trip proved they own that login, so they
  // could already sign in to that account: moving the login over gives them nothing new.

  const offerFor = (me: UserRecord, p: SignInProvider, token: string) => {
    const offer = services[p].moveOffer(token, me.id);
    if (!offer) throw new HttpError(404, "That offer has run out. Link it again from Settings → Sign-in.");
    const from = users.byId(offer.fromId);
    const subject = from && (p === "tinyauth" ? from.oidcSubject : from.googleSubject);
    if (!from || !subject) throw new HttpError(409, "That login isn't on the other account any more. Link it again from Settings → Sign-in.");
    return from;
  };

  const otherWays = (u: UserRecord, p: SignInProvider) => waysIn({ ...u, oidcSubject: p === "tinyauth" ? null : u.oidcSubject, googleSubject: p === "google" ? null : u.googleSubject });

  app.get<{ Params: { provider: string; token: string } }>("/api/me/signins/:provider/moves/:token", async (req): Promise<SignInMove> => {
    const me = requireUser(req);
    const p = provider(req.params.provider);
    const from = offerFor(me, p, req.params.token);
    const messages = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND deleted_at IS NULL").get(from.id) as { n: number }).n;
    return {
      provider: p,
      name: services[p].name,
      login: p === "tinyauth" ? (from.oidcEmail ?? from.oidcUsername) : from.googleEmail,
      from: { user: toPublic(from), createdAt: from.createdAt, messages: Number(messages), otherWaysIn: otherWays(from, p) },
    };
  });

  /** Moves the login to your account. The other account stays, without it. */
  app.post<{ Params: { provider: string; token: string } }>("/api/me/signins/:provider/moves/:token", async (req) => {
    const me = requireUser(req);
    const p = provider(req.params.provider);
    if (managed(me)) throw new HttpError(403, "Your parent looks after how this account signs in");
    if (!signin.settings().linking) throw new HttpError(403, "Linking sign-ins is switched off by the admin");
    const from = offerFor(me, p, req.params.token);
    if (managed(from)) throw new HttpError(403, "That login is on a kid account its parent looks after. Ask the admin to move it.");
    services[p].dropMoveOffer(req.params.token);
    req.log.info({ userId: me.id, fromId: from.id, provider: p }, "sign-in moved between accounts");
    return mine(users.moveSignIn(from.id, me.id, p));
  });

  app.delete<{ Params: { provider: string; token: string } }>("/api/me/signins/:provider/moves/:token", async (req) => {
    const me = requireUser(req);
    const p = provider(req.params.provider);
    if (services[p].moveOffer(req.params.token, me.id)) services[p].dropMoveOffer(req.params.token);
    return { ok: true };
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
    tinyauthLogin: u.oidcSubject ? { subject: u.oidcSubject, email: u.oidcEmail, username: u.oidcUsername } : null,
    google: u.googleSubject ? (u.googleEmail ?? "linked") : null,
    createdAt: u.createdAt,
    twoFactor: ctx.twofactor.totpOn(u.id),
    passkeys: ctx.twofactor.passkeys(u.id).length,
    couplesKit: couplesAllowed(u),
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

  /**
   * Links a login to an account: `fromAccount` moves it over from another account; `subject`
   * links a TinyAuth login by its subject (the "sub" TinyAuth sends). A subject that another
   * account has needs `move: true`. Whatever login of that kind the account had is replaced.
   */
  app.put<{ Params: { id: string; provider: string }; Body: { fromAccount?: unknown; subject?: unknown; move?: unknown } }>(
    "/api/admin/accounts/:id/signins/:provider",
    async (req) => {
      admin(req);
      const p = provider(req.params.provider);
      const u = users.byId(id(req.params.id));
      if (!u || u.isBot) throw new HttpError(404, "No such account");
      const body = req.body ?? {};
      const subjectOf = (x: UserRecord) => (p === "tinyauth" ? x.oidcSubject : x.googleSubject);
      let from: UserRecord | undefined;
      if (body.fromAccount !== undefined) {
        from = users.byId(id(body.fromAccount));
        if (!from || from.isBot || !subjectOf(from)) throw new HttpError(404, `That account has no ${services[p].name} sign-in to move`);
      } else {
        if (p !== "tinyauth") throw new HttpError(400, "Move a Google sign-in from another account, or have them link it in Settings");
        const subject = typeof body.subject === "string" ? body.subject.trim() : "";
        if (!subject || subject.length > 300) throw new HttpError(400, "Give the TinyAuth subject (its \"sub\")");
        from = users.byOidcSubject(subject);
        if (!from) return account(users.setSignIn(u.id, "tinyauth", subject));
        if (from.id !== u.id && body.move !== true) {
          throw new HttpError(409, `That ${services[p].name} login is on @${from.username}. Move it to @${u.username}?`);
        }
      }
      if (from.id === u.id) return account(u);
      req.log.info({ userId: u.id, fromId: from.id, provider: p }, "admin moved a sign-in between accounts");
      return account(users.moveSignIn(from.id, u.id, p));
    },
  );

  /**
   * Switches the couples kit on or off for an account. Kid accounts are always refused. Turning
   * it off deletes every kit they're in, like either person turning that kit off.
   */
  app.put<{ Params: { id: string }; Body: { on?: unknown } }>("/api/admin/accounts/:id/couples", async (req) => {
    admin(req);
    const u = users.byId(id(req.params.id));
    if (!u || u.isBot) throw new HttpError(404, "No such account");
    if (typeof req.body?.on !== "boolean") throw new HttpError(400, "on is true or false");
    if (req.body.on && u.isKid) throw new HttpError(403, "Kid accounts can never have the couples kit");
    if (u.isSuperAdmin) throw new HttpError(409, "Super admins always have the couples kit");
    const updated = users.setCouplesKit(u.id, req.body.on);
    if (!req.body.on) ctx.couples.wipeFor(u.id);
    ctx.gateway.send([u.id], { type: "ready", user: toMe(updated) });
    return account(updated);
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
