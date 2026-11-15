import { useEffect, useState, type FormEvent } from "react";
import type { AdminAccount, AdminSignIn, MySignIns, SignInMove, SignInProvider, SignInSettings } from "@dendrop/shared";
import { Modal } from "./Modal.tsx";
import { api, ApiError } from "./api.ts";
import { TwoFactorSection } from "./TwoFactor.tsx";

/** Settings → Sign-in: your password, and Google or TinyAuth linked to this account. */
export function SignInSection() {
  const [mine, setMine] = useState<MySignIns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    void api<MySignIns>("/api/me/signins").then(setMine, (err: Error) => setError(err.message));
  }, []);
  if (!mine) return error ? <p className="error small">{error}</p> : null;

  const link = async (p: SignInProvider) => {
    setError(null);
    try {
      const { url } = await api<{ url: string }>(`/api/me/signins/${p}`, { body: {} });
      location.href = url;
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const unlink = async (p: SignInProvider, name: string) => {
    if (!confirm(`Stop signing in with ${name}?`)) return;
    setError(null);
    try {
      setMine(await api<MySignIns>(`/api/me/signins/${p}`, { method: "DELETE" }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const rows: { p: SignInProvider; name: string; linked: boolean; detail: string | null; available: boolean; note: string | null }[] = [
    { p: "tinyauth", name: mine.tinyauth.name, linked: mine.tinyauth.linked, detail: mine.tinyauth.account ?? null, available: mine.tinyauth.available, note: mine.tinyauth.note ?? null },
    { p: "google", name: "Google", linked: mine.google.linked, detail: mine.google.email, available: mine.google.available, note: mine.google.note ?? null },
  ];

  return (
    <section className="signin-settings">
      <h3>Sign-in</h3>
      {mine.managedBy ? (
        <p className="muted small">
          Your account is under {mine.managedBy.displayName}'s. Ask them if you need a new password; they can hand the account over to you
          when you're ready.
        </p>
      ) : (
        <>
          <div className="signin-row">
            <span>
              <strong>Password</strong>
              <span className="muted small">{mine.password ? " Set" : " Not set"}</span>
            </span>
            <button onClick={() => setChanging(!changing)}>{mine.password ? "Change" : "Set a password"}</button>
          </div>
          {changing && (
            <PasswordForm
              hasPassword={mine.password}
              onDone={(m) => {
                setMine(m);
                setChanging(false);
              }}
            />
          )}
          {rows
            // A provider shows when it's linked or can be linked, and otherwise says why not
            // (switched off, or for super admins, not set up yet) rather than vanishing.
            .filter((r) => r.linked || r.available || r.note)
            .map((r) => (
              <div key={r.p} className="signin-row">
                <span>
                  <strong>{r.name}</strong>
                  <span className="muted small">{r.linked ? ` Linked${r.detail ? `: ${r.detail}` : ""}` : " Not linked"}</span>
                  {!r.available && r.note && <span className="muted small signin-note">{r.note}</span>}
                </span>
                {r.linked ? (
                  <button className="ghost danger" onClick={() => void unlink(r.p, r.name)}>
                    Unlink
                  </button>
                ) : (
                  mine.canLink && r.available && <button onClick={() => void link(r.p)}>Link {r.name}</button>
                )}
              </div>
            ))}
          {!mine.canLink && <p className="muted small">The admin has switched off linking sign-ins.</p>}
          <TwoFactorSection hasPassword={mine.password} />
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/**
 * Shown on coming back from linking a login that another account already has (often one a
 * first sign-in made by itself): offers to move it to this account.
 */
export function SignInMoveDialog({ provider, token, onDone }: { provider: SignInProvider; token: string; onDone: (notice: string | null) => void }) {
  const [move, setMove] = useState<SignInMove | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/me/signins/${provider}/moves/${encodeURIComponent(token)}`;
  useEffect(() => {
    void api<SignInMove>(url).then(setMove, (err: Error) => setError(err.message));
  }, [url]);

  const cancel = () => {
    void api(url, { method: "DELETE" }).catch(() => {});
    onDone(null);
  };
  const confirmMove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<MySignIns>(url, { body: {} });
      onDone(`${move?.name ?? "That sign-in"} is linked to this account now. You can sign in with it.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const name = move?.name ?? (provider === "google" ? "Google" : "TinyAuth");
  const from = move?.from;
  return (
    <Modal title={`Move ${name} to this account?`} onClose={cancel}>
      {from ? (
        <div className="signin-move">
          <p>
            The {name} login{move.login ? <> <strong>{move.login}</strong></> : null} is already on another Dendrop account,{" "}
            <strong>{from.user.displayName}</strong> <span className="muted">@{from.user.username}</span>, made{" "}
            {new Date(from.createdAt).toLocaleDateString()}
            {from.messages === 0 ? " and never used to send a message" : `, which has sent ${from.messages} message${from.messages === 1 ? "" : "s"}`}.
          </p>
          <p>
            You just signed in to {name} as that login, so you can move it here. Afterwards you sign in with {name} to <em>this</em> account.
          </p>
          <p className="muted small">
            {from.otherWaysIn.length
              ? `@${from.user.username} keeps its other ways in (${from.otherWaysIn.join(", ")}).`
              : `@${from.user.username} will have no way to sign in left. Nothing in it is deleted; the admin can tidy it up.`}
          </p>
        </div>
      ) : (
        !error && <p className="muted">Loading…</p>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="modal-actions">
        <button className="ghost" onClick={cancel}>
          {from ? "Keep it there" : "Close"}
        </button>
        {from && (
          <button className="primary" disabled={busy} onClick={() => void confirmMove()}>
            Move {name} here
          </button>
        )}
      </div>
    </Modal>
  );
}

function PasswordForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: (m: MySignIns) => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setError(null);
    try {
      onDone(await api<MySignIns>("/api/me/password", { method: "PUT", body: { current, password } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="signin-form" onSubmit={(e) => void submit(e)}>
      {hasPassword && (
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
      )}
      <label>
        New password
        <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <label>
        Type it again
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      {hasPassword && <p className="muted small">Your other devices will be signed out.</p>}
      {error && <p className="error small">{error}</p>}
      <button className="primary">Save password</button>
    </form>
  );
}

const SWITCHES: { key: keyof SignInSettings; label: string; hint: string; needs?: "tinyauth" | "google" }[] = [
  { key: "passwordLogin", label: "Password sign-in", hint: "Sign in with a username and password." },
  { key: "signup", label: "Open sign-up", hint: "Anyone who can reach this server can make a password account." },
  { key: "tinyauth", label: "TinyAuth sign-in", hint: "Sign in through your TinyAuth.", needs: "tinyauth" },
  { key: "tinyauthSignup", label: "New accounts from TinyAuth", hint: "A first TinyAuth sign-in makes a Dendrop account.", needs: "tinyauth" },
  { key: "google", label: "Google sign-in", hint: "Sign in with a Google account.", needs: "google" },
  { key: "googleSignup", label: "New accounts from Google", hint: "Off: Google only works after someone links it in Settings.", needs: "google" },
  { key: "linking", label: "Linking sign-ins", hint: "People can link Google or TinyAuth to their account." },
  { key: "parentKidAccounts", label: "Parents can make kid accounts", hint: "A parent makes a kid account under theirs and looks after its password." },
];

/** The super admin's master control for signing in, and everyone's sign-ins. */
export function AdminSignInSection() {
  const [view, setView] = useState<AdminSignIn | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The account whose "Link TinyAuth" panel is open. */
  const [linking, setLinking] = useState<number | null>(null);

  const load = () => {
    void api<AdminSignIn>("/api/admin/signin").then(setView, (err: Error) => setError(err.message));
    void api<AdminAccount[]>("/api/admin/accounts").then(setAccounts, (err: Error) => setError(err.message));
  };
  useEffect(load, []);

  const flip = async (key: keyof SignInSettings, value: boolean) => {
    setError(null);
    try {
      setView(await api<AdminSignIn>("/api/admin/signin", { method: "PUT", body: { [key]: value } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const unlink = (a: AdminAccount, p: SignInProvider, name: string) => {
    if (!confirm(`Remove ${name} sign-in from ${a.user.displayName}?`)) return;
    void act(() => api(`/api/admin/accounts/${a.user.id}/signins/${p}`, { method: "DELETE" }));
  };
  const setPassword = (a: AdminAccount) => {
    const password = prompt(`New password for ${a.user.displayName} (at least 10 characters). They'll be signed out everywhere.`);
    if (password) void act(() => api(`/api/admin/accounts/${a.user.id}/password`, { method: "PUT", body: { password } }));
  };

  const setCouples = (a: AdminAccount, on: boolean) => {
    if (!on && !confirm(`Turn off the couples kit for ${a.user.displayName}? Everything in their couples kits is deleted.`)) return;
    void act(() => api(`/api/admin/accounts/${a.user.id}/couples`, { method: "PUT", body: { on } }));
  };

  const reset2fa = (a: AdminAccount) => {
    if (!confirm(`Turn off two-step sign-in for ${a.user.displayName} and remove their passkeys? Do this when they've lost their phone. They'll be signed out everywhere.`)) return;
    void act(() => api(`/api/admin/accounts/${a.user.id}/2fa`, { method: "DELETE" }));
  };

  if (!view) return error ? <p className="error">{error}</p> : null;
  const tinyName = view.configured.tinyauthName;
  return (
    <>
      <div className="section-label">Sign-in</div>
      {!view.configured.publicUrl && <p className="muted small">Set DENDROP_PUBLIC_URL to use TinyAuth or Google.</p>}
      <div className="signin-switches">
        {SWITCHES.map((sw) => {
          const missing = sw.needs && !view.configured[sw.needs];
          return (
            <label key={sw.key} className={`toggle ${missing ? "disabled" : ""}`}>
              <input type="checkbox" checked={view.settings[sw.key] && !missing} disabled={!!missing} onChange={(e) => void flip(sw.key, e.target.checked)} />
              <span>
                <strong>{sw.label.replace("TinyAuth", tinyName)}</strong>
                <span className="muted small">
                  {missing ? (sw.needs === "google" ? "Not set up: add DENDROP_GOOGLE_CLIENT_ID and _SECRET." : "Not set up: add the DENDROP_OIDC_* settings.") : sw.hint.replace("TinyAuth", tinyName)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error && <p className="error small">{error}</p>}

      <div className="section-label">Accounts</div>
      {accounts?.map((a) => (
        <div key={a.user.id} className="member-row account-row">
          <span className="nav-text">
            <span className="ellipsis">
              {a.user.displayName} <span className="muted small">@{a.user.username}</span>
              {a.isSuperAdmin && <span className="muted small"> · admin</span>}
              {a.isKid && <span className="muted small"> · kid{a.managedBy ? ` under ${a.managedBy}` : ""}</span>}
            </span>
            <span className="muted small">
              {[a.password && "Password", a.tinyauth && `${tinyName}${loginLabel(a) ? ` (${loginLabel(a)})` : ""}`, a.google && `Google (${a.google})`, a.passkeys && `${a.passkeys} passkey${a.passkeys === 1 ? "" : "s"}`]
                .filter(Boolean)
                .join(" · ") || "No way to sign in"}
              {a.twoFactor && " · two-step on"}
            </span>
          </span>
          <span className="account-actions">
            {a.google && (
              <button className="ghost small-button" onClick={() => unlink(a, "google", "Google")}>
                Unlink Google
              </button>
            )}
            <button className={`ghost small-button ${linking === a.user.id ? "on" : ""}`} onClick={() => setLinking(linking === a.user.id ? null : a.user.id)}>
              {a.tinyauth ? `Change ${tinyName}…` : `Link ${tinyName}…`}
            </button>
            {a.tinyauth && (
              <button className="ghost small-button" onClick={() => unlink(a, "tinyauth", tinyName)}>
                Unlink {tinyName}
              </button>
            )}
            {(a.twoFactor || !!a.passkeys) && (
              <button className="ghost small-button" onClick={() => reset2fa(a)}>
                Reset two-step
              </button>
            )}
            {/* The couples kit is hidden unless switched on here. Never for kid accounts. */}
            {!a.isKid && !a.isSuperAdmin && (
              <button
                className={`ghost small-button ${a.couplesKit ? "on" : ""}`}
                title="Show the private couples kit in this account's 1:1 chats with other accounts that have it"
                onClick={() => setCouples(a, !a.couplesKit)}
              >
                💞 {a.couplesKit ? "Couples kit on" : "Couples kit off"}
              </button>
            )}
            <button className="small-button" onClick={() => setPassword(a)}>
              Set password
            </button>
          </span>
          {linking === a.user.id && (
            <LinkTinyAuthForm
              target={a}
              accounts={accounts}
              tinyName={tinyName}
              onCancel={() => setLinking(null)}
              onDone={() => {
                setLinking(null);
                load();
              }}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** How an account's TinyAuth login is known: its username and email, or failing that, its subject. */
function loginLabel(a: AdminAccount): string | null {
  const l = a.tinyauthLogin;
  if (!l) return null;
  return [l.username, l.email].filter(Boolean).join(", ") || l.subject;
}

/**
 * The super admin attaching a TinyAuth login to an account: one another account has (often one
 * a first sign-in made by itself), moved over; or any login, by the subject TinyAuth sends.
 */
function LinkTinyAuthForm({
  target,
  accounts,
  tinyName,
  onCancel,
  onDone,
}: {
  target: AdminAccount;
  accounts: AdminAccount[];
  tinyName: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const others = accounts.filter((x) => x.user.id !== target.user.id && x.tinyauthLogin);
  const [choice, setChoice] = useState<string>(others[0] ? String(others[0].user.id) : "subject");
  const [subject, setSubject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const url = `/api/admin/accounts/${target.user.id}/signins/tinyauth`;
  const replacing = target.tinyauth ? ` Its current ${tinyName} login (${loginLabel(target)}) is dropped.` : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (choice === "subject") {
        try {
          await api(url, { method: "PUT", body: { subject } });
        } catch (err) {
          // That subject is on another account: say which, and move it on a yes.
          if (!(err instanceof ApiError) || err.status !== 409 || !confirm(`${err.message}${replacing}`)) throw err;
          await api(url, { method: "PUT", body: { subject, move: true } });
        }
      } else {
        const from = others.find((x) => String(x.user.id) === choice)!;
        const ok = confirm(
          `Move the ${tinyName} login ${loginLabel(from)} from @${from.user.username} to @${target.user.username}? ` +
            `@${from.user.username} won't be able to sign in with it any more.${replacing}`,
        );
        if (!ok) return;
        await api(url, { method: "PUT", body: { fromAccount: from.user.id } });
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return; // they said no
      setError((err as Error).message);
    }
  };

  return (
    <form className="signin-form link-tinyauth" onSubmit={(e) => void submit(e)}>
      <label>
        {tinyName} login for {target.user.displayName}
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {others.map((x) => (
            <option key={x.user.id} value={x.user.id}>
              {loginLabel(x)} · now on @{x.user.username}
            </option>
          ))}
          <option value="subject">Another login, by its subject…</option>
        </select>
      </label>
      {choice === "subject" && (
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={`The "sub" ${tinyName} sends for them`} required />
          <span className="muted small">For a login that hasn't signed in to Dendrop yet. Its email and username fill in at its first sign-in.</span>
        </label>
      )}
      {error && <p className="error small">{error}</p>}
      <span className="account-actions">
        <button type="button" className="ghost small-button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary small-button">{choice === "subject" ? "Link" : "Move here"}</button>
      </span>
    </form>
  );
}
