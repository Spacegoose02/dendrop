import webpush from "web-push";
import { now, type Db } from "./db.js";
import { HttpError } from "./errors.js";

/** The only things a push ever says. No text, names or conversation ids. */
export type PushKind = "message" | "call";

export interface PushSubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
  provider?: unknown;
  deviceName?: unknown;
}

interface Row {
  endpoint: string;
  user_id: number;
  p256dh: string | null;
  auth: string | null;
}

/** Sends content-free wake-ups to phones (UnifiedPush, or any Web Push endpoint). */
export class PushService {
  readonly vapidPublicKey: string;
  private readonly vapidPrivateKey: string;

  constructor(
    private readonly db: Db,
    private readonly options: { publicUrl: string; allowHttp: boolean },
    /** Replaced in tests. */
    private readonly post: (url: string, body: Buffer | string, headers: Record<string, string>) => Promise<number> = defaultPost,
  ) {
    const saved = db.prepare("SELECT value FROM server_settings WHERE key = 'vapid'").get() as { value: string } | undefined;
    let keys = saved ? (JSON.parse(saved.value) as { publicKey: string; privateKey: string }) : undefined;
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      db.prepare("INSERT INTO server_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    }
    this.vapidPublicKey = keys.publicKey;
    this.vapidPrivateKey = keys.privateKey;
  }

  subscribe(userId: number, input: PushSubscriptionInput): void {
    const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new HttpError(400, "endpoint must be a URL");
    }
    if (url.protocol !== "https:" && !(this.options.allowHttp && url.protocol === "http:")) {
      throw new HttpError(400, "Push endpoints must use https (set DENDROP_PUSH_ALLOW_HTTP=true for a local ntfy over http)");
    }
    if (endpoint.length > 2000) throw new HttpError(400, "endpoint is too long");
    const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh : null;
    const auth = typeof input.keys?.auth === "string" ? input.keys.auth : null;
    if (!!p256dh !== !!auth) throw new HttpError(400, "keys needs both p256dh and auth");
    const provider = typeof input.provider === "string" ? input.provider.slice(0, 40) : "webpush";
    const deviceName = typeof input.deviceName === "string" ? input.deviceName.slice(0, 100) : null;
    // Keyed by endpoint: a phone that signs in as someone else moves to them.
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, provider, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           provider = excluded.provider, device_name = excluded.device_name`,
      )
      .run(endpoint, userId, p256dh, auth, provider, deviceName, now());
  }

  unsubscribe(userId: number, endpoint: unknown): boolean {
    if (typeof endpoint !== "string") throw new HttpError(400, "endpoint is required");
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId).changes) > 0;
  }

  /** Sends a wake-up to every phone of these people. Never throws; gone endpoints are dropped. */
  async notify(userIds: number[], kind: PushKind): Promise<void> {
    if (userIds.length === 0) return;
    const rows = this.db
      .prepare(`SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id IN (${userIds.map(() => "?").join(",")})`)
      .all(...userIds) as unknown as Row[];
    await Promise.all(rows.map((r) => this.sendOne(r, kind)));
  }

  private async sendOne(r: Row, kind: PushKind): Promise<void> {
    const payload = JSON.stringify({ type: kind });
    const urgency = kind === "call" ? "high" : "normal";
    try {
      let status: number;
      if (r.p256dh && r.auth) {
        const req = webpush.generateRequestDetails({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
          TTL: kind === "call" ? 45 : 24 * 3600,
          urgency,
          vapidDetails: { subject: this.options.publicUrl.startsWith("https://") ? this.options.publicUrl : "mailto:admin@dendrop.local", publicKey: this.vapidPublicKey, privateKey: this.vapidPrivateKey },
        });
        status = await this.post(req.endpoint, req.body as Buffer, req.headers as Record<string, string>);
      } else {
        // No keys: a plain POST of the same tiny JSON, which UnifiedPush distributors accept.
        status = await this.post(r.endpoint, payload, { "content-type": "application/json", ttl: String(kind === "call" ? 45 : 86400), urgency });
      }
      if (status === 404 || status === 410) {
        this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(r.endpoint);
      } else if (status >= 200 && status < 300) {
        this.db.prepare("UPDATE push_subscriptions SET last_sent_at = ? WHERE endpoint = ?").run(now(), r.endpoint);
      }
    } catch {
      // The push service is down or unreachable; try again with the next message.
    }
  }
}

async function defaultPost(url: string, body: Buffer | string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : new Uint8Array(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return res.status;
}
