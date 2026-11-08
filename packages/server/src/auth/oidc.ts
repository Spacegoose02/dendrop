import * as client from "openid-client";
import { isUsername } from "@dendrop/shared";
import type { SignInProvider } from "@dendrop/shared";
import type { ServerConfig } from "../config.js";
import type { SignInService } from "../signin.js";
import type { UserRecord, UserRepo } from "../users.js";

interface Pending {
  verifier: string;
  returnTo: string;
  expires: number;
  /** Set when a signed-in person is linking this provider to their account. */
  linkUserId?: number;
}

const GOOGLE = { issuer: "https://accounts.google.com", scopes: "openid email profile" };

/**
 * Authorization-code login with PKCE against TinyAuth (or any OpenID Connect provider:
 * Authelia, Authentik, Pocket ID ...), or Google. The TinyAuth setup is the same one LootDen
 * uses, so one client config pattern covers both apps.
 */
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private readonly config: ServerConfig,
    private readonly users: UserRepo,
    private readonly signin: SignInService,
    readonly provider: SignInProvider = "tinyauth",
  ) {}

  /** Configured, and switched on by the admin. */
  get enabled(): boolean {
    return this.signin.live()[this.provider];
  }

  get name(): string {
    return this.provider === "google" ? "Google" : this.config.oidc.name;
  }

  get redirectUri(): string {
    return `${this.config.publicUrl}/api/auth/${this.provider === "google" ? "google" : "oidc"}/callback`;
  }

  private get client(): { issuer: string; clientId: string; clientSecret: string; scopes: string } {
    return this.provider === "google" ? { ...GOOGLE, ...this.config.google } : this.config.oidc;
  }

  private discover(): Promise<client.Configuration> {
    const o = this.client;
    this.configPromise ??= client
      .discovery(new URL(o.issuer), o.clientId, o.clientSecret || undefined, o.clientSecret ? undefined : client.None(), {
        execute: new URL(o.issuer).protocol === "http:" ? [client.allowInsecureRequests] : [],
      })
      .catch((err) => {
        this.configPromise = null; // try discovery again next time
        throw err;
      });
    return this.configPromise;
  }

  async start(returnTo = "/", linkUserId?: number): Promise<string> {
    const cfg = await this.discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(state, { verifier, returnTo: safeReturn(returnTo), expires: now + 10 * 60_000, linkUserId });
    return client
      .buildAuthorizationUrl(cfg, {
        redirect_uri: this.redirectUri,
        scope: this.client.scopes,
        state,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      })
      .toString();
  }

  /**
   * Finishes the round trip. A sign-in returns the local account (made on first sign-in when
   * allowed); a link adds this provider to the account that started it.
   */
  async finish(callbackUrl: URL): Promise<{ user: UserRecord; returnTo: string; linked: boolean }> {
    const cfg = await this.discover();
    const state = callbackUrl.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error("The sign-in expired or was started elsewhere; try again");
    const tokens = await client.authorizationCodeGrant(cfg, callbackUrl, { pkceCodeVerifier: pending.verifier, expectedState: state });
    let claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
    if (tokens.access_token && claims.sub) {
      try {
        claims = { ...claims, ...(await client.fetchUserInfo(cfg, tokens.access_token, claims.sub as string)) };
      } catch {
        // Some providers have no userinfo endpoint; the ID token claims are enough.
      }
    }
    if (pending.linkUserId !== undefined) return { user: this.link(pending.linkUserId, claims), returnTo: pending.returnTo, linked: true };
    return { user: this.provider === "google" ? this.provisionGoogle(claims) : this.provision(claims), returnTo: pending.returnTo, linked: false };
  }

  /** Adds this provider's identity to an account, unless another account already has it. */
  link(userId: number, claims: Record<string, unknown>): UserRecord {
    const sub = String(claims.sub ?? "");
    if (!sub) throw new Error("The sign-in returned no account id");
    const user = this.users.byId(userId);
    if (!user) throw new Error("Your Dendrop account is gone");
    if (!this.signin.settings().linking) throw new Error("Linking sign-ins is switched off by the admin");
    if (user.isKid && user.managedBy !== null) throw new Error("Your parent looks after how this account signs in");
    const owner = this.provider === "google" ? this.users.byGoogleSubject(sub) : this.users.byOidcSubject(sub);
    if (owner && owner.id !== userId) throw new Error(`That ${this.name} account is already linked to another Dendrop account`);
    const email = typeof claims.email === "string" ? claims.email : null;
    return this.users.setSignIn(userId, this.provider, sub, email);
  }

  /**
   * Finds the account for a Google sign-in. A new Google account only gets a Dendrop account
   * when the admin allows it; otherwise people link Google from Settings first. Never matched
   * by email, since local accounts' emails aren't verified.
   */
  provisionGoogle(claims: Record<string, unknown>): UserRecord {
    const sub = String(claims.sub ?? "");
    if (!sub) throw new Error("Google returned no account id");
    const existing = this.users.byGoogleSubject(sub);
    if (existing) return existing;
    if (!this.signin.settings().googleSignup) {
      throw new Error("No Dendrop account uses this Google account yet. Sign in another way, then link Google in Settings.");
    }
    const verified = claims.email_verified === true || claims.email_verified === "true";
    const email = typeof claims.email === "string" && verified ? claims.email : null;
    const user = this.users.create({
      username: freeUsername(this.users, String(email?.split("@")[0] ?? claims.given_name ?? ""), sub),
      displayName: String(claims.name ?? email?.split("@")[0] ?? "Raccoon").slice(0, 64),
      email,
      isSuperAdmin: this.users.count() === 0,
    });
    return this.users.setSignIn(user.id, "google", sub, email);
  }

  /** Finds or makes the account for a set of TinyAuth claims. Exported for tests. */
  provision(claims: Record<string, unknown>): UserRecord {
    const sub = String(claims.sub ?? "");
    if (!sub) throw new Error("The identity provider returned no subject");
    const email = typeof claims.email === "string" ? claims.email : null;
    const preferred = String(claims.preferred_username ?? claims.nickname ?? email?.split("@")[0] ?? sub);
    const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : typeof claims.groups === "string" ? claims.groups.split(",") : [];
    const isAdmin = !!this.config.oidc.adminGroup && groups.map((g) => g.trim()).includes(this.config.oidc.adminGroup);

    let user = this.users.byOidcSubject(sub);
    if (!user) {
      // Link to a local account with the same email unless the provider says it's unverified.
      // Never by username: anyone can pick "admin" as a nickname at many providers.
      const verified = claims.email_verified !== false && claims.email_verified !== "false";
      const existing = email && verified ? this.users.byEmail(email) : undefined;
      if (existing && !existing.oidcSubject) user = this.users.update(existing.id, { oidcSubject: sub });
    }
    if (!user) {
      if (!this.signin.settings().tinyauthSignup) {
        throw new Error(`No Dendrop account uses this ${this.name} sign-in yet. Sign in another way, then link it in Settings.`);
      }
      user = this.users.create({
        username: freeUsername(this.users, preferred, sub),
        displayName: String(claims.name ?? preferred).slice(0, 64),
        email,
        oidcSubject: sub,
        isSuperAdmin: isAdmin || this.users.count() === 0,
      });
    } else if (isAdmin && !user.isSuperAdmin) {
      user = this.users.update(user.id, { isSuperAdmin: true });
    }
    return user;
  }
}

/** Only paths on this server; "//host" would leave it. */
export function safeReturn(returnTo: string): string {
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}

/** A username like the one wanted, made valid and not taken. */
function freeUsername(users: UserRepo, wanted: string, sub: string): string {
  let username = wanted.replace(/[^\w.-]/g, "_").slice(0, 32);
  if (!isUsername(username)) username = `user_${sub.replace(/[^\w]/g, "").slice(0, 16) || "x"}`;
  for (let i = 2; users.byUsername(username); i++) username = `${username.slice(0, 28)}_${i}`;
  return username;
}
