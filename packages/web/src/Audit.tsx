import { useEffect, useState } from "react";
import { AUDIT_ACTIONS, type AuditEntry, type BackupStatus, type ChatServer } from "@dendrop/shared";
import { api } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const size = (bytes: number) => (bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

const SERVER_FILTERS: [string, string][] = [
  ["", "Everything"],
  ["member", "Members"],
  ["role", "Roles"],
  ["channel", "Channels"],
  ["message", "Messages"],
  ["server", "Server"],
  ["automod", "Automod"],
  ["emoji", "Emoji"],
  ["sound", "Soundboard"],
  ["webhook", "Webhooks"],
  ["bot", "Bots"],
  ["event", "Events"],
];
const INSTANCE_FILTERS: [string, string][] = [
  ["", "Everything"],
  ["account", "Accounts"],
  ["signin", "Sign-in"],
  ["server", "Servers"],
  ["creator", "Server makers"],
  ["backup", "Backups"],
];

/** One line of the log: "mo banned mel · 10 min: spam". */
function Entry({ e, names }: { e: AuditEntry; names?: Map<number, string> }) {
  const actor = (e.actor.id && names?.get(e.actor.id)) || e.actor.name;
  const target = (e.target.userId && names?.get(e.target.userId)) || e.target.name;
  return (
    <div className="audit-entry">
      <div className="small">
        <strong>{actor}</strong> {AUDIT_ACTIONS[e.action] ?? e.action}
        {target && <strong> {target}</strong>}
      </div>
      <div className="muted small">
        {when(e.createdAt)}
        {e.details && ` · ${e.details}`}
      </div>
    </div>
  );
}

/** A page of the log with a filter and "older". */
function useLog(base: string, filter: string) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = (before?: number) => {
    const p = new URLSearchParams();
    if (filter) p.set("action", filter);
    if (before) p.set("before", String(before));
    return `${base}?${p}`;
  };
  useEffect(() => {
    setEntries(null);
    void api<AuditEntry[]>(q()).then(
      (list) => {
        setEntries(list);
        setMore(list.length === 50);
      },
      (e: Error) => setError(e.message),
    );
  }, [base, filter]);
  const older = async () => {
    const last = entries?.at(-1);
    if (!last) return;
    const list = await api<AuditEntry[]>(q(last.id));
    setEntries([...(entries ?? []), ...list]);
    setMore(list.length === 50);
  };
  return { entries, more, older, error };
}

/** Server settings → Audit log: what the server's moderators did. */
export function AuditLogTab({ server }: { server: ChatServer }) {
  const [filter, setFilter] = useState("");
  const { entries, more, older, error } = useLog(`/api/servers/${server.id}/audit`, filter);
  const names = new Map(server.members.map((m) => [m.user.id, m.nickname ?? m.user.displayName]));
  return (
    <div className="server-settings">
      <p className="muted small">Changes moderators make here: who removed, banned or timed out whom, and changes to roles, channels and settings.</p>
      <label className="audit-filter">
        Show{" "}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {SERVER_FILTERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      {entries?.length === 0 && <p className="muted small">Nothing yet.</p>}
      {entries?.map((e) => <Entry key={e.id} e={e} names={names} />)}
      {more && (
        <button className="ghost" onClick={() => void older()}>
          Older
        </button>
      )}
    </div>
  );
}

/** Instance admin → Audit log: what super admins did. */
export function InstanceAuditSection() {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const { entries, more, older, error } = useLog("/api/admin/audit", filter);
  return (
    <>
      <div className="section-label">Audit log</div>
      <p className="muted small">What super admins changed: sign-in switches, passwords, servers, backups. Each server keeps its own log for its moderators.</p>
      <label className="audit-filter">
        Show{" "}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {INSTANCE_FILTERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error small">{error}</p>}
      {entries?.length === 0 && <p className="muted small">Nothing yet.</p>}
      {entries?.slice(0, open ? undefined : 5).map((e) => <Entry key={e.id} e={e} />)}
      {!open && (entries?.length ?? 0) > 5 && (
        <button className="ghost" onClick={() => setOpen(true)}>
          Show more
        </button>
      )}
      {open && more && (
        <button className="ghost" onClick={() => void older()}>
          Older
        </button>
      )}
    </>
  );
}

/** Instance admin → Backups. */
export function BackupSection() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api<BackupStatus>("/api/admin/backups").then(setStatus, (e: Error) => setError(e.message));
  }, []);
  if (!status) return error ? <p className="error small">{error}</p> : null;

  const run = async (fn: () => Promise<BackupStatus | void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await fn();
      if (next) setStatus(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Partial<BackupStatus["settings"]>) => void run(() => api<BackupStatus>("/api/admin/backups/settings", { method: "PUT", body: patch }));
  const restore = (name: string) => {
    if (!confirm(`Restore ${name} the next time Dendrop starts? Everything since then is set aside (moved to a before-restore folder, not deleted). Then restart the container.`)) return;
    void run(async () => {
      await api(`/api/admin/backups/${name}/restore`, { body: {} });
      setNote("Ready. Restart the Dendrop container (Unraid: Docker tab → Dendrop → Restart) to restore it.");
    });
  };
  const s = status.settings;

  return (
    <>
      <div className="section-label">Backups</div>
      <p className="muted small">
        The database and uploaded files, as one .tar.gz in <code>{status.dir}</code>. On Unraid, map that folder to a share on the array so a backup survives the
        appdata disk.
      </p>
      <div className="backup-settings">
        <label>
          Make one every{" "}
          <select value={s.everyHours} onChange={(e) => save({ everyHours: Number(e.target.value) })}>
            {[0, 6, 12, 24, 48, 168].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? "never (only by hand)" : h === 168 ? "week" : h === 24 ? "day" : h === 48 ? "2 days" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Keep the newest{" "}
          <select value={s.keep} onChange={(e) => save({ keep: Number(e.target.value) })}>
            {[...new Set([1, 3, 7, 14, 30, s.keep])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.includeUploads} onChange={(e) => save({ includeUploads: e.target.checked })} />
          <span>Include uploaded files (pictures, attachments, emoji)</span>
        </label>
      </div>
      <button className="primary" disabled={busy || status.running} onClick={() => void run(() => api<BackupStatus>("/api/admin/backups", { body: {} }))}>
        {busy || status.running ? "Backing up…" : "Back up now"}
      </button>
      {status.lastError && <p className="error small">Last backup failed: {status.lastError}</p>}
      {note && <p className="small">{note}</p>}
      {error && <p className="error small">{error}</p>}
      {status.backups.length === 0 && <p className="muted small">No backups yet.</p>}
      {status.backups.map((b) => (
        <div key={b.name} className="member-row">
          <span className="nav-text">
            <span className="ellipsis" title={b.name}>
              {when(b.createdAt)}
            </span>
            <span className="muted small">{size(b.size)}</span>
          </span>
          <span className="account-actions">
            <a className="button small-button" href={`/api/admin/backups/${b.name}`} download>
              Download
            </a>
            <button className="ghost small-button" onClick={() => restore(b.name)}>
              Restore…
            </button>
            <button
              className="ghost small-button danger"
              onClick={() => confirm(`Delete ${b.name}?`) && void run(() => api<BackupStatus>(`/api/admin/backups/${b.name}`, { method: "DELETE" }))}
            >
              Delete
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
