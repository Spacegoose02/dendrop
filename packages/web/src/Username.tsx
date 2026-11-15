import { useEffect, useState } from "react";
import { LIMITS, usernameProblem, type Me, type UsernameCheck } from "@dendrop/shared";
import { api } from "./api.ts";

type Check = { name: string; state: "checking" | "free" | "taken"; reason?: string };

/**
 * Whether `name` could be your username, checked a moment after you stop typing. The rules are
 * checked here first, so only names that could work ask the server.
 */
function useUsernameCheck(name: string, current: string): Check | null {
  const trimmed = name.trim();
  const [check, setCheck] = useState<Check | null>(null);
  const problem = trimmed ? usernameProblem(trimmed) : null;
  const same = trimmed === current;
  useEffect(() => {
    if (!trimmed || problem || same) return;
    let live = true;
    setCheck({ name: trimmed, state: "checking" });
    const t = setTimeout(() => {
      api<UsernameCheck>(`/api/usernames/available?name=${encodeURIComponent(trimmed)}`)
        .then((r) => live && setCheck({ name: trimmed, state: r.available ? "free" : "taken", reason: r.reason }))
        .catch(() => live && setCheck(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [trimmed, problem, same]);
  if (!trimmed || same) return null;
  if (problem) return { name: trimmed, state: "taken", reason: problem };
  return check?.name === trimmed ? check : { name: trimmed, state: "checking" };
}

/** Saves a new username (or the same one, to keep it). */
const saveUsername = (username: string) => api<Me>("/api/me/username", { method: "PUT", body: { username } });

function CheckLine({ check }: { check: Check | null }) {
  if (!check) return null;
  if (check.state === "checking") return <span className="muted small">Checking…</span>;
  if (check.state === "free") return <span className="small username-free">@{check.name} is free</span>;
  return <span className="error small">{check.reason ?? "That username is taken"}</span>;
}

/** Settings → Account: change your username, with a check as you type. */
export function UsernameSetting({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [name, setName] = useState(me.username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const check = useUsernameCheck(name, me.username);
  const locked = me.isKid && me.managedBy !== null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await saveUsername(name.trim());
      onSaved(updated);
      setName(updated.username);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="username-setting">
      <label>
        Username
        <span className="username-input">
          <span aria-hidden="true">@</span>
          <input
            value={name}
            disabled={locked}
            onChange={(e) => {
              setName(e.target.value);
              setDone(false);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && check?.state === "free" && !saving && void save()}
            maxLength={LIMITS.usernameLength}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button className="primary" disabled={locked || saving || check?.state !== "free"} onClick={() => void save()}>
            Change
          </button>
        </span>
      </label>
      {locked ? (
        <p className="muted small">Your parent looks after how this account signs in, so they'd need to change it.</p>
      ) : (
        <p className="muted small">
          {error ? <span className="error">{error}</span> : done ? <span>Changed. Friends and chats carry on as before. </span> : <CheckLine check={check} />}
          {!error && !check && !done && "What people type to add you as a friend or @mention you. If you sign in with a password, you'll use the new one."}
        </p>
      )}
    </div>
  );
}

/**
 * Asked once, the first time someone opens Dendrop with a username their TinyAuth or Google
 * sign-in picked for them. Keeping it counts as an answer, so it doesn't come back.
 */
export function PickUsernameDialog({ me, onDone }: { me: Me; onDone: (me: Me) => void }) {
  const [name, setName] = useState(me.username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(name, me.username);
  const same = name.trim() === me.username;

  const submit = async (username: string) => {
    setSaving(true);
    setError(null);
    try {
      onDone(await saveUsername(username));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal pick-username" role="dialog" aria-modal="true" aria-label="Pick your username">
        <header className="modal-header">
          <h2>Pick your username</h2>
        </header>
        <p>
          Welcome, {me.displayName}! Your sign-in gave you the username <strong>@{me.username}</strong>. It's what friends type to add you and to @mention
          you. Keep it, or choose your own. You can change it later in Settings → Account.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (same) void submit(me.username);
            else if (check?.state === "free") void submit(name.trim());
          }}
        >
          <label>
            Username
            <span className="username-input">
              <span aria-hidden="true">@</span>
              <input
                value={name}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                maxLength={LIMITS.usernameLength}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </span>
          </label>
          <p className="small">{error ? <span className="error">{error}</span> : <CheckLine check={check} />}</p>
          <div className="modal-actions">
            {!same && (
              <button type="button" className="ghost" disabled={saving} onClick={() => void submit(me.username)}>
                Keep @{me.username}
              </button>
            )}
            <button type="submit" className="primary" disabled={saving || (!same && check?.state !== "free")}>
              {same ? `Keep @${me.username}` : `Use @${name.trim()}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
