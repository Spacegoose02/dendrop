import { useEffect, useState } from "react";
import { LIMITS, SERVER_PERMISSIONS, type ChatServer, type CustomRole, type Me, type ServerMember, type ServerPermission } from "@dendrop/shared";
import { api } from "./api.ts";
import { useColors } from "./colors.ts";
import { byRank, can, canManageRole, outranks, PERMISSION_INFO, rolesOf } from "./roles.ts";
import { ColorPicker } from "./Settings.tsx";

/** A role's name in its color (made readable on the current theme), with a dot. */
export function RoleChip({ role, onRemove, plain }: { role: CustomRole; onRemove?: () => void; /** Only the dot is colored (inside a chip button). */ plain?: boolean }) {
  const colorsOf = useColors();
  const color = colorsOf({ nameColor: role.color, textColor: null }).name;
  return (
    <span className={`role-chip ${plain ? "plain" : ""}`} style={plain ? undefined : color}>
      {/* The dot isn't text, so it shows the role's true color. */}
      <span className="role-dot" style={{ background: role.color ?? "var(--dd-text-faint)" }} aria-hidden />
      {role.name}
      {onRemove && (
        <button className="ghost role-chip-x" onClick={onRemove} aria-label={`Take away ${role.name}`} title={`Take away ${role.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

const setRoles = (server: ChatServer, userId: number, roleIds: number[]) =>
  api(`/api/servers/${server.id}/members/${userId}/roles`, { method: "PUT", body: { roleIds } });

/** Someone's roles in the Members tab, with a menu to give more and × to take one away, where you're allowed. */
export function MemberRoles({ me, server, member, onError }: { me: Me; server: ChatServer; member: ServerMember; onError: (e: string) => void }) {
  const held = rolesOf(server, member);
  const mayChange = can(server, "manageRoles") && (member.user.id === me.id || server.myRole === "owner" || server.myRole === "admin" || outranks(server, me.id, member));
  const givable = mayChange ? server.roles.filter((r) => !member.roleIds.includes(r.id) && canManageRole(server, me.id, r)) : [];
  const change = (ids: number[]) => void setRoles(server, member.user.id, ids).catch((e: Error) => onError(e.message));
  if (!held.length && !givable.length) return null;
  return (
    <span className="member-roles">
      {held.map((r) => (
        <RoleChip key={r.id} role={r} onRemove={mayChange && canManageRole(server, me.id, r) ? () => change(member.roleIds.filter((x) => x !== r.id)) : undefined} />
      ))}
      {givable.length > 0 && (
        <select className="add-role" value="" aria-label={`Give ${member.user.displayName} a role`} onChange={(e) => e.target.value && change([...member.roleIds, Number(e.target.value)])}>
          <option value="">＋ Role</option>
          {givable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/** Making, ordering, coloring and handing out custom roles. */
export function RolesTab({ me, server }: { me: Me; server: ChatServer }) {
  const [editing, setEditing] = useState<number | null>(server.roles[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const role = server.roles.find((r) => r.id === editing);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = () =>
    void run(async () => {
      const r = await api<CustomRole>(`/api/servers/${server.id}/roles`, { body: { name: "New role", color: null } });
      setEditing(r.id);
    });

  /** Swaps a role with the one above (-1) or below (+1). */
  const move = (i: number, by: -1 | 1) => {
    const ids = server.roles.map((r) => r.id);
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    void run(() => api(`/api/servers/${server.id}/roles/order`, { method: "PUT", body: { ids } }));
  };

  return (
    <div className="server-settings roles-tab">
      <p className="muted small">
        Roles give people a color and things they can do. Higher roles come first: a name shows in the color of its highest colored role, and people can only manage roles and
        members ranked below them. The owner and admins are above every role. Kid accounts can only have roles without moderator permissions.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="roles-layout">
        <div className="role-list" role="listbox" aria-label="Roles, highest first">
          {server.roles.length === 0 && <p className="muted small">No roles yet.</p>}
          {server.roles.map((r, i) => {
            const mine = canManageRole(server, me.id, r);
            return (
              <div key={r.id} className={`role-row ${editing === r.id ? "on" : ""}`} role="option" aria-selected={editing === r.id}>
                <button className="ghost role-pick" onClick={() => setEditing(r.id)}>
                  <RoleChip role={r} />
                  <span className="muted small">{r.memberCount}</span>
                </button>
                {mine && i > 0 && canManageRole(server, me.id, server.roles[i - 1]!) && (
                  <button className="ghost small" onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`} title="Move up">
                    ↑
                  </button>
                )}
                {mine && i < server.roles.length - 1 && (
                  <button className="ghost small" onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`} title="Move down">
                    ↓
                  </button>
                )}
              </div>
            );
          })}
          {can(server, "manageRoles") && server.roles.length < LIMITS.rolesPerServer && (
            <button className="wide" onClick={create}>
              ＋ New role
            </button>
          )}
        </div>
        {role && <RoleEditor key={role.id} me={me} server={server} role={role} onError={setError} onDeleted={() => setEditing(null)} />}
      </div>
    </div>
  );
}

function RoleEditor({ me, server, role, onError, onDeleted }: { me: Me; server: ChatServer; role: CustomRole; onError: (e: string | null) => void; onDeleted: () => void }) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [perms, setPerms] = useState<ServerPermission[]>(role.permissions);
  const [saved, setSaved] = useState(false);
  const colorsOf = useColors();
  const editable = canManageRole(server, me.id, role);
  const preview = colorsOf({ nameColor: color, textColor: null }).name;
  const adjusted = !!color && preview?.color !== color;
  const moderates = perms.some((p) => PERMISSION_INFO[p].moderates);
  useEffect(() => setSaved(false), [name, color, perms]);

  const save = async () => {
    onError(null);
    try {
      await api(`/api/servers/${server.id}/roles/${role.id}`, { method: "PATCH", body: { name, color, permissions: perms } });
      setSaved(true);
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the ${role.name} role? ${role.memberCount ? `${role.memberCount} ${role.memberCount === 1 ? "person loses" : "people lose"} it.` : ""}`)) return;
    try {
      await api(`/api/servers/${server.id}/roles/${role.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const toggleMember = (m: ServerMember) => {
    const ids = m.roleIds.includes(role.id) ? m.roleIds.filter((x) => x !== role.id) : [...m.roleIds, role.id];
    void setRoles(server, m.user.id, ids).catch((e: Error) => onError(e.message));
  };
  // People whose roles you can change: yourself, and anyone ranked below you.
  const mayChange = (m: ServerMember) => editable && (m.user.id === me.id || server.myRole === "owner" || server.myRole === "admin" || outranks(server, me.id, m));

  return (
    <div className="role-editor">
      {!editable && <p className="muted small">This role ranks at or above yours, so you can see it but not change it.</p>}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.roleName} disabled={!editable} />
      </label>
      {editable ? <ColorPicker label="Color" value={color} onChange={setColor} /> : null}
      <p className="role-preview">
        <strong style={preview}>{me.displayName}</strong>
        <span className="muted small">
          {color ? (adjusted ? " Adjusted a little so it reads well on this theme." : " How names with this role look on this theme.") : " No color: people keep their own name color."}
        </span>
      </p>

      <div className="section-label">Permissions</div>
      <div className="perm-list">
        {SERVER_PERMISSIONS.map((p) => {
          const mine = server.myPermissions.includes(p);
          return (
            <label key={p} className="toggle">
              <input
                type="checkbox"
                checked={perms.includes(p)}
                disabled={!editable || !mine}
                onChange={() => setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : SERVER_PERMISSIONS.filter((x) => x === p || cur.includes(x))))}
              />
              <span>
                <strong>{PERMISSION_INFO[p].label}</strong>
                <span className="muted small">
                  {PERMISSION_INFO[p].detail}
                  {editable && !mine && " You don't have this, so you can't change it."}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {moderates && <p className="muted small">🧒 Kid accounts can't have this role while it has moderator permissions.</p>}
      {editable && (
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            Save role
          </button>
          {saved && <span className="small">Saved</span>}
          <span className="spacer" />
          <button className="danger-button" onClick={() => void remove()}>
            Delete role
          </button>
        </div>
      )}

      <div className="section-label">People with this role · {role.memberCount}</div>
      <div className="pick-list">
        {byRank(server).map((m) => (
          <label key={m.user.id} className="pick">
            <input type="checkbox" checked={m.roleIds.includes(role.id)} disabled={!mayChange(m)} onChange={() => toggleMember(m)} />
            <span className="ellipsis" style={colorsOf({ nameColor: m.color ?? m.user.nameColor, textColor: null }).name}>
              {m.nickname ?? m.user.displayName}
            </span>
            <span className="muted small">@{m.user.username}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
