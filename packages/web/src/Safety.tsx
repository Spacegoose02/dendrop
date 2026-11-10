import { useEffect, useState, useSyncExternalStore } from "react";
import { REPORT_REASONS, type Me, type PublicUser, type Report, type ReportReason } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";

// ---- Who you blocked ----------------------------------------------------------------------

let blocked: PublicUser[] = [];
let blockedIds = new Set<number>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

/** Replaces the list (from the server, or a gateway event from another device). */
export function setBlocked(list: PublicUser[]): void {
  blocked = list;
  blockedIds = new Set(list.map((u) => u.id));
  emit();
}

/** Loads who you blocked. Called when the app starts and after reconnecting. */
export function loadBlocked(): void {
  void api<PublicUser[]>("/api/blocks").then(setBlocked, () => undefined);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The ids of people you blocked, re-rendering when that changes. */
export function useBlockedIds(): Set<number> {
  return useSyncExternalStore(subscribe, () => blockedIds);
}

export function useBlocked(): PublicUser[] {
  return useSyncExternalStore(subscribe, () => blocked);
}

export async function block(user: { id: number; displayName: string }): Promise<boolean> {
  if (!confirm(`Block ${user.displayName}? You stop being friends, neither of you can message the other directly, and their messages are hidden from you in groups and servers. They aren't told.`)) return false;
  await api("/api/blocks", { body: { userId: user.id } });
  loadBlocked();
  return true;
}

export async function unblock(userId: number): Promise<void> {
  await api(`/api/blocks/${userId}`, { method: "DELETE" });
  loadBlocked();
}

/** Settings: the people you blocked, with Unblock. */
export function BlockedSection() {
  const list = useBlocked();
  return (
    <section>
      <h3>Blocked</h3>
      <p className="muted small">People you block can't send you friend requests or direct messages, and their messages are hidden from you everywhere else. Block someone from their profile card.</p>
      {list.length === 0 && <p className="muted small">You haven't blocked anyone.</p>}
      {list.map((u) => (
        <div key={u.id} className="member-row">
          <Avatar name={u.displayName} src={u.avatar} size={28} />
          <span className="nav-text">
            <span className="ellipsis">{u.displayName}</span>
            <span className="muted small">@{u.username}</span>
          </span>
          <button className="ghost small" onClick={() => void unblock(u.id)}>
            Unblock
          </button>
        </div>
      ))}
    </section>
  );
}

// ---- Reporting -----------------------------------------------------------------------------

/**
 * Reports a message or a person. For a message in an encrypted chat the server can't read it,
 * so the reporter chooses whether to share its text (on by default).
 */
export function ReportDialog({
  target,
  onClose,
}: {
  target: { kind: "message"; messageId: number; authorName: string; text: string; encrypted: boolean; inServer: boolean } | { kind: "user"; user: { id: number; displayName: string } };
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [share, setShare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const who = target.kind === "message" ? target.authorName : target.user.displayName;
  const goesTo = target.kind === "message" && target.inServer ? "this server's moderators" : "the people who run this Dendrop";

  const send = async () => {
    setError(null);
    try {
      await api("/api/reports", {
        body:
          target.kind === "message"
            ? { messageId: target.messageId, reason, details, quote: target.encrypted && share ? target.text : undefined }
            : { userId: target.user.id, reason, details },
      });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={target.kind === "message" ? "Report message" : `Report ${who}`} onClose={onClose}>
      {sent ? (
        <div className="server-settings">
          <p>Thanks. Your report went to {goesTo}. {who} isn't told who reported them.</p>
          <p className="muted small">If you don't want to hear from {who} again, you can also block them from their profile card.</p>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="server-settings">
          <p className="muted small">
            This goes to {goesTo}. {who} isn't told who reported them. If someone is in danger right now, contact emergency services.
          </p>
          {target.kind === "message" && target.text && <blockquote className="report-quote">{target.text.slice(0, 500)}</blockquote>}
          <label>
            What's wrong?
            <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
              <option value="" disabled>
                Pick a reason
              </option>
              {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => (
                <option key={r} value={r}>
                  {REPORT_REASONS[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Anything else they should know? (optional)
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} rows={3} />
          </label>
          {target.kind === "message" && target.encrypted && (
            <label className="toggle">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
              <span>
                <strong>Share this message's text</strong>
                <span className="muted small">This chat is end-to-end encrypted, so they can only see the message if you share it.</span>
              </span>
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary" disabled={!reason} onClick={() => void send()}>
              Send report
            </button>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Reports to review: a server's (serverId) or the super admins' (null). */
export function ReportsList({ serverId, onDeleteMessage }: { serverId: number | null; onDeleteMessage?: (messageId: number) => Promise<void> }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = serverId === null ? "/api/admin/reports" : `/api/servers/${serverId}/reports`;
  const load = () => void api<Report[]>(url).then(setReports, (err: Error) => setError(err.message));
  useEffect(load, [url]);
  const resolve = async (r: Report, resolved: boolean) => {
    try {
      await api(`/api/reports/${r.id}/resolve`, { body: { resolved } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const open = reports?.filter((r) => !r.resolvedAt) ?? [];
  const done = reports?.filter((r) => r.resolvedAt) ?? [];
  const row = (r: Report) => (
    <div key={r.id} className={`report-row ${r.resolvedAt ? "done" : ""}`}>
      <div className="report-head">
        <strong>{REPORT_REASONS[r.reason] ?? r.reason}</strong>
        <span className="muted small">
          {" "}
          · {r.reported ? `${r.reported.displayName} (@${r.reported.username})` : "A deleted account"} · {r.place} · {new Date(r.createdAt).toLocaleString()}
        </span>
      </div>
      {r.quote ? <blockquote className="report-quote">{r.quote}</blockquote> : r.messageId !== null || r.conversationId !== null ? <p className="muted small">The reporter didn't share the message's text.</p> : null}
      {r.details && <p className="small">“{r.details}”</p>}
      <p className="muted small">
        Reported by {r.reporter?.displayName ?? "a deleted account"}
        {r.resolvedAt && <> · handled by {r.resolvedBy?.displayName ?? "someone"}</>}
      </p>
      <div className="row">
        {!r.resolvedAt && onDeleteMessage && r.messageId !== null && (
          <button
            className="ghost small danger"
            onClick={() =>
              void onDeleteMessage(r.messageId!)
                .then(() => resolve(r, true))
                .catch((err: Error) => setError(err.message))
            }
          >
            Delete message
          </button>
        )}
        <button className="ghost small" onClick={() => void resolve(r, !r.resolvedAt)}>
          {r.resolvedAt ? "Reopen" : "Mark handled"}
        </button>
      </div>
    </div>
  );
  return (
    <div className="server-settings">
      {error && <p className="error">{error}</p>}
      {reports && open.length === 0 && <p className="muted">Nothing to review.</p>}
      {open.map(row)}
      {done.length > 0 && (
        <details>
          <summary className="muted small">Handled ({done.length})</summary>
          {done.map(row)}
        </details>
      )}
    </div>
  );
}

// ---- Your account and data -----------------------------------------------------------------

/** Settings: download your data, and delete your account. */
export function YourDataSection({ me, onDeleted }: { me: Me; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setError(null);
    try {
      await api("/api/me", { method: "DELETE", body: { password: confirmText, username: confirmText } });
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section>
      <h3>Your data</h3>
      <p className="muted small">Download everything Dendrop keeps about you: your account, friends, servers and the messages you wrote. Messages from encrypted chats stay encrypted in the file.</p>
      <a className="button" href="/api/me/export" download>
        Download my data
      </a>
      {!me.isKid && (
        <>
          <h3>Delete account</h3>
          <p className="muted small">
            Deletes your account for good, with your messages, files, reactions and friends. It can't be undone. If you own a server, give it to someone else first.
          </p>
          {!deleting ? (
            <button className="danger" onClick={() => setDeleting(true)}>
              Delete my account…
            </button>
          ) : (
            <div className="danger-zone">
              <label>
                Your password. If you only sign in with single sign-on, type your username ({me.username}) instead.
                <input type="password" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="current-password" />
              </label>
              {error && <p className="error">{error}</p>}
              <div className="row">
                <button className="danger" disabled={!confirmText} onClick={() => void remove()}>
                  Delete forever
                </button>
                <button className="ghost" onClick={() => setDeleting(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
