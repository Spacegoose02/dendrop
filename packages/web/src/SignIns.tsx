import { useEffect, useState, type FormEvent } from "react";
import type { AdminAccount, AdminSignIn, MySignIns, SignInProvider, SignInSettings } from "@dendrop/shared";
import { api } from "./api.ts";

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

  const rows: { p: SignInProvider; name: string; linked: boolean; detail: string | null; available: boolean }[] = [
    { p: "google", name: "Google", linked: mine.google.linked, detail: mine.google.email, available: mine.google.available },
    { p: "tinyauth", name: mine.tinyauth.name, linked: mine.tinyauth.linked, detail: null, available: mine.tinyauth.available },
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
            .filter((r) => r.linked || r.available)
            .map((r) => (
              <div key={r.p} className="signin-row">
                <span>
                  <strong>{r.name}</strong>
                  <span className="muted small">{r.linked ? ` Linked${r.detail ? `: ${r.detail}` : ""}` : " Not linked"}</span>
                </span>
                {r.linked ? (
                  <button className="ghost danger" onClick={() => void unlink(r.p, r.name)}>
                    Unlink
                  </button>
                ) : (
                  mine.canLink && <button onClick={() => void link(r.p)}>Link {r.name}</button>
                )}
              </div>
            ))}
          {!mine.canLink && <p className="muted small">The admin has switched off linking sign-ins.</p>}
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
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
              {[a.password && "Password", a.tinyauth && tinyName, a.google && `Google (${a.google})`].filter(Boolean).join(" · ") || "No way to sign in"}
            </span>
          </span>
          <span className="account-actions">
            {a.google && (
              <button className="ghost small-button" onClick={() => unlink(a, "google", "Google")}>
                Unlink Google
              </button>
            )}
            {a.tinyauth && (
              <button className="ghost small-button" onClick={() => unlink(a, "tinyauth", tinyName)}>
                Unlink {tinyName}
              </button>
            )}
            <button className="small-button" onClick={() => setPassword(a)}>
              Set password
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
