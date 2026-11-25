import { Fragment, useEffect, useState } from "react";
import type { AppDownloads } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { inAndroidApp } from "./native.ts";
import { formatSize, inInstalledApp, PLATFORM_NAMES, primaryDownload, visitorPlatform } from "./appPlatform.ts";

let loading: Promise<AppDownloads> | null = null;
/** The latest release's apps, asked for once per page load. */
function loadDownloads(): Promise<AppDownloads> {
  loading ??= api<AppDownloads>("/api/downloads").catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

function useDownloads(): AppDownloads | null {
  const [d, setD] = useState<AppDownloads | null>(null);
  useEffect(() => {
    let live = true;
    loadDownloads().then(
      (x) => live && setD(x),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return d;
}

/**
 * The app for this visitor's system as a big button (it's picked from the browser's user agent),
 * with the other systems' apps as links under it. Shows nothing until there's a release.
 */
export function AppDownloadsPanel({ inDialog = false }: { inDialog?: boolean }) {
  const d = useDownloads();
  const platform = visitorPlatform();
  if (!d) return inDialog ? <p className="muted">Looking for the newest apps…</p> : null;
  if (d.files.length === 0) {
    return inDialog ? (
      <p className="muted">
        No apps are published yet. <a href={d.releaseUrl} target="_blank" rel="noreferrer">See releases on GitHub</a>
      </p>
    ) : null;
  }
  const primary = primaryDownload(d.files, platform);
  const others = d.files.filter((f) => f !== primary);
  return (
    <section className={`app-downloads ${inDialog ? "in-dialog" : ""}`} aria-label="Download the app">
      {!inDialog && <h2>Get the Dendrop app</h2>}
      {primary ? (
        <a className="button primary wide app-download-main" href={primary.url} rel="noreferrer">
          <DownloadIcon />
          <span>
            Download for {PLATFORM_NAMES[primary.platform]}
            <small>
              {primary.label} · v{d.version}
              {primary.size ? ` · ${formatSize(primary.size)}` : ""}
            </small>
          </span>
        </a>
      ) : platform === "macos" || platform === "ios" ? (
        <p className="muted app-download-none">
          There's no {PLATFORM_NAMES[platform]} app yet, but Dendrop works right here in your browser.
          {platform === "ios" && " Tap Share, then Add to Home Screen, to keep it a tap away."}
        </p>
      ) : null}
      <p className="app-download-others">
        <span className="muted">{primary ? "Other systems:" : "Apps:"}</span>{" "}
        {others.map((f) => (
          <Fragment key={f.file}>
            <a href={f.url} rel="noreferrer" title={`${f.file}${f.size ? `, ${formatSize(f.size)}` : ""}`}>
              {f.label}
            </a>
            {" · "}
          </Fragment>
        ))}
        <a href={d.releaseUrl} target="_blank" rel="noreferrer">
          All files
        </a>
      </p>
    </section>
  );
}

function DownloadIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function UpdateIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20V9" />
      <path d="m7 13 5-5 5 5" />
      <path d="M5 4h14" />
    </svg>
  );
}

// ---- The corner button ---------------------------------------------------------------

/** What the PC app's preload (packages/desktop/src/preload.ts) offers for updates. */
interface DesktopUpdateState {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "unsupported";
  version?: string;
  error?: string;
}
interface DesktopUpdates {
  appSettings?: () => Promise<{ version?: string; update?: DesktopUpdateState }>;
  checkForUpdates?: () => Promise<DesktopUpdateState>;
  /** Newer apps: restarts into a downloaded update. */
  installUpdate?: () => Promise<void>;
}
const desktop = (): DesktopUpdates | undefined => (window as unknown as { dendrop?: DesktopUpdates }).dendrop;

interface CapacitorBridge {
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
}
const capacitor = (): CapacitorBridge | undefined => (window as { Capacitor?: CapacitorBridge }).Capacitor;

/**
 * The bottom of the server rail. In a browser: "Get the app", with the downloads. In the PC app
 * and the Android app: an update button, only while a newer app is out. Nothing in the iPhone
 * app, which TestFlight and the App Store update.
 */
export function AppCorner() {
  const className = "rail-item rail-corner";
  if (desktop()) return <DesktopUpdateButton className={className} />;
  if (inAndroidApp()) return <AndroidUpdateButton className={className} />;
  if (inInstalledApp()) return null;
  return <GetTheAppButton className={className} />;
}

function GetTheAppButton({ className }: { className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} title="Download the app" aria-label="Download the app" onClick={() => setOpen(true)}>
        <DownloadIcon size={22} />
      </button>
      {open && (
        <Modal title="Get the Dendrop app" onClose={() => setOpen(false)}>
          <AppDownloadsPanel inDialog />
        </Modal>
      )}
    </>
  );
}

/** How often the page asks the PC app how its update is going: often while it downloads. */
const BUSY_POLL_MS = 5_000;
const IDLE_POLL_MS = 10 * 60_000;

function DesktopUpdateButton({ className }: { className: string }) {
  const [u, setU] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const app = desktop();
    if (!app?.appSettings) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await app.appSettings!();
        if (live) setU(s.update ?? null);
        const state = s.update?.state;
        timer = setTimeout(() => void poll(), state === "checking" || state === "downloading" ? BUSY_POLL_MS : IDLE_POLL_MS);
      } catch {
        timer = setTimeout(() => void poll(), IDLE_POLL_MS);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  if (!u || !u.version) return null;
  const app = desktop()!;
  const failed = u.state === "error";
  if (u.state !== "available" && u.state !== "downloading" && u.state !== "ready" && !failed) return null;

  const click = async () => {
    setBusy(true);
    try {
      if (u.state === "ready" && app.installUpdate) await app.installUpdate();
      else if (app.checkForUpdates) setU(await app.checkForUpdates());
    } finally {
      setBusy(false);
    }
  };
  const downloading = u.state === "downloading" || busy;
  const title =
    u.state === "ready"
      ? app.installUpdate
        ? `Restart to update to Dendrop ${u.version}`
        : `Dendrop ${u.version} is ready: it installs when you quit the app`
      : downloading
        ? `Downloading Dendrop ${u.version}…`
        : failed
          ? `Updating to ${u.version} didn't work: ${u.error ?? "try again"}. Click to try again.`
          : `Update to Dendrop ${u.version}`;
  return (
    <button
      className={`${className} app-update ${downloading ? "busy" : ""} ${failed ? "failed" : ""}`}
      title={title}
      aria-label={title}
      disabled={downloading || (u.state === "ready" && !app.installUpdate)}
      onClick={() => void click()}
    >
      <UpdateIcon />
    </button>
  );
}

function AndroidUpdateButton({ className }: { className: string }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Older Android apps don't have appUpdate; they still ask with their own dialog.
    capacitor()
      ?.nativePromise?.("Dendrop", "appUpdate", {})
      .then(
        (r) => {
          const v = (r as { version?: unknown } | null)?.version;
          if (live && typeof v === "string") setVersion(v);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);
  if (!version) return null;
  const title = `Update to Dendrop ${version}`;
  return (
    <button
      className={`${className} app-update`}
      title={title}
      aria-label={title}
      onClick={() => void capacitor()?.nativePromise?.("Dendrop", "openUpdate", {}).catch(() => {})}
    >
      <UpdateIcon />
    </button>
  );
}
