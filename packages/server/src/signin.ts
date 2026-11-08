import type { SignInSettings } from "@dendrop/shared";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";

const KEY = "signin";

/**
 * The super admin's switches for signing in. They start from the DENDROP_* settings and, once
 * changed in the app, are kept in the database. A provider still needs its config to work.
 */
export class SignInService {
  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
  ) {}

  private defaults(): SignInSettings {
    return {
      passwordLogin: this.config.localLogin,
      signup: this.config.signup,
      tinyauth: true,
      tinyauthSignup: this.config.oidc.autoCreate,
      google: true,
      googleSignup: false,
      linking: true,
      parentKidAccounts: true,
    };
  }

  settings(): SignInSettings {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!r) return this.defaults();
    try {
      return { ...this.defaults(), ...(JSON.parse(r.value) as Partial<SignInSettings>) };
    } catch {
      return this.defaults();
    }
  }

  save(patch: Record<string, unknown>): SignInSettings {
    const next = this.settings();
    for (const key of Object.keys(this.defaults()) as (keyof SignInSettings)[]) {
      const v = patch[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") throw new HttpError(400, `${key} is true or false`);
      next[key] = v;
    }
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(KEY, JSON.stringify(next));
    return next;
  }

  get tinyauthConfigured(): boolean {
    const o = this.config.oidc;
    return !!(o.issuer && o.clientId && this.config.publicUrl);
  }

  get googleConfigured(): boolean {
    const g = this.config.google;
    return !!(g.clientId && g.clientSecret && this.config.publicUrl);
  }

  /** Whether each way in works right now: configured and switched on. */
  live(s: SignInSettings = this.settings()): { password: boolean; tinyauth: boolean; google: boolean } {
    return { password: s.passwordLogin, tinyauth: s.tinyauth && this.tinyauthConfigured, google: s.google && this.googleConfigured };
  }
}
