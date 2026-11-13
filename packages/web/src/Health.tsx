import { useEffect, useState, type ReactNode } from "react";
import type { ServerHealth } from "@dendrop/shared";
import { api } from "./api.ts";

/** How often the numbers refresh while the admin panel is open. */
const REFRESH_MS = 10_000;

const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
};

const duration = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

const count = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** A share bar that turns amber past 75% and red past 90%. */
function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const level = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
  return (
    <div className={`health-meter ${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function Tile({ label, value, sub, title, children }: { label: string; value: string; sub?: string; title?: string; children?: ReactNode }) {
  return (
    <div className="health-tile" title={title}>
      <span className="health-label">{label}</span>
      <span className="health-value">{value}</span>
      {children}
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

/** Instance admin → Server health: CPU, memory, disks, storage and who's connected. */
export function HealthSection() {
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    void api<ServerHealth>("/api/admin/health")
      .then(
        (h) => {
          setHealth(h);
          setError(null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const h = health;
  return (
    <>
      <div className="section-label with-action">
        <span>Server health</span>
        <button className="ghost" title="Refresh" aria-label="Refresh server health" disabled={busy} onClick={load}>
          ↻
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {!h && !error && <p className="muted small">Checking…</p>}
      {h && (
        <>
          <p className="muted small">
            Up {duration(h.uptimeSeconds)} · Node {h.nodeVersion} · refreshes every {REFRESH_MS / 1000} seconds
          </p>
          <div className="health-grid">
            <Tile
              label="CPU"
              value={`${Math.round(h.cpu.processPercent)}%`}
              sub={`${plural(h.cpu.cores, "core")} · load ${h.cpu.loadAverage[0]}`}
              title={`Dendrop's share of one core. Load averages (1, 5, 15 min): ${h.cpu.loadAverage.join(", ")}`}
            >
              <Meter used={h.cpu.processPercent} total={100 * h.cpu.cores} />
            </Tile>
            <Tile
              label={h.memory.container ? "Container memory" : "Memory"}
              value={bytes(h.memory.usedBytes)}
              sub={`of ${bytes(h.memory.totalBytes)} · Dendrop ${bytes(h.memory.processBytes)}`}
            >
              <Meter used={h.memory.usedBytes} total={h.memory.totalBytes} />
            </Tile>
            {h.disks.map((d) => (
              <Tile key={d.path} label={`${d.label} disk`} value={`${bytes(d.freeBytes)} free`} sub={`of ${bytes(d.totalBytes)} · ${d.path}`} title={d.path}>
                <Meter used={d.totalBytes - d.freeBytes} total={d.totalBytes} />
              </Tile>
            ))}
            <Tile label="Connected now" value={plural(h.connections.onlineUsers, "person", "people")} sub={`${plural(h.connections.sockets, "connection")} · ${count(h.connections.idleSockets)} idle`} />
            <Tile label="Database" value={bytes(h.storage.databaseBytes)} sub={`${plural(h.counts.messages, "message")} · ${count(h.counts.messagesToday)} today`} />
            <Tile label="Uploads" value={bytes(h.storage.uploadsBytes)} sub={plural(h.storage.uploadFiles, "file")} />
            <Tile label="Backups" value={bytes(h.storage.backupsBytes)} sub={`${count(h.storage.backups)} kept`} />
            <Tile label="Accounts" value={count(h.counts.users)} sub={plural(h.counts.servers, "server")} />
          </div>
        </>
      )}
    </>
  );
}
