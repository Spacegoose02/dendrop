import type { AppDownload, AppDownloads } from "@dendrop/shared";

export type DownloadsFetch = (url: string) => Promise<Response>;

/** The GitHub repository whose releases build the apps (the same one the apps update from). */
export const RELEASE_REPO = "Spacegoose02/dendrop";

/** How long the latest release is kept before asking GitHub again. */
const CACHE_MS = 15 * 60_000;
/** After GitHub fails, wait this long before trying again (and keep showing what we had). */
const RETRY_MS = 60_000;

/**
 * The app file names the release workflow produces (.github/workflows/release.yml), best first
 * per system. The Android release APK (signed with the owner's key) wins over the debug one.
 */
const KINDS: Array<{ re: RegExp; platform: AppDownload["platform"]; kind: AppDownload["kind"]; label: string }> = [
  { re: /^Dendrop-Setup-[\d.]+\.exe$/i, platform: "windows", kind: "installer", label: "Windows installer" },
  { re: /^Dendrop-[\d.]+-portable\.exe$/i, platform: "windows", kind: "portable", label: "Windows portable (.exe)" },
  { re: /^Dendrop-[\d.]+-android\.apk$/i, platform: "android", kind: "apk", label: "Android (.apk)" },
  { re: /^Dendrop-[\d.]+-android-debug\.apk$/i, platform: "android", kind: "apk", label: "Android (.apk)" },
  { re: /^Dendrop-[\d.]+-linux-[\w-]+\.AppImage$/i, platform: "linux", kind: "appimage", label: "Linux (AppImage)" },
  { re: /^Dendrop-[\d.]+-linux-[\w-]+\.deb$/i, platform: "linux", kind: "deb", label: "Linux (.deb)" },
];

/**
 * The app builds in a GitHub release's files, best first for each system: one Android APK
 * (the signed one when there is one), and nothing that isn't a Dendrop app (SHA256SUMS).
 */
export function pickDownloads(release: { tag_name?: unknown; html_url?: unknown; assets?: unknown }, repo = RELEASE_REPO): AppDownloads {
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const fallback = `https://github.com/${repo}/releases/latest`;
  const htmlUrl = typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${repo}/`) ? release.html_url : fallback;
  const assets = Array.isArray(release.assets) ? (release.assets as Array<{ name?: unknown; size?: unknown }>) : [];
  const files: AppDownload[] = [];
  for (const k of KINDS) {
    if (k.kind === "apk" && files.some((f) => f.kind === "apk")) continue;
    const a = assets.find((x) => typeof x.name === "string" && k.re.test(x.name));
    if (!a || !tag) continue;
    const file = a.name as string;
    files.push({
      platform: k.platform,
      kind: k.kind,
      label: k.label,
      file,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
      size: typeof a.size === "number" ? a.size : 0,
    });
  }
  return { version: tag ? tag.replace(/^v/, "") : null, releaseUrl: htmlUrl, files };
}

/**
 * The download buttons' list, from the latest GitHub release. Kept for a while so the sign-in
 * page doesn't ask GitHub on every visit (it allows 60 unauthenticated requests an hour).
 */
export class DownloadsService {
  private cached: { at: number; value: AppDownloads } | null = null;
  private failedAt = 0;
  private pending: Promise<AppDownloads> | null = null;

  constructor(
    private readonly fetcher: DownloadsFetch = (url) =>
      fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Dendrop-server" }, signal: AbortSignal.timeout(10_000) }),
    private readonly repo = RELEASE_REPO,
  ) {}

  async latest(now = Date.now()): Promise<AppDownloads> {
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    if (now - this.failedAt < RETRY_MS) return this.cached?.value ?? this.empty();
    this.pending ??= this.load(now).finally(() => (this.pending = null));
    return this.pending;
  }

  private async load(now: number): Promise<AppDownloads> {
    try {
      const res = await this.fetcher(`https://api.github.com/repos/${this.repo}/releases/latest`);
      if (res.status === 404) {
        // Nothing published yet.
        const value = this.empty();
        this.cached = { at: now, value };
        return value;
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const value = pickDownloads((await res.json()) as object, this.repo);
      this.cached = { at: now, value };
      return value;
    } catch {
      this.failedAt = now;
      return this.cached?.value ?? this.empty();
    }
  }

  private empty(): AppDownloads {
    return { version: null, releaseUrl: `https://github.com/${this.repo}/releases/latest`, files: [] };
  }
}
