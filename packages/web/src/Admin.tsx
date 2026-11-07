import { useEffect, useState } from "react";
import type { AdminServer, ServerCreatorRequest } from "@dendrop/shared";
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
    </Modal>
  );
}
