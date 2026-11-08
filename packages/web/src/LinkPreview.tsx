import { useEffect, useState, useSyncExternalStore } from "react";
import { LIMITS, type LinkPreview } from "@dendrop/shared";
import { api } from "./api.ts";
import { linksIn } from "./markdown.tsx";

/**
 * Preview cards under links. The server fetches the page and its picture (see the server's
 * link-previews.ts), so showing a chat never makes this device contact the site.
 *
 * In an end-to-end encrypted chat, asking for a preview would show the server the link, so
 * there are none unless you turn on "Link previews in encrypted chats" in Settings.
 */

let enabled: boolean | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const cache = new Map<string, Promise<LinkPreview | null>>();
const ENCRYPTED_PREF = "dendrop.previewsInEncrypted";

function loadEnabled(): void {
  if (loading) return;
  loading = api<{ enabled: boolean }>("/api/link-previews/settings").then(
    (r) => {
      enabled = r.enabled;
      for (const fn of listeners) fn();
    },
    () => {
      loading = null;
    },
  );
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Previews are on for this server and allowed for you. */
export function usePreviewsEnabled(): boolean {
  useEffect(loadEnabled, []);
  return useSyncExternalStore(subscribe, () => enabled === true);
}

/** Forget what we know, after a super admin or a parent changes the setting. */
export function refreshPreviewSettings(): void {
  loading = null;
  cache.clear();
  loadEnabled();
}

export function previewsInEncrypted(): boolean {
  try {
    return localStorage.getItem(ENCRYPTED_PREF) === "1";
  } catch {
    return false;
  }
}

export function setPreviewsInEncrypted(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENCRYPTED_PREF, "1");
    else localStorage.removeItem(ENCRYPTED_PREF);
  } catch {
    /* not saved; still off next time */
  }
  for (const fn of listeners) fn();
}

function fetchPreview(url: string): Promise<LinkPreview | null> {
  let p = cache.get(url);
  if (!p) {
    p = api<{ preview: LinkPreview | null }>(`/api/link-previews?url=${encodeURIComponent(url)}`).then(
      (r) => r.preview,
      () => null,
    );
    cache.set(url, p);
  }
  return p;
}

/** Cards for the first few links in a message. `mask` hides words a kid's family filter blocks. */
export function LinkPreviews({ text, encrypted, mask }: { text: string; encrypted: boolean; mask?: (s: string) => string }) {
  const on = usePreviewsEnabled();
  const inEncrypted = useSyncExternalStore(subscribe, previewsInEncrypted);
  const urls = on && (!encrypted || inEncrypted) ? linksIn(text).slice(0, LIMITS.previewsPerMessage) : [];
  if (!urls.length) return null;
  return (
    <div className="link-previews">
      {urls.map((u) => (
        <PreviewCard key={u} url={u} mask={mask} />
      ))}
    </div>
  );
}

function PreviewCard({ url, mask = (s) => s }: { url: string; mask?: (s: string) => string }) {
  const [p, setP] = useState<LinkPreview | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchPreview(url).then((x) => live && setP(x));
    return () => {
      live = false;
    };
  }, [url]);
  if (!p) return null;
  return (
    <div className="link-card">
      <div className="link-card-text">
        <span className="muted small ellipsis">{mask(p.site)}</span>
        {p.title && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="link-card-title">
            {mask(p.title)}
          </a>
        )}
        {p.description && <span className="small link-card-desc">{mask(p.description)}</span>}
      </div>
      {p.image && !imgFailed && <img className="link-card-image" src={p.image} alt="" loading="lazy" onError={() => setImgFailed(true)} />}
    </div>
  );
}
