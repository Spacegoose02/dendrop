import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LinkPreview, LinkPreviewSettings } from "@dendrop/shared";
import { now, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { FamilyService } from "./family.js";
import { safeFetch, type SafeFetchOptions, type SafeResponse } from "./safe-fetch.js";
import type { UserRecord } from "./users.js";

/** How the server fetches pages and pictures. Tests pass their own. */
export type PreviewFetch = (url: string, o: SafeFetchOptions) => Promise<SafeResponse>;

const SETTINGS_KEY = "linkPreviews";
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 3 * 1024 * 1024;
/** A preview is fetched again after a day; a link that had none is tried again after an hour. */
const FRESH_MS = 24 * 3_600_000;
const FAILED_MS = 3_600_000;
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const EXT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * Preview cards under links: the page's title, a line of text and a picture. The server fetches
 * the page (see safe-fetch.ts for how it stays off private networks) and the picture, so
 * people's devices never contact the site just by showing a chat.
 *
 * Off until a super admin turns it on, since it sends links to outside sites. Kids also need a
 * parent to turn previews on. Clients only ask for previews in chats that aren't end-to-end
 * encrypted, unless the person opts in (asking would show the server the link).
 */
export class LinkPreviewService {
  private readonly dir: string;
  private readonly inFlight = new Map<string, Promise<LinkPreview | null>>();

  constructor(
    private readonly db: Db,
    private readonly family: FamilyService,
    dataDir: string,
    private readonly fetcher: PreviewFetch = safeFetch,
  ) {
    this.dir = path.join(dataDir, "link-previews");
    mkdirSync(this.dir, { recursive: true });
  }

  settings(): LinkPreviewSettings {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    try {
      return { enabled: !!r && (JSON.parse(r.value) as LinkPreviewSettings).enabled === true };
    } catch {
      return { enabled: false };
    }
  }

  setSettings(patch: { enabled?: unknown }): LinkPreviewSettings {
    if (typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled is true or false");
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify({ enabled: patch.enabled }));
    return this.settings();
  }

  /** Previews are on here, and this person may see them. */
  allowed(user: UserRecord): boolean {
    return this.settings().enabled && (!user.isKid || this.family.rules(user.id).linkPreviews);
  }

  /** The preview for a link, or null when the page has nothing to show (or can't be reached). */
  async preview(user: UserRecord, raw: unknown): Promise<LinkPreview | null> {
    if (!this.settings().enabled) throw new HttpError(404, "Link previews aren't turned on here");
    if (user.isKid && !this.family.rules(user.id).linkPreviews) throw new HttpError(403, "Ask a parent: link previews are off for your account");
    if (typeof raw !== "string" || raw.length > 2048 || !/^https?:\/\//i.test(raw)) throw new HttpError(400, "url is an http or https link");
    const url = raw.trim();
    const cached = this.db.prepare("SELECT data, image_id, fetched_at FROM link_previews WHERE url = ?").get(url) as
      | { data: string | null; image_id: string | null; fetched_at: string }
      | undefined;
    if (cached) {
      const age = Date.now() - Date.parse(cached.fetched_at);
      if (age < (cached.data ? FRESH_MS : FAILED_MS)) return cached.data ? (JSON.parse(cached.data) as LinkPreview) : null;
    }
    let p = this.inFlight.get(url);
    if (!p) {
      p = this.fetchPreview(url, cached?.image_id ?? null).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, p);
    }
    return p;
  }

  private async fetchPreview(url: string, oldImage: string | null): Promise<LinkPreview | null> {
    let preview: LinkPreview | null = null;
    let imageId: string | null = null;
    try {
      const page = await this.fetcher(url, { maxBytes: PAGE_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" });
      if (page.status >= 200 && page.status < 300 && /^(text\/html|application\/xhtml\+xml)/.test(page.contentType)) {
        const meta = parseMeta(page.body.toString("utf8"), page.url);
        if (meta.title || meta.description) {
          if (meta.image) imageId = await this.saveImage(meta.image);
          preview = {
            url,
            site: meta.site || new URL(page.url).hostname.replace(/^www\./, ""),
            title: meta.title,
            description: meta.description,
            image: imageId ? `/api/link-previews/image/${imageId}` : null,
          };
        }
      }
    } catch {
      // Blocked, unreachable or broken: no card (tried again after a while).
      preview = null;
    }
    if (oldImage && oldImage !== imageId) rmSync(path.join(this.dir, oldImage), { force: true });
    this.db
      .prepare(
        `INSERT INTO link_previews (url, data, image_id, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET data = excluded.data, image_id = excluded.image_id, fetched_at = excluded.fetched_at`,
      )
      .run(url, preview ? JSON.stringify(preview) : null, imageId, now());
    return preview;
  }

  /** Downloads a preview picture: only real PNG, JPEG, GIF or WebP files, up to 3 MB. */
  private async saveImage(url: string): Promise<string | null> {
    try {
      const res = await this.fetcher(url, { maxBytes: IMAGE_BYTES + 1, accept: "image/png,image/jpeg,image/gif,image/webp" });
      if (res.status < 200 || res.status >= 300 || res.body.length > IMAGE_BYTES) return null;
      const ext = sniffImage(res.body);
      if (!ext) return null;
      const id = `${randomBytes(16).toString("hex")}.${ext}`;
      writeFileSync(path.join(this.dir, id), res.body);
      return id;
    } catch {
      return null;
    }
  }

  /** A stored preview picture. Anyone signed in may load one; ids can't be guessed. */
  image(user: UserRecord, id: string): { data: Buffer; type: string } {
    if (!this.allowed(user)) throw new HttpError(404, "No such picture");
    const m = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.exec(id);
    if (!m) throw new HttpError(404, "No such picture");
    try {
      return { data: readFileSync(path.join(this.dir, id)), type: EXT_TYPES[m[1]!]! };
    } catch {
      throw new HttpError(404, "No such picture");
    }
  }
}

/** The picture's real type from its first bytes (never the site's word for it). */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
}

/** Title, text, site name and picture from a page's Open Graph, Twitter card and plain tags. */
export function parseMeta(html: string, pageUrl: string): { title: string; description: string; site: string; image: string | null } {
  const head = html.slice(0, PAGE_BYTES);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const titleTag = /<title[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(head)?.[1] ?? "";
  const pick = (...keys: string[]) => decode(keys.map((k) => meta[k]).find((v) => v && v.trim()) ?? "");
  const title = (pick("og:title", "twitter:title") || decode(titleTag)).slice(0, 200);
  const description = pick("og:description", "twitter:description", "description").slice(0, 300);
  const site = pick("og:site_name", "application-name").slice(0, 60);
  let image: string | null = null;
  const img = pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (img) {
    try {
      const u = new URL(img, pageUrl);
      if (u.protocol === "https:" || u.protocol === "http:") image = u.toString();
    } catch {
      /* no picture */
    }
  }
  return { title, description, site, image };
}
