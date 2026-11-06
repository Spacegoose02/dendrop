import * as client from "openid-client";
import { isUsername } from "@dendrop/shared";
import type { ServerConfig } from "../config.js";
import type { UserRecord, UserRepo } from "../users.js";

interface Pending {
  verifier: string;
  returnTo: string;
  expires: number;
}

/**
 * Authorization-code login with PKCE against TinyAuth, or any OpenID Connect provider
 * (Authelia, Authentik, Pocket ID ...). The same setup LootDen uses, so one TinyAuth
 * client config pattern covers both apps.
 */
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private readonly config: ServerConfig,
    private readonly users: UserRepo,
  ) {}

  get enabled(): boolean {
    const o = this.config.oidc;
    return !!(o.issuer && o.clientId && this.config.publicUrl);
  }

  get redirectUri(): string {
    return `${this.config.publicUrl}/api/auth/oidc/callback`;
  }

  private discover(): Promise<client.Configuration> {
    const o = this.config.oidc;
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

  async start(returnTo = "/"): Promise<string> {
    const cfg = await this.discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(state, { verifier, returnTo: safeReturn(returnTo), expires: now + 10 * 60_000 });
    return client
      .buildAuthorizationUrl(cfg, {
        redirect_uri: this.redirectUri,
        scope: this.config.oidc.scopes,
        state,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      })
      .toString();
  }

  /** Finishes the login and returns the local account (made on first login when allowed). */
  async finish(callbackUrl: URL): Promise<{ user: UserRecord; returnTo: string }> {
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
    return { user: this.provision(claims), returnTo: pending.returnTo };
  }

  /** Finds or makes the account for a set of OIDC claims. Exported for tests. */
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
      if (!this.config.oidc.autoCreate) throw new Error("There's no account for this sign-in; ask the admin to make one");
      let username = preferred.replace(/[^\w.-]/g, "_").slice(0, 32);
      if (!isUsername(username)) username = `user_${sub.replace(/[^\w]/g, "").slice(0, 16) || "x"}`;
      for (let i = 2; this.users.byUsername(username); i++) username = `${username.slice(0, 28)}_${i}`;
      user = this.users.create({
        username,
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
