import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import QRCode from "qrcode";
import type { MyTwoFactor, PasskeyInfo, TotpSetup } from "@dendrop/shared";
import type { ServerConfig } from "../config.js";
import { now, tx, type Db } from "../db.js";
import { HttpError } from "../errors.js";
import type { UserRecord } from "../users.js";
import { safeEqual, sha256 } from "./crypto.js";

// ---- TOTP (RFC 6238): what Google Authenticator, Aegis, 1Password and friends do ---------

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1]! & 15;
  const n = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, "0");
}

export const totpStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

/** The step a code matches, allowing one step either side for clock drift; null if none. */
export function matchTotp(secret: string, code: string, at = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = totpStep(at);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpCode(secret, s), c)) return s;
  return null;
}

// ---- Recovery codes ------------------------------------------------------------------

const RECOVERY_COUNT = 10;
/** No 0/O or 1/l/I, so they're easy to copy off paper. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const newRecoveryCode = () => {
  let s = "";
  for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---- The service -----------------------------------------------------------------------

const TICKET_MINUTES = 5;
const MAX_ATTEMPTS = 5;

interface PasskeyRow {
  id: string;
  user_id: number;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Where WebAuthn says passkeys belong: the host people use, and its origin. */
export interface RelyingParty {
  id: string;
  origin: string;
}

/**
 * Two-step sign-in: an authenticator app (TOTP) with recovery codes, and passkeys, which work
 * as the second step or to sign in on their own. Only password sign-ins ask for a second step:
 * TinyAuth and Google have their own.
 */
export class TwoFactorService {
  /** The time codes are checked against; tests move it along. */
  clock: () => number = Date.now;

  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
  ) {}

  /** The relying party for a request: DENDROP_PUBLIC_URL when set, else the address it came in on. */
  relyingParty(host: string | undefined, protocol: string): RelyingParty | null {
    let url: URL;
    try {
      url = new URL(this.config.publicUrl || `${protocol}://${host ?? ""}`);
    } catch {
      return null;
    }
    // Browsers only allow passkeys on https:// (and http://localhost), and never on a bare IP.
    const local = url.hostname === "localhost";
    if (url.protocol !== "https:" && !local) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) return null;
    return { id: url.hostname, origin: url.origin };
  }

  // ---- What someone has

  totpOn(userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL").get(userId);
  }

  passkeys(userId: number): PasskeyInfo[] {
    const rows = this.db.prepare("SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as PasskeyRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** A password sign-in needs a second step. */
  required(userId: number): boolean {
    return this.totpOn(userId);
  }

  status(userId: number, rp: RelyingParty | null): MyTwoFactor {
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as { n: number };
    return { totp: this.totpOn(userId), recoveryCodesLeft: Number(left.n), passkeys: this.passkeys(userId), passkeysAvailable: !!rp };
  }

  // ---- Authenticator app

  async startTotp(user: UserRecord): Promise<TotpSetup> {
    if (this.totpOn(user.id)) throw new HttpError(409, "An authenticator app is already set up; turn it off first to set up another");
    const secret = base32Encode(randomBytes(20));
    this.db
      .prepare("INSERT INTO user_totp (user_id, secret, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, enabled_at = NULL, last_step = 0")
      .run(user.id, secret, now());
    const issuer = "Dendrop";
    const host = this.config.publicUrl ? new URL(this.config.publicUrl).hostname : "";
    const label = encodeURIComponent(`${issuer}${host ? ` (${host})` : ""}:${user.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, uri, qrSvg };
  }

  /** Checks the first code from the app and turns it on. Returns the recovery codes, shown once. */
  confirmTotp(userId: number, code: unknown): string[] {
    const row = this.db.prepare("SELECT secret, enabled_at FROM user_totp WHERE user_id = ?").get(userId) as { secret: string; enabled_at: string | null } | undefined;
    if (!row || row.enabled_at) throw new HttpError(409, "Start setting up an authenticator app first");
    const step = typeof code === "string" ? matchTotp(row.secret, code, this.clock()) : null;
    if (step === null) throw new HttpError(400, "That code isn't right. Check the time on your phone, and type the newest code");
    return tx(this.db, () => {
      this.db.prepare("UPDATE user_totp SET enabled_at = ?, last_step = ? WHERE user_id = ?").run(now(), step, userId);
      return this.replaceRecoveryCodes(userId);
    });
  }

  disableTotp(userId: number): void {
    tx(this.db, () => {
      this.db.prepare("DELETE FROM user_totp WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
    });
  }

  newRecoveryCodes(userId: number): string[] {
    if (!this.totpOn(userId)) throw new HttpError(409, "Set up an authenticator app first");
    return tx(this.db, () => this.replaceRecoveryCodes(userId));
  }

  private replaceRecoveryCodes(userId: number): string[] {
    this.db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
    const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
    const insert = this.db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const c of codes) insert.run(userId, sha256(normalizeRecovery(c)));
    return codes;
  }

  /**
   * Checks an authenticator code or a recovery code. A code works once (the step is kept), and
   * a recovery code is used up.
   */
  checkCode(userId: number, code: unknown): boolean {
    if (typeof code !== "string" || !code.trim()) return false;
    const row = this.db.prepare("SELECT secret, last_step FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL").get(userId) as
      | { secret: string; last_step: number }
      | undefined;
    if (!row) return false;
    const step = matchTotp(row.secret, code, this.clock());
    if (step !== null) {
      if (step <= row.last_step) return false;
      this.db.prepare("UPDATE user_totp SET last_step = ? WHERE user_id = ?").run(step, userId);
      return true;
    }
    const used = this.db
      .prepare("UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
      .run(now(), userId, sha256(normalizeRecovery(code)));
    return Number(used.changes) > 0;
  }

  /** Turns everything off: the app, recovery codes and passkeys (the admin's reset for someone locked out). */
  reset(userId: number): void {
    tx(this.db, () => {
      this.db.prepare("DELETE FROM user_totp WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM user_passkeys WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM auth_challenges WHERE user_id = ?").run(userId);
    });
  }

  // ---- Short-lived sign-in state

  private newChallenge(kind: string, userId: number | null, challenge: string | null = null): string {
    this.db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(now());
    const id = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + TICKET_MINUTES * 60_000).toISOString();
    this.db.prepare("INSERT INTO auth_challenges (id, kind, user_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, kind, userId, challenge, expires);
    return id;
  }

  private challenge(id: unknown, kind: string): { id: string; userId: number | null; challenge: string | null; attempts: number } {
    if (typeof id !== "string") throw new HttpError(400, "Missing ticket");
    const row = this.db.prepare("SELECT * FROM auth_challenges WHERE id = ? AND kind = ? AND expires_at > ?").get(id, kind, now()) as
      | { id: string; user_id: number | null; challenge: string | null; attempts: number }
      | undefined;
    if (!row) throw new HttpError(401, "That sign-in took too long. Start again");
    return { id: row.id, userId: row.user_id, challenge: row.challenge, attempts: row.attempts };
  }

  private endChallenge(id: string): void {
    this.db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(id);
  }

  /** After a right password: the ticket the second step is sent with. */
  loginTicket(userId: number): string {
    return this.newChallenge("login", userId);
  }

  /** The second step with a code. Returns the user id; five wrong codes end the ticket. */
  finishWithCode(ticket: unknown, code: unknown): number {
    const t = this.challenge(ticket, "login");
    if (this.checkCode(t.userId!, code)) {
      this.endChallenge(t.id);
      return t.userId!;
    }
    if (t.attempts + 1 >= MAX_ATTEMPTS) {
      this.endChallenge(t.id);
      throw new HttpError(401, "Too many wrong codes. Sign in again");
    }
    this.db.prepare("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?").run(t.id);
    throw new HttpError(401, "That code isn't right");
  }

  // ---- Passkeys

  private rows(userId: number): PasskeyRow[] {
    return this.db.prepare("SELECT * FROM user_passkeys WHERE user_id = ?").all(userId) as unknown as PasskeyRow[];
  }

  private static transports(r: PasskeyRow): AuthenticatorTransportFuture[] {
    try {
      return JSON.parse(r.transports) as AuthenticatorTransportFuture[];
    } catch {
      return [];
    }
  }

  async addOptions(user: UserRecord, rp: RelyingParty): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    if (this.rows(user.id).length >= 20) throw new HttpError(400, "That's a lot of passkeys. Remove one first");
    const options = await generateRegistrationOptions({
      rpName: "Dendrop",
      rpID: rp.id,
      userName: user.username,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(`dendrop:${user.id}`),
      attestationType: "none",
      excludeCredentials: this.rows(user.id).map((r) => ({ id: r.id, transports: TwoFactorService.transports(r) })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return { challengeId: this.newChallenge("passkey-add", user.id, options.challenge), options };
  }

  async add(user: UserRecord, rp: RelyingParty, challengeId: unknown, response: unknown, name: unknown): Promise<PasskeyInfo> {
    const c = this.challenge(challengeId, "passkey-add");
    if (c.userId !== user.id) throw new HttpError(401, "That sign-in took too long. Start again");
    this.endChallenge(c.id);
    let info;
    try {
      const v = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: c.challenge!,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
      });
      if (!v.verified || !v.registrationInfo) throw new Error("not verified");
      info = v.registrationInfo;
    } catch (err) {
      throw new HttpError(400, `That passkey didn't work: ${(err as Error).message}`);
    }
    const cred = info.credential;
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 50) : `Passkey ${this.rows(user.id).length + 1}`;
    try {
      this.db
        .prepare("INSERT INTO user_passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(cred.id, user.id, Buffer.from(cred.publicKey).toString("base64url"), cred.counter, JSON.stringify(cred.transports ?? []), label, now());
    } catch {
      throw new HttpError(409, "That passkey is already added");
    }
    return this.passkeys(user.id).find((p) => p.id === cred.id)!;
  }

  rename(userId: number, id: string, name: unknown): PasskeyInfo {
    if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "Give it a name");
    const r = this.db.prepare("UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?").run(name.trim().slice(0, 50), id, userId);
    if (!Number(r.changes)) throw new HttpError(404, "No such passkey");
    return this.passkeys(userId).find((p) => p.id === id)!;
  }

  remove(userId: number, id: string): void {
    const r = this.db.prepare("DELETE FROM user_passkeys WHERE id = ? AND user_id = ?").run(id, userId);
    if (!Number(r.changes)) throw new HttpError(404, "No such passkey");
  }

  /**
   * Options for signing in with a passkey. With a ticket (the second step after a password),
   * only that account's passkeys; without, any passkey on this device (the browser lists them).
   */
  async signInOptions(rp: RelyingParty, ticket?: unknown): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    if (ticket !== undefined) {
      const t = this.challenge(ticket, "login");
      const rows = this.rows(t.userId!);
      if (!rows.length) throw new HttpError(400, "This account has no passkeys");
      const options = await generateAuthenticationOptions({
        rpID: rp.id,
        allowCredentials: rows.map((r) => ({ id: r.id, transports: TwoFactorService.transports(r) })),
        userVerification: "preferred",
      });
      this.db.prepare("UPDATE auth_challenges SET challenge = ? WHERE id = ?").run(options.challenge, t.id);
      return { challengeId: t.id, options };
    }
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
    return { challengeId: this.newChallenge("passkey-login", null, options.challenge), options };
  }

  /** Checks a passkey sign-in and returns the account's id. */
  async finishWithPasskey(rp: RelyingParty, challengeId: unknown, response: unknown, secondStep: boolean): Promise<number> {
    const c = this.challenge(challengeId, secondStep ? "login" : "passkey-login");
    if (!c.challenge) throw new HttpError(400, "Ask for passkey options first");
    const res = response as AuthenticationResponseJSON;
    const row = typeof res?.id === "string" ? (this.db.prepare("SELECT * FROM user_passkeys WHERE id = ?").get(res.id) as unknown as PasskeyRow | undefined) : undefined;
    if (!row || (secondStep && row.user_id !== c.userId)) {
      if (!secondStep) this.endChallenge(c.id);
      throw new HttpError(401, "This server doesn't know that passkey. It may have been removed");
    }
    let newCounter: number;
    try {
      const v = await verifyAuthenticationResponse({
        response: res,
        expectedChallenge: c.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: { id: row.id, publicKey: Buffer.from(row.public_key, "base64url"), counter: row.counter, transports: TwoFactorService.transports(row) },
        // On its own, a passkey has to check it's you (PIN, fingerprint); after a password, a tap is enough.
        requireUserVerification: !secondStep,
      });
      if (!v.verified) throw new Error("not verified");
      newCounter = v.authenticationInfo.newCounter;
    } catch (err) {
      this.endChallenge(c.id);
      throw new HttpError(401, `That passkey didn't work: ${(err as Error).message}`);
    }
    this.endChallenge(c.id);
    this.db.prepare("UPDATE user_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(newCounter, now(), row.id);
    return row.user_id;
  }
}
