import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GIF_RATINGS, type Gif, type GifPage, type GifRating, type GifSettings } from "@dendrop/shared";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";
import type { FamilyService } from "./family.js";
import type { UserRecord } from "./users.js";

/** How the GIF search reaches GIPHY. Tests pass their own. */
export type GifFetch = (url: string) => Promise<Response>;

const SETTINGS_KEY = "gifs";
const API = "https://api.giphy.com/v1/gifs";
const PAGE = 24;
/** Biggest GIF the proxy passes on. */
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
/** Cached pictures nobody has looked at for this long are removed (a look refreshes the file's time). */
const CACHE_DAYS = 30;
const RATINGS_KEPT = 5000;

interface Stored {
  enabled: boolean;
  provider: "giphy";
  apiKey: string;
  rating: GifRating;
}

const DEFAULTS: Stored = { enabled: false, provider: "giphy", apiKey: "", rating: "pg" };

interface GiphyGif {
  id: string;
  title?: string;
  url?: string;
  rating?: string;
  images?: { fixed_width?: { width?: string; height?: string }; original?: { width?: string; height?: string } };
}

const rank = (r: string) => {
  const i = GIF_RATINGS.indexOf(r as GifRating);
  // GIPHY's "y" is for young kids: as mild as "g". Anything unknown counts as the strongest.
  return r === "y" ? 0 : i < 0 ? GIF_RATINGS.length : i;
};

/**
 * GIF search through GIPHY, off until a super admin sets it up. Everything goes through
 * Dendrop: searches (so GIPHY never sees who searched) and the pictures themselves (cached on
 * disk), so people's devices never talk to GIPHY.
 *
 * Kid accounts need a parent to turn GIFs on, and only ever get GIFs rated G, both in search
 * and when one is shown in a chat.
 */
export class GifService {
  private readonly cacheDir: string;
  private readonly ratings = new Map<string, string>();
  private sweep: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Db,
    private readonly family: FamilyService,
    dataDir: string,
    private readonly fetcher: GifFetch = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
  ) {
    this.cacheDir = path.join(dataDir, "gif-cache");
    mkdirSync(this.cacheDir, { recursive: true });
    this.sweep = setInterval(() => this.cleanCache(), 24 * 3_600_000);
    this.sweep.unref();
  }

  close(): void {
    clearInterval(this.sweep);
  }

  private stored(): Stored {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    if (!r) return { ...DEFAULTS };
    try {
      return { ...DEFAULTS, ...(JSON.parse(r.value) as Partial<Stored>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  settings(): GifSettings {
    const s = this.stored();
    return { enabled: s.enabled, provider: s.provider, hasKey: !!s.apiKey, rating: s.rating };
  }

  /** { enabled, apiKey, rating }. An apiKey of "" removes it; leaving it out keeps it. */
  setSettings(patch: { enabled?: unknown; apiKey?: unknown; rating?: unknown }): GifSettings {
    const next = this.stored();
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled is true or false");
      next.enabled = patch.enabled;
    }
    if (patch.apiKey !== undefined) {
      if (typeof patch.apiKey !== "string" || patch.apiKey.length > 200 || /\s/.test(patch.apiKey.trim())) throw new HttpError(400, "That isn't an API key");
      next.apiKey = patch.apiKey.trim();
    }
    if (patch.rating !== undefined) {
      if (!GIF_RATINGS.includes(patch.rating as GifRating)) throw new HttpError(400, `rating is one of ${GIF_RATINGS.join(", ")}`);
      next.rating = patch.rating as GifRating;
    }
    if (next.enabled && !next.apiKey) throw new HttpError(400, "Add a GIPHY API key to turn GIFs on");
    this.db
      .prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(next));
    return this.settings();
  }

  /** GIFs are on here, and this person may use them. */
  allowed(user: UserRecord): boolean {
    const s = this.stored();
    if (!s.enabled || !s.apiKey) return false;
    return !user.isKid || this.family.rules(user.id).gifs;
  }

  /** The strongest rating this person gets: the server's, and always G for kids. */
  ratingFor(user: UserRecord): GifRating {
    return user.isKid ? "g" : this.stored().rating;
  }

  /** Hosts GIF links point at, which automod's link rule lets through while GIFs are on. */
  linkHosts(): string[] {
    return this.stored().enabled ? ["giphy.com"] : [];
  }

  private assertAllowed(user: UserRecord): void {
    const s = this.stored();
    if (!s.enabled || !s.apiKey) throw new HttpError(404, "GIFs aren't turned on here");
    if (user.isKid && !this.family.rules(user.id).gifs) throw new HttpError(403, "Ask a parent: GIFs are off for your account");
  }

  /** Searches, or the trending GIFs when there's no query. */
  async search(user: UserRecord, query: unknown, offset: unknown): Promise<GifPage> {
    this.assertAllowed(user);
    const q = typeof query === "string" ? query.trim().slice(0, 50) : "";
    const start = Math.max(0, Math.min(Number(offset) || 0, 499));
    // Kids' searches with a word their family filter blocks just find nothing.
    if (q && user.isKid && this.family.blocksText(user.id, q)) return { gifs: [], next: null };
    const s = this.stored();
    const rating = this.ratingFor(user);
    const params = new URLSearchParams({ api_key: s.apiKey, limit: String(PAGE), offset: String(start), rating, bundle: "messaging_non_clips" });
    if (q) params.set("q", q);
    let res: Response;
    try {
      res = await this.fetcher(`${API}/${q ? "search" : "trending"}?${params}`);
    } catch {
      throw new HttpError(502, "Couldn't reach GIPHY");
    }
    if (!res.ok) throw new HttpError(502, res.status === 401 || res.status === 403 ? "GIPHY didn't accept the API key" : "GIPHY didn't answer");
    const body = (await res.json()) as { data?: GiphyGif[]; pagination?: { total_count?: number; count?: number; offset?: number } };
    const gifs = (body.data ?? []).filter((g) => /^[A-Za-z0-9]{4,64}$/.test(g.id ?? "") && rank(g.rating ?? "") <= rank(rating)).map((g) => this.toGif(g));
    for (const g of body.data ?? []) if (g.id && g.rating) this.remember(g.id, g.rating);
    const total = body.pagination?.total_count ?? 0;
    const next = start + PAGE < Math.min(total, 500) && (body.data?.length ?? 0) > 0 ? start + PAGE : null;
    return { gifs, next };
  }

  private toGif(g: GiphyGif): Gif {
    const fw = g.images?.fixed_width;
    return {
      id: g.id,
      title: (g.title ?? "").slice(0, 120),
      url: `https://giphy.com/gifs/${g.id}`,
      previewUrl: `/api/gifs/media/${g.id}/preview`,
      mediaUrl: `/api/gifs/media/${g.id}/full`,
      width: Number(fw?.width) || 200,
      height: Number(fw?.height) || 200,
    };
  }

  private remember(id: string, rating: string): void {
    if (this.ratings.size >= RATINGS_KEPT) this.ratings.delete(this.ratings.keys().next().value!);
    this.ratings.set(id, rating);
  }

  /** A GIF's rating, asking GIPHY the first time. */
  private async rating(id: string): Promise<string> {
    const known = this.ratings.get(id);
    if (known) return known;
    let res: Response;
    try {
      res = await this.fetcher(`${API}/${id}?${new URLSearchParams({ api_key: this.stored().apiKey })}`);
    } catch {
      throw new HttpError(502, "Couldn't reach GIPHY");
    }
    if (res.status === 404) throw new HttpError(404, "No such GIF");
    if (!res.ok) throw new HttpError(502, "GIPHY didn't answer");
    const body = (await res.json()) as { data?: GiphyGif };
    const rating = body.data?.rating ?? "";
    this.remember(id, rating);
    return rating;
  }

  /**
   * A GIF's picture, through the cache: "preview" (small, for the picker) or "full". Someone
   * only gets GIFs up to their rating, so a GIF a friend sends a kid only shows if it's rated G.
   */
  async media(user: UserRecord, id: string, variant: "preview" | "full"): Promise<{ data: Buffer; type: string }> {
    this.assertAllowed(user);
    if (!/^[A-Za-z0-9]{4,64}$/.test(id)) throw new HttpError(404, "No such GIF");
    if (rank(await this.rating(id)) > rank(this.ratingFor(user))) throw new HttpError(403, "That GIF isn't allowed for your account");
    const file = path.join(this.cacheDir, `${id}-${variant}.gif`);
    try {
      const data = readFileSync(file);
      const t = new Date();
      utimesSync(file, t, t);
      return { data, type: "image/gif" };
    } catch {
      /* not cached yet */
    }
    let res: Response;
    try {
      res = await this.fetcher(`https://media.giphy.com/media/${id}/${variant === "preview" ? "200w.gif" : "giphy.gif"}`);
    } catch {
      throw new HttpError(502, "Couldn't reach GIPHY");
    }
    if (res.status === 404) throw new HttpError(404, "No such GIF");
    if (!res.ok) throw new HttpError(502, "GIPHY didn't answer");
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_MEDIA_BYTES) throw new HttpError(413, "That GIF is too big");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_MEDIA_BYTES) throw new HttpError(413, "That GIF is too big");
    if (data.subarray(0, 3).toString("latin1") !== "GIF") throw new HttpError(502, "GIPHY sent something that isn't a GIF");
    try {
      writeFileSync(file, data);
    } catch {
      /* serve it anyway */
    }
    return { data, type: "image/gif" };
  }

  /** Removes cached GIFs nobody has needed for a while. */
  cleanCache(): void {
    const cutoff = Date.now() - CACHE_DAYS * 24 * 3_600_000;
    try {
      for (const f of readdirSync(this.cacheDir)) {
        const p = path.join(this.cacheDir, f);
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      }
    } catch {
      /* try again tomorrow */
    }
  }
}
