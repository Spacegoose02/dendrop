import { useEffect, useState, type FormEvent } from "react";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { MyTwoFactor, PasskeyInfo, TotpSetup } from "@dendrop/shared";
import { api } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A guess at what to call a new passkey, from the device it's made on. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Passkey";
}

/**
 * Settings → Sign-in, below the password: an authenticator app for two-step sign-in, its
 * recovery codes, and passkeys.
 */
export function TwoFactorSection({ hasPassword }: { hasPassword: boolean }) {
  const [status, setStatus] = useState<MyTwoFactor | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState<"disable" | "recovery" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<MyTwoFactor>("/api/me/2fa").then(setStatus, (err: Error) => setError(err.message));
  }, []);
  if (!status) return error ? <p className="error small">{error}</p> : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof Error && err.name === "NotAllowedError")) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => setSetup(await api<TotpSetup>("/api/me/2fa/totp/start", { body: {} })));
  const addPasskey = () =>
    run(async () => {
      const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>("/api/me/passkeys/options", { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      const name = prompt("What should this passkey be called?", deviceName()) ?? deviceName();
      await api<PasskeyInfo>("/api/me/passkeys", { body: { challengeId, response, name } });
      setStatus(await api<MyTwoFactor>("/api/me/2fa"));
    });
  const rename = (p: PasskeyInfo) => {
    const name = prompt("New name for this passkey", p.name);
    if (name)
      void run(async () => {
        await api(`/api/me/passkeys/${encodeURIComponent(p.id)}`, { method: "PATCH", body: { name } });
        setStatus(await api<MyTwoFactor>("/api/me/2fa"));
      });
  };
  const remove = (p: PasskeyInfo) => {
    if (confirm(`Remove the passkey “${p.name}”? It won't sign you in any more.`)) void run(async () => setStatus(await api<MyTwoFactor>(`/api/me/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" })));
  };

  return (
    <>
      <div className="signin-row">
        <span>
          <strong>Two-step sign-in</strong>
          <span className="muted small">{status.totp ? ` On · ${status.recoveryCodesLeft} recovery codes left` : " Off"}</span>
        </span>
        {status.totp ? (
          <span className="account-actions">
            <button className="ghost small-button" onClick={() => setAsking(asking === "recovery" ? null : "recovery")}>
              New recovery codes
            </button>
            <button className="ghost danger small-button" onClick={() => setAsking(asking === "disable" ? null : "disable")}>
              Turn off
            </button>
          </span>
        ) : (
          !setup && (
            <button onClick={() => void start()} disabled={busy || !hasPassword} title={hasPassword ? undefined : "Set a password first"}>
              Set up
            </button>
          )
        )}
      </div>
      {!status.totp && !setup && <p className="muted small">After your password, Dendrop asks for a code from an app on your phone (Google Authenticator, Aegis, 1Password and so on).</p>}
      {setup && (
        <TotpSetupForm
          setup={setup}
          onCancel={() => setSetup(null)}
          onDone={(recoveryCodes, next) => {
            setSetup(null);
            setCodes(recoveryCodes);
            setStatus(next);
          }}
        />
      )}
      {asking && (
        <ProveItForm
          action={asking}
          onCancel={() => setAsking(null)}
          onDone={(next, recoveryCodes) => {
            setAsking(null);
            if (next) setStatus(next);
            if (recoveryCodes) {
              setCodes(recoveryCodes);
              setStatus({ ...status, recoveryCodesLeft: recoveryCodes.length });
            }
          }}
        />
      )}
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      <div className="signin-row">
        <span>
          <strong>Passkeys</strong>
          <span className="muted small">{status.passkeys.length ? ` ${status.passkeys.length}` : " None"}</span>
        </span>
        {status.passkeysAvailable && (
          <button onClick={() => void addPasskey()} disabled={busy}>
            Add a passkey
          </button>
        )}
      </div>
      {!status.passkeysAvailable && <p className="muted small">Passkeys need Dendrop on an https:// address with a name, not an IP address.</p>}
      {status.passkeysAvailable && !status.passkeys.length && (
        <p className="muted small">Sign in with your fingerprint, face or phone instead of a password. They also work as the second step.</p>
      )}
      {status.passkeys.map((p) => (
        <div key={p.id} className="signin-row passkey-row">
          <span>
            <span>{p.name}</span>
            <span className="muted small">
              {" "}
              Added {when(p.createdAt)}
              {p.lastUsedAt ? ` · last used ${when(p.lastUsedAt)}` : ""}
            </span>
          </span>
          <span className="account-actions">
            <button className="ghost small-button" onClick={() => rename(p)}>
              Rename
            </button>
            <button className="ghost danger small-button" onClick={() => remove(p)}>
              Remove
            </button>
          </span>
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
    </>
  );
}

function TotpSetupForm({ setup, onCancel, onDone }: { setup: TotpSetup; onCancel: () => void; onDone: (codes: string[], status: MyTwoFactor) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ recoveryCodes: string[]; status: MyTwoFactor }>("/api/me/2fa/totp/confirm", { body: { code } });
      onDone(r.recoveryCodes, r.status);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="signin-form totp-setup" onSubmit={(e) => void submit(e)}>
      <p className="small">1. Scan this with your authenticator app.</p>
      {/* The SVG comes from our own server's QR encoder: only rects and paths. */}
      <div className="totp-qr" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
      <p className="muted small">
        Can't scan it? Type this key instead: <code className="totp-secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
      </p>
      <label>
        2. Type the 6-digit code it shows
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      </label>
      <p className="muted small">Your other devices will be signed out.</p>
      {error && <p className="error small">{error}</p>}
      <span className="account-actions">
        <button className="primary">Turn on</button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** Turning the app off, or new recovery codes, needs a code (or your password). */
function ProveItForm({ action, onCancel, onDone }: { action: "disable" | "recovery"; onCancel: () => void; onDone: (status?: MyTwoFactor, codes?: string[]) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (action === "disable") onDone(await api<MyTwoFactor>("/api/me/2fa/totp/disable", { body: { code } }));
      else onDone(undefined, (await api<{ recoveryCodes: string[] }>("/api/me/2fa/recovery", { body: { code } })).recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="signin-form" onSubmit={(e) => void submit(e)}>
      <label>
        {action === "disable" ? "To turn two-step sign-in off, type a code from your app" : "To make new recovery codes, type a code from your app"}
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456 or a recovery code" required />
      </label>
      {action === "recovery" && <p className="muted small">Your old recovery codes stop working.</p>}
      {error && <p className="error small">{error}</p>}
      <span className="account-actions">
        <button className={action === "disable" ? "danger" : "primary"}>{action === "disable" ? "Turn off" : "Make new codes"}</button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Dendrop recovery codes (${location.host})\nEach works once, if you lose your phone.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "dendrop-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="signin-form recovery-codes">
      <p className="small">
        <strong>Save these recovery codes somewhere safe.</strong> If you lose your phone, each one gets you in once. You won't see them again.
      </p>
      <ol className="recovery-list">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <span className="account-actions">
        <button onClick={download}>Download</button>
        <button onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button className="primary" onClick={onDone}>
          I've saved them
        </button>
      </span>
    </div>
  );
}
