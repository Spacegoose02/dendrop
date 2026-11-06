import path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** The address people use, e.g. https://chat.example.com. Needed for OIDC and secure cookies. */
  publicUrl: string;
  webDir: string | null;
  /** Sign-in with a username and password. On by default so the first account can be made. */
  localLogin: boolean;
  /** Anyone can make a local account. Off by default: people sign in through TinyAuth instead. */
  signup: boolean;
  /** Largest file a message can carry. */
  maxUploadBytes: number;
  /** Voice and video through a LiveKit server. Calls are off unless all three are set. */
  livekit: { url: string; apiKey: string; apiSecret: string };
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    name: string;
    scopes: string;
    /** Members of this group become super admins. */
    adminGroup: string;
    autoCreate: boolean;
  };
}

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v.trim());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.DENDROP_PORT ?? 8080),
    host: env.DENDROP_HOST ?? "0.0.0.0",
    dataDir: path.resolve(env.DENDROP_DATA_DIR ?? "/data"),
    publicUrl: (env.DENDROP_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
    webDir: env.DENDROP_WEB_DIR ?? null,
    localLogin: bool(env.DENDROP_LOCAL_LOGIN, true),
    signup: bool(env.DENDROP_SIGNUP, false),
    maxUploadBytes: Math.max(1, Number(env.DENDROP_MAX_UPLOAD_MB) || 25) * 1024 * 1024,
    livekit: {
      url: (env.DENDROP_LIVEKIT_URL ?? "").trim(),
      apiKey: (env.DENDROP_LIVEKIT_API_KEY ?? "").trim(),
      apiSecret: (env.DENDROP_LIVEKIT_API_SECRET ?? "").trim(),
    },
    oidc: {
      issuer: (env.DENDROP_OIDC_ISSUER ?? "").trim(),
      clientId: (env.DENDROP_OIDC_CLIENT_ID ?? "").trim(),
      clientSecret: (env.DENDROP_OIDC_CLIENT_SECRET ?? "").trim(),
      name: env.DENDROP_OIDC_NAME || "TinyAuth",
      scopes: env.DENDROP_OIDC_SCOPES || "openid profile email groups",
      adminGroup: (env.DENDROP_OIDC_ADMIN_GROUP ?? "").trim(),
      autoCreate: bool(env.DENDROP_OIDC_AUTO_CREATE, true),
    },
  };
}
