import { useEffect, useState, type FormEvent } from "react";
import type { AdminServer, LootdenStatus, ServerCreatorRequest } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { ServerIcon } from "./Servers.tsx";

/**
 * The super admin's view of the whole instance: who may make servers, and every server.
 * Super admins see server names and counts here, never messages.
 */
export function AdminDialog({ onClose, version }: { onClose: () => void; version: number }) {
  const [requests, setRequests] = useState<ServerCreatorRequest[] | null>(null);
  const [servers, setServers] = useState<AdminServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api<ServerCreatorRequest[]>("/api/admin/server-requests").then(setRequests, (err: Error) => setError(err.message));
    void api<AdminServer[]>("/api/admin/servers").then(setServers, (err: Error) => setError(err.message));
  };
  // version goes up when a request arrives over the gateway.
  useEffect(load, [version]);

  const decide = async (userId: number, allowed: boolean) => {
    setError(null);
    try {
      await api(`/api/admin/server-creators/${userId}`, { method: "PUT", body: { allowed } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (s: AdminServer) => {
    if (prompt(`Delete ${s.name} for everyone, with all its messages? Type the server's name to confirm.`) !== s.name) return;
    try {
      await api(`/api/servers/${s.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Instance admin" onClose={onClose}>
      {error && <p className="error">{error}</p>}
      <div className="section-label">Who can make servers</div>
      {requests?.length === 0 && <p className="muted small">No requests yet.</p>}
      {requests?.map((r) => (
        <div key={r.user.id} className="member-row">
          <span className="nav-text">
            <span className="ellipsis">
              {r.user.displayName} <span className="muted small">@{r.user.username}</span>
            </span>
            {r.reason && <span className="small">“{r.reason}”</span>}
            <span className={`muted small status-${r.status}`}>{r.status === "pending" ? "Waiting" : r.status === "approved" ? "Allowed" : "Not allowed"}</span>
          </span>
          {r.status !== "approved" && (
            <button className="primary small-button" onClick={() => void decide(r.user.id, true)}>
              Allow
            </button>
          )}
          {r.status !== "denied" && (
            <button className="ghost small" onClick={() => void decide(r.user.id, false)}>
              {r.status === "pending" ? "Deny" : "Revoke"}
            </button>
          )}
        </div>
      ))}

      <div className="section-label">Every server</div>
      <p className="muted small">Names and counts only. You can't read a server's messages unless you're a member.</p>
      {servers?.length === 0 && <p className="muted small">No servers yet.</p>}
      {servers?.map((s) => (
        <div key={s.id} className="member-row">
          <ServerIcon server={s} size={32} />
          <span className="nav-text">
            <span className="ellipsis">{s.name}</span>
            <span className="muted small">
              {s.isPublic ? "Public" : "Private"} · {s.memberCount} members · {s.channelCount} channels · owner {s.owner?.displayName ?? "unknown"}
            </span>
          </span>
          <button className="ghost small danger" onClick={() => void remove(s)}>
            Delete
          </button>
        </div>
      ))}

      <LootdenSection />
    </Modal>
  );
}

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
};

/**
 * The link to LootDen, the family's game library: its address and a LootDen admin's API token.
 * With it, what people play shows in Dendrop as their activity.
 */
function LootdenSection() {
  const [status, setStatus] = useState<LootdenStatus | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<LootdenStatus>("/api/admin/lootden").then((st) => {
      setStatus(st);
      setUrl(st.settings.url);
    }, (err: Error) => setError(err.message));
  }, []);

  const send = async (fn: () => Promise<LootdenStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const st = await fn();
      setStatus(st);
      setUrl(st.settings.url);
      setToken("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void send(() => api<LootdenStatus>("/api/admin/lootden", { method: "PUT", body: { url, token } }));
  };
  const linked = !!status?.settings.url;

  return (
    <>
      <div className="section-label">LootDen</div>
      <p className="muted small">
        Link LootDen, the family's game library, to show what people are playing (“Playing Stardew Valley on Den-PC”) to their friends and the people in their
        servers. Everyone can turn that off in Settings. Make the token in LootDen while signed in as an admin: Profile, Devices and tokens, Create token.
      </p>
      <form className="lootden-form" onSubmit={save}>
        <label>
          LootDen's address
          <input type="url" placeholder="https://games.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="off"
            placeholder={status?.settings.hasToken ? "Saved (leave empty to keep it)" : "From a LootDen admin's profile"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <div className="account-save">
          <button className="primary" disabled={busy || !url.trim()}>
            {linked ? "Save" : "Link LootDen"}
          </button>
          {linked && (
            <>
              <button type="button" className="ghost" disabled={busy} onClick={() => void send(() => api<LootdenStatus>("/api/admin/lootden/check", { body: {} }))}>
                Check now
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() => confirm("Unlink LootDen? Nobody's activity will show any more.") && void send(() => api<LootdenStatus>("/api/admin/lootden", { method: "PUT", body: { url: "" } }))}
              >
                Unlink
              </button>
            </>
          )}
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {linked && status && (
        <>
          {status.error ? (
            <p className="error">{status.error}</p>
          ) : (
            <p className="muted small">
              {status.lastOkAt ? `Connected, checked ${ago(status.lastOkAt)}.` : "Not checked yet."} {status.playing} playing right now.
            </p>
          )}
          {status.accounts.map((a) => (
            <div key={a.lootden.id} className="member-row">
              <span className="nav-text">
                <span className="ellipsis">
                  {a.lootden.displayName} <span className="muted small">@{a.lootden.username} in LootDen{a.lootden.kid ? " · kid" : ""}</span>
                </span>
                <span className="muted small">
                  {a.user ? `↔ ${a.user.displayName} (@${a.user.username}), same ${a.matchedBy === "sign-in" ? "TinyAuth sign-in" : a.matchedBy}` : "No Dendrop account with the same email or username"}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
