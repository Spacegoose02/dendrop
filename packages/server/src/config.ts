import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
  /** Allow http:// push endpoints, for a ntfy server on the home network. */
  pushAllowHttp: boolean;
  /**
   * Serve HTTPS directly, without a reverse proxy: PEM files for the certificate (with any
   * chain) and its private key. Null: plain HTTP, for running behind a proxy that does HTTPS.
   */
  tls: { cert: string; key: string } | null;
  /**
   * Voice and video through LiveKit. Either the copy built into the Docker image (`builtin`
   * set, `url` empty: browsers reach it through Dendrop's own address), or a separate LiveKit
   * server (`url`, `apiKey` and `apiSecret` all set). Calls are off otherwise.
   */
  livekit: { url: string; apiKey: string; apiSecret: string; builtin: BuiltinLivekit | null };
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
  /** "Sign in with Google": an OAuth client from Google Cloud. Off unless both are set. */
  google: { clientId: string; clientSecret: string };
}

/** The LiveKit server shipped in the Docker image, started and stopped by Dendrop. */
export interface BuiltinLivekit {
  bin: string;
  /** Where Dendrop reaches it. Only Dendrop talks to this port, so it stays on 127.0.0.1. */
  signalPort: number;
  /** Media ports. The host ports must be the same numbers, because they're sent to callers. */
  tcpPort: number;
  udpPort: number;
  /** The address callers send media to. Empty: LiveKit finds the public IP itself. */
  nodeIp: string;
}

export function callsEnabled(config: ServerConfig): boolean {
  const l = config.livekit;
  return !!(l.apiKey && l.apiSecret && (l.url || l.builtin));
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
    pushAllowHttp: bool(env.DENDROP_PUSH_ALLOW_HTTP, false),
    tls: tlsConfig(env),
    livekit: livekitConfig(env),
    oidc: {
      issuer: (env.DENDROP_OIDC_ISSUER ?? "").trim(),
      clientId: (env.DENDROP_OIDC_CLIENT_ID ?? "").trim(),
      clientSecret: (env.DENDROP_OIDC_CLIENT_SECRET ?? "").trim(),
      name: env.DENDROP_OIDC_NAME || "TinyAuth",
      scopes: env.DENDROP_OIDC_SCOPES || "openid profile email groups",
      adminGroup: (env.DENDROP_OIDC_ADMIN_GROUP ?? "").trim(),
      autoCreate: bool(env.DENDROP_OIDC_AUTO_CREATE, true),
    },
    google: {
      clientId: (env.DENDROP_GOOGLE_CLIENT_ID ?? "").trim(),
      clientSecret: (env.DENDROP_GOOGLE_CLIENT_SECRET ?? "").trim(),
    },
  };
}

/**
 * DENDROP_TLS_CERT and DENDROP_TLS_KEY: your own certificate files (e.g. from `tailscale cert`
 * or Let's Encrypt). DENDROP_HTTPS=self-signed: a certificate made for this server the first
 * time it starts (docker-entrypoint.sh makes it, in /data/tls), which browsers warn about once.
 */
function tlsConfig(env: NodeJS.ProcessEnv): ServerConfig["tls"] {
  const cert = (env.DENDROP_TLS_CERT ?? "").trim();
  const key = (env.DENDROP_TLS_KEY ?? "").trim();
  if (cert && key) return { cert, key };
  if ((env.DENDROP_HTTPS ?? "").trim().toLowerCase() === "self-signed") {
    const dir = path.join(path.resolve(env.DENDROP_DATA_DIR ?? "/data"), "tls");
    return { cert: path.join(dir, "self-signed.crt"), key: path.join(dir, "self-signed.key") };
  }
  return null;
}

const port = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

/**
 * DENDROP_LIVEKIT_URL set: a separate LiveKit server, as before. Otherwise the built-in one,
 * when the image has it and DENDROP_CALLS isn't "off".
 */
function livekitConfig(env: NodeJS.ProcessEnv): ServerConfig["livekit"] {
  const url = (env.DENDROP_LIVEKIT_URL ?? "").trim();
  const off = { url: "", apiKey: "", apiSecret: "", builtin: null };
  if (!bool(env.DENDROP_CALLS, true)) return off;
  if (url) {
    return { url, apiKey: (env.DENDROP_LIVEKIT_API_KEY ?? "").trim(), apiSecret: (env.DENDROP_LIVEKIT_API_SECRET ?? "").trim(), builtin: null };
  }
  const bin = env.DENDROP_LIVEKIT_BIN || "/usr/local/bin/livekit-server";
  if (!existsSync(bin)) return off;
  return {
    url: "",
    // Only this process uses the key, so a new one each start is fine.
    apiKey: "dendrop",
    apiSecret: randomBytes(32).toString("base64url"),
    builtin: {
      bin,
      signalPort: port(env.DENDROP_CALLS_SIGNAL_PORT, 7880),
      tcpPort: port(env.DENDROP_CALLS_TCP_PORT, 7881),
      udpPort: port(env.DENDROP_CALLS_UDP_PORT, 7882),
      nodeIp: (env.DENDROP_CALLS_IP ?? "").trim(),
    },
  };
}
