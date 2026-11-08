import { useState } from "react";
import { WELCOME_LIMITS, type ChatServer, type Me, type WelcomeRole } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { RoleChip } from "./Roles.tsx";
import { canManageRole, can, PERMISSION_INFO } from "./roles.ts";

/** Whether someone still has to go through a server's welcome screen. Owners and admins never do. */
export const needsWelcome = (s: ChatServer): boolean => s.welcome.enabled && !s.welcomedAt && s.myRole === "member";

/** Whether you can't post or talk yet because you haven't agreed to the rules. */
export const mustAgree = (s: ChatServer): boolean => needsWelcome(s) && s.welcome.requireAgree && s.welcome.rules.length > 0;

/**
 * What new members see first: a hello, the rules (agree to them if the server asks), and roles
 * they can pick for themselves. Can be opened again any time from the sidebar.
 */
export function WelcomeScreen({ me, server, onClose, onDone }: { me: Me; server: ChatServer; onClose: () => void; onDone: (s: ChatServer) => void }) {
  const w = server.welcome;
  const mine = server.members.find((m) => m.user.id === me.id);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(w.roles.map((r) => r.roleId).filter((id) => mine?.roleIds.includes(id))));
  const [agreed, setAgreed] = useState(!!server.welcomedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needAgree = w.requireAgree && w.rules.length > 0;
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const done = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = w.roles.length ? { roleIds: [...picked] } : {};
      onDone(await api<ChatServer>(`/api/servers/${server.id}/welcome/done`, { body }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Welcome to ${server.name}`} onClose={onClose}>
      <div className="welcome">
        {server.bannerUrl && <img className="welcome-banner" src={server.bannerUrl} alt="" />}
        <div className="welcome-hello">
          <span className="welcome-emoji" aria-hidden>
            🦝
          </span>
          <p>{w.message || `Make yourself at home in ${server.name}.`}</p>
        </div>
        {w.rules.length > 0 && (
          <>
            <div className="section-label">Rules</div>
            <ol className="welcome-rules">
              {w.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ol>
          </>
        )}
        {w.roles.length > 0 && (
          <>
            <div className="section-label">Pick your roles</div>
            <p className="muted small">They show next to your name, and some open channels just for them. You can change them any time.</p>
            <div className="welcome-roles">
              {w.roles.map((wr) => {
                const role = server.roles.find((r) => r.id === wr.roleId);
                if (!role) return null;
                const on = picked.has(role.id);
                return (
                  <button key={role.id} className={`welcome-role ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(role.id)}>
                    <span className="welcome-role-emoji" aria-hidden>
                      {wr.emoji || "✨"}
                    </span>
                    <span className="nav-text">
                      <RoleChip role={role} />
                      {wr.description && <span className="muted small">{wr.description}</span>}
                    </span>
                    <span className="welcome-check" aria-hidden>
                      {on ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {needAgree && !server.welcomedAt && (
          <label className="toggle">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              <strong>I've read the rules and I'll follow them</strong>
              <span className="muted small">You can post and talk here once you agree.</span>
            </span>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row welcome-actions">
          {!server.welcomedAt && <button onClick={onClose}>Later</button>}
          <button className="primary" disabled={busy || (needAgree && !agreed)} onClick={() => void done()}>
            {server.welcomedAt ? "Save" : needAgree ? "Agree and join in" : "Let's go"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Server settings: set up the welcome screen. */
export function WelcomeTab({ me, server }: { me: Me; server: ChatServer }) {
  const w = server.welcome;
  const [enabled, setEnabled] = useState(w.enabled);
  const [message, setMessage] = useState(w.message);
  const [rules, setRules] = useState<string[]>(w.rules.length ? w.rules : [""]);
  const [requireAgree, setRequireAgree] = useState(w.requireAgree);
  const [roles, setRoles] = useState<WelcomeRole[]>(w.roles);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manageRoles = can(server, "manageRoles");
  const moderates = (id: number) => server.roles.find((r) => r.id === id)?.permissions.some((p) => PERMISSION_INFO[p].moderates) ?? false;
  /** Roles you could add: ones below your own that don't moderate. */
  const addable = server.roles.filter((r) => !roles.some((x) => x.roleId === r.id) && !moderates(r.id) && canManageRole(server, me.id, r));

  const save = async () => {
    setError(null);
    setStatus(null);
    try {
      await api(`/api/servers/${server.id}/welcome`, {
        method: "PUT",
        body: { enabled, message, rules: rules.map((r) => r.trim()).filter(Boolean), requireAgree, ...(manageRoles ? { roles } : {}) },
      });
      setStatus("Saved");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const setRole = (i: number, patch: Partial<WelcomeRole>) => setRoles((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="server-settings">
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          <strong>Show a welcome screen</strong>
          <span className="muted small">New members see it when they join. Anyone can open it again from the top of the channel list.</span>
        </span>
      </label>
      <label>
        Welcome message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={WELCOME_LIMITS.message} rows={3} placeholder={`Make yourself at home in ${server.name}.`} />
      </label>

      <div className="section-label">Rules</div>
      {rules.map((r, i) => (
        <div key={i} className="row">
          <span className="welcome-rule-number">{i + 1}.</span>
          <input
            value={r}
            maxLength={WELCOME_LIMITS.ruleLength}
            placeholder="Be kind to everyone"
            aria-label={`Rule ${i + 1}`}
            onChange={(e) => setRules((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button className="ghost" aria-label={`Remove rule ${i + 1}`} title="Remove" onClick={() => setRules((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [""]))}>
            ✕
          </button>
        </div>
      ))}
      {rules.length < WELCOME_LIMITS.rules && (
        <button className="ghost" onClick={() => setRules((list) => [...list, ""])}>
          ＋ Add a rule
        </button>
      )}
      <label className="toggle">
        <input type="checkbox" checked={requireAgree} onChange={(e) => setRequireAgree(e.target.checked)} />
        <span>
          <strong>Members have to agree to the rules before they can post or talk</strong>
          <span className="muted small">The owner, admins and bots don't need to.</span>
        </span>
      </label>

      <div className="section-label">Roles members can pick</div>
      {!manageRoles ? (
        <p className="muted small">You need Manage roles to change which roles are offered.</p>
      ) : (
        <>
          <p className="muted small">
            Members pick these for themselves, so roles that can moderate can't be offered. Lock a channel to a role to make a channel just for it.
          </p>
          {roles.map((wr, i) => {
            const role = server.roles.find((r) => r.id === wr.roleId);
            if (!role) return null;
            return (
              <div key={wr.roleId} className="welcome-role-edit">
                <input
                  className="welcome-emoji-input"
                  value={wr.emoji}
                  maxLength={WELCOME_LIMITS.emoji}
                  placeholder="✨"
                  aria-label={`Emoji for ${role.name}`}
                  onChange={(e) => setRole(i, { emoji: e.target.value })}
                />
                <RoleChip role={role} />
                <input
                  value={wr.description}
                  maxLength={WELCOME_LIMITS.roleDescription}
                  placeholder="What it's for"
                  aria-label={`What ${role.name} is for`}
                  onChange={(e) => setRole(i, { description: e.target.value })}
                />
                <button className="ghost" aria-label={`Stop offering ${role.name}`} title="Remove" onClick={() => setRoles((list) => list.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            );
          })}
          {addable.length > 0 && roles.length < WELCOME_LIMITS.roles ? (
            <select
              value=""
              aria-label="Offer a role"
              onChange={(e) => e.target.value && setRoles((list) => [...list, { roleId: Number(e.target.value), emoji: "", description: "" }])}
            >
              <option value="">＋ Offer a role…</option>
              {addable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : (
            roles.length === 0 && <p className="muted small">Make some roles without moderator permissions in Roles first, like "Gamers" or "Artists".</p>
          )}
        </>
      )}

      <button className="primary wide" onClick={() => void save()}>
        Save welcome screen
      </button>
      {status && <p className="small">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
