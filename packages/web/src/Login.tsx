import { useState, type FormEvent } from "react";
import type { AuthInfo, Me } from "@dendrop/shared";
import { api } from "./api.ts";

export function Login({ info, onSignedIn }: { info: AuthInfo; onSignedIn: (me: Me) => void }) {
  const mode: "setup" | "login" | "signup" = info.needsSetup ? "setup" : "login";
  const [signup, setSignup] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(new URLSearchParams(location.search).get("error"));

  const current = mode === "setup" ? "setup" : signup ? "signup" : "login";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = current === "login" ? { username, password } : { username, password, displayName };
      onSignedIn(await api<Me>(`/api/auth/${current}`, { body }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <img src="/favicon.svg" alt="" width={64} height={64} />
        <h1>{current === "setup" ? "Set up your den" : "Welcome back to the den"}</h1>
        {current === "setup" && <p className="muted">Make the first account. It becomes the admin of this Dendrop server.</p>}

        {info.oidc.enabled && (
          <>
            <a className="button primary wide" href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(location.pathname)}`}>
              Sign in with {info.oidc.name}
            </a>
            {info.localLogin && <div className="divider">or</div>}
          </>
        )}

        {info.localLogin && (
          <form onSubmit={submit}>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </label>
            {current !== "login" && (
              <label>
                Display name
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || "How friends see you"} />
              </label>
            )}
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={current === "login" ? "current-password" : "new-password"}
                minLength={current === "login" ? undefined : 10}
                required
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {current === "setup" ? "Create admin account" : current === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}
        {mode === "login" && info.signup && (
          <button className="link" onClick={() => setSignup(!signup)}>
            {signup ? "I already have an account" : "Make an account"}
          </button>
        )}
      </div>
    </main>
  );
}
