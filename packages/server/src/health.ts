import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerHealth } from "@dendrop/shared";
import type { Context } from "./app.js";

/** Walking the uploads folder can take a while on a big instance, so its size is kept this long. */
const FOLDER_CACHE_MS = 60_000;

/** How the Dendrop container is doing: CPU, memory, disks, storage and connections. Super admins only. */
export class HealthService {
  private lastCpu = { at: process.hrtime.bigint(), usage: process.cpuUsage() };
  private uploads: { at: number; bytes: number; files: number } | null = null;
  private walking: Promise<{ bytes: number; files: number }> | null = null;

  constructor(private readonly ctx: Pick<Context, "config" | "db" | "gateway" | "backups">) {}

  async snapshot(now = new Date()): Promise<ServerHealth> {
    const { config, db, gateway, backups } = this.ctx;
    const memory = memoryUse();
    const uploads = await this.uploadsSize();
    const backupFiles = backups.list();
    const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const load = os.loadavg();

    return {
      at: now.toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      cpu: {
        cores: os.availableParallelism(),
        processPercent: this.cpuPercent(),
        loadAverage: [round(load[0]!), round(load[1]!), round(load[2]!)],
      },
      memory: {
        processBytes: process.memoryUsage.rss(),
        heapUsedBytes: process.memoryUsage().heapUsed,
        ...memory,
      },
      disks: disks([
        { label: "Data", path: config.dataDir },
        { label: "Backups", path: config.backupDir },
      ]),
      storage: {
        databaseBytes: this.databaseBytes(),
        uploadsBytes: uploads.bytes,
        uploadFiles: uploads.files,
        backupsBytes: backupFiles.reduce((sum, b) => sum + b.size, 0),
        backups: backupFiles.length,
      },
      connections: gateway.stats(),
      counts: {
        users: count("SELECT COUNT(*) AS n FROM users"),
        servers: count("SELECT COUNT(*) AS n FROM servers"),
        messages: count("SELECT COUNT(*) AS n FROM messages"),
        messagesToday: count("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", new Date(now.getTime() - 86_400_000).toISOString()),
      },
    };
  }

  /** Dendrop's CPU time since the last look, as a percentage of one core. */
  private cpuPercent(): number {
    const at = process.hrtime.bigint();
    const usage = process.cpuUsage();
    const elapsedUs = Number(at - this.lastCpu.at) / 1000;
    const usedUs = usage.user - this.lastCpu.usage.user + (usage.system - this.lastCpu.usage.system);
    this.lastCpu = { at, usage };
    return elapsedUs > 0 ? round((usedUs / elapsedUs) * 100) : 0;
  }

  private databaseBytes(): number {
    const pages = this.ctx.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.ctx.db.prepare("PRAGMA page_size").get() as { page_size: number };
    let bytes = pages.page_count * size.page_size;
    const wal = path.join(this.ctx.config.dataDir, "dendrop.db-wal");
    try {
      if (existsSync(wal)) bytes += statSync(wal).size;
    } catch {
      // The log was checkpointed away while we looked.
    }
    return bytes;
  }

  private async uploadsSize(): Promise<{ bytes: number; files: number }> {
    if (this.uploads && Date.now() - this.uploads.at < FOLDER_CACHE_MS) return this.uploads;
    this.walking ??= folderSize(path.join(this.ctx.config.dataDir, "uploads")).finally(() => (this.walking = null));
    const result = await this.walking;
    this.uploads = { at: Date.now(), ...result };
    return result;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return { bytes, files }; // No uploads yet.
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      bytes += (await stat(path.join(e.parentPath, e.name))).size;
      files++;
    } catch {
      // Deleted while we counted.
    }
  }
  return { bytes, files };
}

/** The container's memory (cgroup v2, then v1) when it has a limit, otherwise the machine's. */
function memoryUse(): { totalBytes: number; usedBytes: number; container: boolean } {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
  };
  const machine = os.totalmem();
  const limit = read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const current = read("/sys/fs/cgroup/memory.current") ?? read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const max = limit && /^\d+$/.test(limit) ? Number(limit) : NaN;
  // "max", or v1's huge number, means no limit: the machine's memory is what counts.
  if (Number.isFinite(max) && max > 0 && max < machine && current && /^\d+$/.test(current)) {
    return { totalBytes: max, usedBytes: Number(current), container: true };
  }
  return { totalBytes: machine, usedBytes: machine - os.freemem(), container: false };
}

/** Free and total space for each folder's disk, merging folders that share one. */
function disks(folders: { label: string; path: string }[]): ServerHealth["disks"] {
  const out: (ServerHealth["disks"][number] & { dev: number })[] = [];
  for (const f of folders) {
    let at = f.path;
    // The backups folder may not exist until the first backup: measure the nearest folder that does.
    while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    try {
      const dev = statSync(at).dev;
      const fs = statfsSync(at);
      const same = out.find((d) => d.dev === dev);
      if (same) {
        same.label += ` and ${f.label.toLowerCase()}`;
        continue;
      }
      out.push({ dev, label: f.label, path: f.path, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize });
    } catch {
      // Can't read this disk: leave it out.
    }
  }
  return out.map(({ dev: _dev, ...d }) => d);
}
