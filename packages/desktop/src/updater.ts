import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** How this copy of the app was installed, which decides how it can replace itself. */
export type InstallKind = "installer" | "portable" | "appimage" | "other";

export function installKind(env: NodeJS.ProcessEnv = process.env, platform = process.platform): InstallKind {
  if (platform === "win32") return env.PORTABLE_EXECUTABLE_FILE ? "portable" : "installer";
  if (env.APPIMAGE) return "appimage";
  return "other";
}

/** -1, 0 or 1 for dotted versions ("0.10.0" > "0.9.3"). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const y = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The app file names the release workflow produces, per install kind (see package.json build). The server lists them at /api/clients. */
const PATTERNS: Record<Exclude<InstallKind, "other">, RegExp> = {
  installer: /^Dendrop-Setup-(\d+(?:\.\d+){1,3})\.exe$/i,
  portable: /^Dendrop-(\d+(?:\.\d+){1,3})-portable\.exe$/i,
  appimage: /^Dendrop-(\d+(?:\.\d+){1,3})-linux-[\w-]+\.AppImage$/i,
};

export interface AvailableUpdate {
  version: string;
  file: string;
  size: number;
}

/**
 * The newest app build on the server that this copy can update itself with, when it's newer
 * than the running version. Builds of other kinds (a .deb, an installer for a portable copy)
 * are ignored.
 */
export function pickUpdate(files: Array<{ name: string; size: number }>, current: string, kind: InstallKind): AvailableUpdate | null {
  if (kind === "other") return null;
  let best: AvailableUpdate | null = null;
  for (const f of files) {
    const v = f.name.match(PATTERNS[kind])?.[1];
    if (!v || compareVersions(v, current) <= 0) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { version: v, file: f.name, size: f.size };
  }
  return best;
}

/** Downloads an app build from the server into dir, reporting bytes. headers carries the sign-in cookie. */
export async function downloadUpdate(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  headers: Record<string, string>,
  target: string,
  onBytes: (received: number, total: number) => void,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const res = await fetchImpl(url, { headers });
  if (!res.ok || !res.body) throw new Error(`Downloading the update failed (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onBytes(received, total);
  });
  await pipeline(body, createWriteStream(`${target}.part`));
  await rename(`${target}.part`, target);
}

/** The GitHub repository whose releases build this app. Its SHA256SUMS file vouches for updates. */
export const RELEASE_REPO = "Spacegoose02/dendrop";

/** "hash  name" lines (sha256sum's format) to a map of file name to lower-case hash. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64}) [ *]?(.+)$/i);
    if (m) sums.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return sums;
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Checks a downloaded update against the SHA256SUMS published with that version's GitHub
 * release, so the Dendrop server alone can't make every PC run a file of its choosing.
 * Throws (and deletes the file) unless the hash matches.
 */
export async function verifyUpdate(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  update: AvailableUpdate,
  downloaded: string,
  repo = RELEASE_REPO,
): Promise<void> {
  const url = `https://github.com/${repo}/releases/download/v${update.version}/SHA256SUMS`;
  let expected: string | undefined;
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("Couldn't reach GitHub to check the update, so it wasn't installed. Try again when this PC is online.");
    }
    if (res.status === 404) throw new Error(`Dendrop ${update.version} has no checksums on GitHub, so the update wasn't installed`);
    if (!res.ok) throw new Error(`Checking the update failed: GitHub answered ${res.status}`);
    expected = parseChecksums(await res.text()).get(update.file);
    if (!expected) throw new Error(`${update.file} isn't in Dendrop ${update.version}'s checksums, so it wasn't installed`);
    if ((await fileSha256(downloaded)) !== expected) {
      throw new Error(`${update.file} doesn't match the official Dendrop ${update.version} build, so it wasn't installed`);
    }
  } catch (err) {
    await rm(downloaded, { force: true });
    throw err;
  }
}

/**
 * Starts the new version and returns; the caller quits the running app straight after.
 * - installer: runs the setup silently over the current install, which starts the app again.
 * - portable: swaps the .exe (a running one can be renamed on Windows) and starts the new one.
 * - appimage: replaces the AppImage file and starts it.
 */
export async function launchUpdate(kind: InstallKind, downloaded: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const detached = (file: string, args: string[]) => spawn(file, args, { detached: true, stdio: "ignore" }).unref();
  if (kind === "installer") {
    detached(downloaded, ["/S", "--updated", "--force-run"]);
    return;
  }
  const current = kind === "portable" ? env.PORTABLE_EXECUTABLE_FILE : env.APPIMAGE;
  if (!current) throw new Error("Can't tell where this copy of the app is");
  const old = `${current}.old`;
  await rm(old, { force: true });
  await rename(current, old);
  try {
    await rename(downloaded, current).catch(async () => {
      // Another drive: copy instead of move.
      const { copyFile } = await import("node:fs/promises");
      await copyFile(downloaded, current);
    });
  } catch (err) {
    await rename(old, current).catch(() => {});
    throw err;
  }
  if (kind === "appimage") await chmod(current, 0o755);
  detached(current, []);
}
