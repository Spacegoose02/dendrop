import { useState, type FormEvent } from "react";
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { AuthInfo, Me, TwoFactorChallenge } from "@dendrop/shared";
import { api } from "./api.ts";

/** A passkey prompt that the person closed, rather than one that failed. */
const cancelled = (err: unknown) => err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");

export function Login({ info, onSignedIn }: { info: AuthInfo; onSignedIn: (me: Me) => void }) {
  const mode: "setup" | "login" | "signup" = info.needsSetup ? "setup" : "login";
  const [signup, setSignup] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(new URLSearchParams(location.search).get("error"));
  const [second, setSecond] = useState<TwoFactorChallenge["twoFactor"] | null>(null);

  const current = mode === "setup" ? "setup" : signup ? "signup" : "login";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = current === "login" ? { username, password } : { username, password, displayName };
      const res = await api<Me | TwoFactorChallenge>(`/api/auth/${current}`, { body });
      if ("twoFactor" in res) setSecond(res.twoFactor);
      else onSignedIn(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passkeySignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/passkey/options", { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      onSignedIn(await api<Me>("/api/auth/passkey", { body: { challengeId, response } }));
    } catch (err) {
      if (!cancelled(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (second) {
    return (
      <SecondStep
        challenge={second}
        onSignedIn={onSignedIn}
        onBack={(message) => {
          setSecond(null);
          setPassword("");
          setError(message ?? null);
        }}
      />
    );
  }

  return (
    <main className="login">
      <div className="login-card">
        <img src="/favicon.svg" alt="" width={64} height={64} />
        <h1>{current === "setup" ? "Set up your den" : "Welcome back to the den"}</h1>
        {current === "setup" && <p className="muted">Make the first account. It becomes the admin of this Dendrop server.</p>}

        {(info.oidc.enabled || info.google.enabled) && current !== "setup" && (
          <>
            {info.oidc.enabled && (
              <a className="button primary wide" href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(location.pathname)}`}>
                Sign in with {info.oidc.name}
              </a>
            )}
            {info.google.enabled && (
              <a className="button wide google-button" href={`/api/auth/google/start?returnTo=${encodeURIComponent(location.pathname)}`}>
                <GoogleMark /> Sign in with Google
              </a>
            )}
            {(info.localLogin || info.passkeys) && <div className="divider">or</div>}
          </>
        )}

        {info.passkeys && current === "login" && (
          <>
            <button className="wide passkey-button" onClick={() => void passkeySignIn()} disabled={busy}>
              <KeyMark /> Sign in with a passkey
            </button>
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

/** After a right password, when two-step sign-in is on: a code from the app, a recovery code, or a passkey. */
function SecondStep({ challenge, onSignedIn, onBack }: { challenge: TwoFactorChallenge["twoFactor"]; onSignedIn: (me: Me) => void; onBack: (message?: string) => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failed = (err: unknown) => {
    const message = (err as Error).message;
    // The ticket ran out or had too many wrong codes: back to the password.
    if (/too long|Too many|Start again|Sign in again/.test(message)) onBack(message);
    else setError(message);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<Me>("/api/auth/2fa", { body: { ticket: challenge.ticket, code } }));
    } catch (err) {
      failed(err);
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  const passkey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/2fa/passkey/options", { body: { ticket: challenge.ticket } });
      const response = await startAuthentication({ optionsJSON: options });
      onSignedIn(await api<Me>("/api/auth/2fa/passkey", { body: { ticket: challenge.ticket, response } }));
    } catch (err) {
      if (!cancelled(err)) failed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <img src="/favicon.svg" alt="" width={64} height={64} />
        <h1>One more step</h1>
        <p className="muted">{recovery ? "Type one of the recovery codes you saved. Each one works once." : "Open your authenticator app and type the 6-digit code for Dendrop."}</p>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            {recovery ? "Recovery code" : "Code"}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode={recovery ? "text" : "numeric"}
              pattern={recovery ? undefined : "[0-9 ]{6,7}"}
              placeholder={recovery ? "abcde-23456" : "123456"}
              autoFocus
              required
            />
          </label>
          <button className="primary wide" disabled={busy}>
            Sign in
          </button>
        </form>
        {challenge.passkey && (
          <>
            <div className="divider">or</div>
            <button className="wide passkey-button" onClick={() => void passkey()} disabled={busy}>
              <KeyMark /> Use a passkey
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="link" onClick={() => setRecovery(!recovery)}>
          {recovery ? "Use a code from the app" : "Lost your phone? Use a recovery code"}
        </button>
        <button className="link" onClick={() => onBack()}>
          Back
        </button>
      </div>
    </main>
  );
}

/** A key, for the passkey buttons. */
export function KeyMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
    </svg>
  );
}

/** Google's "G", as its sign-in guidelines ask for. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
