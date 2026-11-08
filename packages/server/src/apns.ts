import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { ApnsConfig } from "./config.js";

/** Apple's two push gateways: TestFlight and App Store builds use production, Xcode builds sandbox. */
export type ApnsEnvironment = "production" | "sandbox";

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Sends one request to APNs and returns its status and, on failure, Apple's reason. Replaced in tests. */
export type ApnsSend = (req: ApnsRequest) => Promise<{ status: number; reason?: string }>;

/** A token from the iOS app: what Apple gave it, hex. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

/**
 * Talks to Apple Push Notification service with a token key (.p8), over HTTP/2.
 * No library: a push is one POST with an ES256 JWT, which node:crypto signs.
 */
export class ApnsClient {
  private readonly key: KeyObject;
  private jwt: { token: string; at: number } | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly send: ApnsSend = http2Send,
  ) {
    this.key = createPrivateKey(config.key);
  }

  get bundleId(): string {
    return this.config.bundleId;
  }

  /**
   * Sends a push. `voip` pushes wake the app to show the native incoming call screen (PushKit);
   * the others are ordinary alerts that iOS shows itself.
   * Returns the HTTP status, with 410 also for tokens Apple says are no good any more.
   */
  async push(env: ApnsEnvironment, token: string, voip: boolean, payload: object, options: { ttlSeconds: number; collapseId?: string }): Promise<number> {
    const headers: Record<string, string> = {
      authorization: `bearer ${this.token()}`,
      "apns-push-type": voip ? "voip" : "alert",
      "apns-topic": voip ? `${this.config.bundleId}.voip` : this.config.bundleId,
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + options.ttlSeconds),
      "content-type": "application/json",
    };
    if (options.collapseId) headers["apns-collapse-id"] = options.collapseId;
    const { status, reason } = await this.send({
      host: env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com",
      path: `/3/device/${token}`,
      headers,
      body: JSON.stringify(payload),
    });
    if (status === 403 && reason === "ExpiredProviderToken") this.jwt = null;
    // A token for another app or the other environment never starts working; forget it like a gone one.
    if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return 410;
    return status;
  }

  /** The provider token. Apple wants a new one at most every 20 minutes and at least every hour. */
  private token(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.jwt && nowSec - this.jwt.at < 40 * 60) return this.jwt.token;
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "ES256", kid: this.config.keyId })}.${part({ iss: this.config.teamId, iat: nowSec })}`;
    const sig = sign("sha256", Buffer.from(unsigned), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { token: `${unsigned}.${sig}`, at: nowSec };
    return this.jwt.token;
  }
}

const sessions = new Map<string, http2.ClientHttp2Session>();

/** One kept-open HTTP/2 connection per APNs host, as Apple asks. */
function session(host: string): http2.ClientHttp2Session {
  const open = sessions.get(host);
  if (open && !open.closed && !open.destroyed) return open;
  const s = http2.connect(`https://${host}`);
  s.unref();
  const forget = () => {
    if (sessions.get(host) === s) sessions.delete(host);
  };
  s.on("close", forget);
  s.on("goaway", forget);
  s.on("error", forget);
  sessions.set(host, s);
  return s;
}

const http2Send: ApnsSend = (req) =>
  new Promise((resolve, reject) => {
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session(req.host).request({ ":method": "POST", ":path": req.path, ...req.headers });
    } catch (err) {
      reject(err);
      return;
    }
    stream.setTimeout(10_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    let status = 0;
    let data = "";
    stream.on("response", (h) => (status = Number(h[":status"])));
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (data += c));
    stream.on("end", () => {
      let reason: string | undefined;
      try {
        reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
      } catch {
        // Not JSON; the status says enough.
      }
      resolve({ status, reason });
    });
    // Closed without an answer (timed out): status stays 0, which counts as "try again later".
    stream.on("close", () => resolve({ status }));
    stream.on("error", reject);
    stream.end(req.body);
  });
