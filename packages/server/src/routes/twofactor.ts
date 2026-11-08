import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireUser, type Context } from "../app.js";
import { verifyPassword } from "../auth/crypto.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { HttpError } from "../errors.js";
import { toMe, type UserRecord } from "../users.js";
import { startSession } from "./auth.js";

/**
 * Two-step sign-in and passkeys: the second step after a password, signing in with a passkey,
 * and setting them up in Settings → Sign-in.
 */
export function twoFactorRoutes(app: FastifyInstance, ctx: Context): void {
  const { twofactor, users, sessions } = ctx;

  const rp = (req: FastifyRequest) => {
    const r = twofactor.relyingParty(req.headers.host, req.protocol);
    if (!r) throw new HttpError(400, "Passkeys need Dendrop on an https:// address with a name (not an IP address)");
    return r;
  };
  const active = (id: number): UserRecord => {
    const u = users.byId(id);
    if (!u || u.isBot) throw new HttpError(401, "Sign in again");
    return u;
  };
  /** Kid accounts under a parent: the parent looks after how they sign in. */
  const own = (req: FastifyRequest): UserRecord => {
    const me = requireUser(req);
    if (me.isBot) throw new HttpError(403, "Bots don't sign in");
    if (me.isKid && me.managedBy !== null) throw new HttpError(403, "Your parent looks after how this account signs in");
    return me;
  };
  /** Turning things off needs proof it's really you: a code from the app, or your password. */
  const proveIt = async (me: UserRecord, body: { code?: unknown; password?: unknown } | undefined) => {
    if (body?.code !== undefined && twofactor.checkCode(me.id, body.code)) return;
    if (typeof body?.password === "string" && me.passwordHash && (await verifyPassword(body.password, me.passwordHash))) return;
    throw new HttpError(403, "Type a code from your authenticator app (or a recovery code) to do that");
  };

  // ---- Signing in ------------------------------------------------------------------

  /** The second step after a password: { ticket, code } (an app code or a recovery code). */
  app.post<{ Body: { ticket?: unknown; code?: unknown } }>("/api/auth/2fa", async (req, reply) => {
    const user = active(twofactor.finishWithCode(req.body?.ticket, req.body?.code));
    startSession(ctx, req, reply, user);
    return toMe(user);
  });

  app.post<{ Body: { ticket?: unknown } }>("/api/auth/2fa/passkey/options", async (req) => twofactor.signInOptions(rp(req), req.body?.ticket ?? ""));

  app.post<{ Body: { ticket?: unknown; response?: unknown } }>("/api/auth/2fa/passkey", async (req, reply) => {
    const user = active(await twofactor.finishWithPasskey(rp(req), req.body?.ticket, req.body?.response, true));
    startSession(ctx, req, reply, user);
    return toMe(user);
  });

  /** "Sign in with a passkey": no username or password. */
  app.post("/api/auth/passkey/options", async (req) => twofactor.signInOptions(rp(req)));

  app.post<{ Body: { challengeId?: unknown; response?: unknown } }>("/api/auth/passkey", async (req, reply) => {
    const user = active(await twofactor.finishWithPasskey(rp(req), req.body?.challengeId, req.body?.response, false));
    startSession(ctx, req, reply, user);
    return toMe(user);
  });

  // ---- Settings → Sign-in ------------------------------------------------------------

  app.get("/api/me/2fa", async (req) => twofactor.status(requireUser(req).id, twofactor.relyingParty(req.headers.host, req.protocol)));

  /** Starts setting up an authenticator app: the QR code to scan. */
  app.post("/api/me/2fa/totp/start", async (req) => {
    const me = own(req);
    if (!me.passwordHash) throw new HttpError(409, "Two-step sign-in protects your password. Set a password first");
    return twofactor.startTotp(me);
  });

  /** { code }: the first code from the app turns it on. Answers with the recovery codes, shown once. Signs out other devices. */
  app.post<{ Body: { code?: unknown } }>("/api/me/2fa/totp/confirm", async (req) => {
    const me = own(req);
    const recoveryCodes = twofactor.confirmTotp(me.id, req.body?.code);
    sessions.endAllFor(me.id, req.cookies[SESSION_COOKIE]);
    return { recoveryCodes, status: twofactor.status(me.id, twofactor.relyingParty(req.headers.host, req.protocol)) };
  });

  /** { code } or { password }: turns the app off, and the recovery codes with it. */
  app.post<{ Body: { code?: unknown; password?: unknown } }>("/api/me/2fa/totp/disable", async (req) => {
    const me = own(req);
    if (!twofactor.totpOn(me.id)) throw new HttpError(409, "Two-step sign-in is already off");
    await proveIt(me, req.body);
    twofactor.disableTotp(me.id);
    return twofactor.status(me.id, twofactor.relyingParty(req.headers.host, req.protocol));
  });

  /** { code }: a fresh set of recovery codes; the old ones stop working. */
  app.post<{ Body: { code?: unknown; password?: unknown } }>("/api/me/2fa/recovery", async (req) => {
    const me = own(req);
    await proveIt(me, req.body);
    return { recoveryCodes: twofactor.newRecoveryCodes(me.id) };
  });

  app.post("/api/me/passkeys/options", async (req) => twofactor.addOptions(own(req), rp(req)));

  /** { challengeId, response, name? }: saves the passkey the browser just made. */
  app.post<{ Body: { challengeId?: unknown; response?: unknown; name?: unknown } }>("/api/me/passkeys", async (req) => {
    const me = own(req);
    return twofactor.add(me, rp(req), req.body?.challengeId, req.body?.response, req.body?.name);
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/me/passkeys/:id", async (req) => twofactor.rename(own(req).id, req.params.id, req.body?.name));

  app.delete<{ Params: { id: string } }>("/api/me/passkeys/:id", async (req) => {
    const me = own(req);
    if (!twofactor.passkeys(me.id).some((p) => p.id === req.params.id)) throw new HttpError(404, "No such passkey");
    const signin = ctx.signin.live(ctx.signin.settings());
    const others = (me.passwordHash && signin.password) || (me.oidcSubject && signin.tinyauth) || (me.googleSubject && signin.google) || twofactor.passkeys(me.id).length > 1;
    if (!others) throw new HttpError(409, "This passkey is your only way to sign in. Set a password or link another sign-in first");
    twofactor.remove(me.id, req.params.id);
    return twofactor.status(me.id, twofactor.relyingParty(req.headers.host, req.protocol));
  });

  // ---- The super admin -------------------------------------------------------------

  /** For someone who lost their phone: turns off their authenticator app and removes their passkeys. */
  app.delete<{ Params: { id: string } }>("/api/admin/accounts/:id/2fa", async (req) => {
    const me = requireUser(req);
    if (!me.isSuperAdmin) throw new HttpError(403, "Only a super admin can do that");
    const u = users.byId(Number(req.params.id));
    if (!u || u.isBot) throw new HttpError(404, "No such account");
    twofactor.reset(u.id);
    sessions.endAllFor(u.id, u.id === me.id ? req.cookies[SESSION_COOKIE] : undefined);
    return { ok: true };
  });
}
