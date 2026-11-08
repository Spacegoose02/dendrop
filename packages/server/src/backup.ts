import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { BackupFile, BackupSettings, BackupStatus } from "@dendrop/shared";
import { MIGRATIONS, type Db } from "./db.js";
import { HttpError } from "./errors.js";

const KEY = "backup";
const DEFAULTS: BackupSettings = { everyHours: 24, keep: 7, includeUploads: true };
const NAME = /^dendrop-backup-[0-9TZ-]+\.tar\.gz$/;
/** The file that, when it's in the data folder at start-up, is restored from. */
export const RESTORE_FILE = "restore.tar.gz";

// ---- A small tar (ustar) writer and reader: enough for a database and a folder of files --------

function header(name: string, size: number, mtime: Date): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s, off, Math.min(len, Buffer.byteLength(s)), "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for tar: ${name}`);
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  h.fill(" ", 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

interface Entry {
  name: string;
  file: string;
}

async function* tarStream(entries: Entry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    let st;
    try {
      st = statSync(e.file);
    } catch {
      continue; // Deleted while the backup ran.
    }
    if (!st.isFile()) continue;
    yield header(e.name, st.size, st.mtime);
    let written = 0;
    for await (const chunk of createReadStream(e.file, { end: st.size - 1 })) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (written < st.size) yield Buffer.alloc(st.size - written); // Shrank while reading.
    const pad = (512 - (st.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

/** Unpacks a .tar.gz into `dest`, refusing anything that would land outside it. */
export async function extractTarGz(archive: string, dest: string): Promise<string[]> {
  const names: string[] = [];
  let buf = Buffer.alloc(0);
  let current: { out: number; left: number; pad: number; file: string } | null = null;
  const { openSync, writeSync, closeSync } = await import("node:fs");
  const root = path.resolve(dest);

  for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    for (;;) {
      if (current) {
        if (current.left > 0) {
          if (!buf.length) break;
          const n = Math.min(current.left, buf.length);
          writeSync(current.out, buf.subarray(0, n));
          buf = buf.subarray(n);
          current.left -= n;
          if (current.left > 0) break;
        }
        if (buf.length < current.pad) break;
        buf = buf.subarray(current.pad);
        closeSync(current.out);
        current = null;
        continue;
      }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) continue;
      const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(h.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      const type = String.fromCharCode(h[156]!);
      const pad = (512 - (size % 512)) % 512;
      const target = path.resolve(root, name);
      if ((type !== "0" && type !== "\0") || !target.startsWith(root + path.sep)) {
        // Not a plain file, or a path that escapes: skip its bytes.
        current = { out: openSync("/dev/null", "w"), left: size, pad, file: "" };
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      names.push(name);
      current = { out: openSync(target, "w"), left: size, pad, file: target };
      if (size === 0 && pad === 0) {
        closeSync(current.out);
        current = null;
      }
    }
  }
  if (current) closeSync(current.out);
  return names;
}

// ---- The service ---------------------------------------------------------------------

/**
 * Backups of the whole instance: a snapshot of the database (taken with VACUUM INTO, so it's
 * consistent while people chat) and, by default, every uploaded file, as one .tar.gz in the
 * backup folder. They're made on a schedule and on demand, the oldest pruned, and can be
 * downloaded from Instance admin. Restoring is done at start-up (see restoreIfAsked).
 */
export class BackupService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<BackupFile> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    readonly dir: string,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  settings(): BackupSettings {
    const r = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    try {
      return { ...DEFAULTS, ...(r ? (JSON.parse(r.value) as Partial<BackupSettings>) : {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(patch: Record<string, unknown>): BackupSettings {
    const next = this.settings();
    if (patch.everyHours !== undefined) {
      const n = Number(patch.everyHours);
      if (!Number.isInteger(n) || n < 0 || n > 24 * 30) throw new HttpError(400, "everyHours is 0 (off) to 720");
      next.everyHours = n;
    }
    if (patch.keep !== undefined) {
      const n = Number(patch.keep);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpError(400, "keep is 1 to 100");
      next.keep = n;
    }
    if (patch.includeUploads !== undefined) {
      if (typeof patch.includeUploads !== "boolean") throw new HttpError(400, "includeUploads is true or false");
      next.includeUploads = patch.includeUploads;
    }
    this.db.prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    this.prune();
    return next;
  }

  status(): BackupStatus {
    return { settings: this.settings(), dir: this.dir, backups: this.list(), lastError: this.lastError, running: !!this.running };
  }

  list(): BackupFile[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => NAME.test(n))
      .map((name) => {
        const st = statSync(path.join(this.dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  /** The full path of a backup, or a 404. Only names this service makes are allowed. */
  file(name: string): string {
    const p = path.join(this.dir, name);
    if (!NAME.test(name) || !existsSync(p)) throw new HttpError(404, "No such backup");
    return p;
  }

  delete(name: string): void {
    rmSync(this.file(name));
  }

  /** Makes a backup now. If one is already running, waits for that one. */
  create(): Promise<BackupFile> {
    if (!this.running) {
      this.running = this.make().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async make(): Promise<BackupFile> {
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let name = `dendrop-backup-${stamp}.tar.gz`;
    for (let i = 1; existsSync(path.join(this.dir, name)); i++) name = `dendrop-backup-${stamp}-${i}.tar.gz`;
    const work = path.join(this.dir, `.work-${process.pid}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    const partial = path.join(this.dir, `.${name}.partial`);
    try {
      const snapshot = path.join(work, "dendrop.db");
      this.db.prepare("VACUUM INTO ?").run(snapshot);
      const settings = this.settings();
      const manifest = path.join(work, "backup.json");
      writeFileSync(
        manifest,
        JSON.stringify({ app: "dendrop", schema: MIGRATIONS.length, createdAt: new Date().toISOString(), includesUploads: settings.includeUploads }, null, 2),
      );
      const entries: Entry[] = [
        { name: "backup.json", file: manifest },
        { name: "dendrop.db", file: snapshot },
      ];
      const uploads = path.join(this.dataDir, "uploads");
      if (settings.includeUploads && existsSync(uploads)) {
        for (const f of readdirSync(uploads)) entries.push({ name: `uploads/${f}`, file: path.join(uploads, f) });
      }
      await pipeline(Readable.from(tarStream(entries)), createGzip({ level: 6 }), createWriteStream(partial));
      renameSync(partial, path.join(this.dir, name));
      this.lastError = null;
      this.prune();
      const st = statSync(path.join(this.dir, name));
      this.log(`Backup made: ${name} (${Math.round(st.size / 1024)} KB)`);
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    } catch (err) {
      rmSync(partial, { force: true });
      this.lastError = `${new Date().toISOString()}: ${(err as Error).message}`;
      this.log("Backup failed", err);
      throw new HttpError(500, `The backup failed: ${(err as Error).message}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private prune(): void {
    const keep = this.settings().keep;
    for (const b of this.list().slice(keep)) rmSync(path.join(this.dir, b.name), { force: true });
  }

  /** Copies a backup to the data folder, to be restored the next time Dendrop starts. */
  async stageRestore(name: string): Promise<void> {
    await pipeline(createReadStream(this.file(name)), createWriteStream(path.join(this.dataDir, RESTORE_FILE)));
  }

  /** Checks every 10 minutes whether a scheduled backup is due. */
  start(checkMs = 10 * 60_000): void {
    const check = () => {
      const every = this.settings().everyHours;
      if (!every || this.running) return;
      const last = this.list()[0];
      if (last && Date.now() - Date.parse(last.createdAt) < every * 3600_000 - checkMs / 2) return;
      this.create().catch(() => {});
    };
    // First check a minute after start-up, so a restart loop doesn't make a pile of backups.
    this.timer = setTimeout(() => {
      check();
      this.timer = setInterval(check, checkMs);
      this.timer.unref();
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  async waitForRunning(): Promise<void> {
    await this.running?.catch(() => {});
  }
}

/**
 * Restores from <data>/restore.tar.gz, if it's there, before the database is opened. What was
 * in the data folder moves to <data>/before-restore-<time>/ rather than being deleted, and the
 * archive is renamed to restore.tar.gz.done so it only happens once.
 */
export async function restoreIfAsked(dataDir: string, log: (msg: string) => void = console.log): Promise<boolean> {
  const archive = path.join(dataDir, RESTORE_FILE);
  if (!existsSync(archive)) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(dataDir, `.restore-${stamp}`);
  mkdirSync(staging, { recursive: true });
  try {
    await extractTarGz(archive, staging);
    const manifestPath = path.join(staging, "backup.json");
    const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { app?: string; schema?: number; includesUploads?: boolean }) : null;
    if (manifest?.app !== "dendrop" || !existsSync(path.join(staging, "dendrop.db"))) throw new Error("that isn't a Dendrop backup");
    if ((manifest.schema ?? 0) > MIGRATIONS.length) throw new Error("that backup is from a newer Dendrop; update Dendrop first");

    const aside = path.join(dataDir, `before-restore-${stamp}`);
    mkdirSync(aside, { recursive: true });
    const move = (name: string) => {
      const from = path.join(dataDir, name);
      if (existsSync(from)) renameSync(from, path.join(aside, name));
    };
    for (const f of ["dendrop.db", "dendrop.db-wal", "dendrop.db-shm"]) move(f);
    renameSync(path.join(staging, "dendrop.db"), path.join(dataDir, "dendrop.db"));
    if (manifest.includesUploads) {
      mkdirSync(path.join(staging, "uploads"), { recursive: true });
      move("uploads");
      renameSync(path.join(staging, "uploads"), path.join(dataDir, "uploads"));
    }
    renameSync(archive, `${archive}.done`);
    log(`Restored from ${RESTORE_FILE}${manifest.includesUploads ? " (with uploads)" : " (database only; uploads kept)"}. The old data is in ${aside}`);
    return true;
  } catch (err) {
    renameSync(archive, `${archive}.failed`);
    log(`Couldn't restore from ${RESTORE_FILE}: ${(err as Error).message}. Nothing was changed; the file is now ${RESTORE_FILE}.failed`);
    return false;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
