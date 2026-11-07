import { useState, type FormEvent } from "react";
import type { Me } from "@dendrop/shared";
import { changePassphrase, createIdentity, unlockIdentity, type Identity } from "./e2ee.ts";
import { Modal } from "./Modal.tsx";

export type EncryptionMode = "setup" | "unlock" | "reset" | "change";

const MIN = 8;

const TITLES: Record<EncryptionMode, string> = {
  setup: "Lock your messages",
  unlock: "Unlock your messages",
  reset: "Reset encryption",
  change: "Change chat passphrase",
};

/** Setting up, unlocking on a new device, resetting, or changing the chat passphrase. */
export function EncryptionDialog({
  me,
  mode,
  setMode,
  onDone,
  onClose,
}: {
  me: Me;
  mode: EncryptionMode;
  setMode: (m: EncryptionMode) => void;
  onDone: (identity: Identity) => void;
  onClose: () => void;
}) {
  const [old, setOld] = useState("");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const isNew = mode !== "unlock";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isNew && pass.length < MIN) return setError(`Use at least ${MIN} characters`);
    if (isNew && pass !== confirm) return setError("The two passphrases don't match");
    setBusy(true);
    try {
      if (mode === "setup") onDone(await createIdentity(me.id, pass));
      else if (mode === "reset") onDone(await createIdentity(me.id, pass, true));
      else if (mode === "unlock") onDone(await unlockIdentity(me.id, pass));
      else {
        await changePassphrase(old, pass);
        setChanged(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (changed) {
    return (
      <Modal title={TITLES.change} onClose={onClose}>
        <p>Your chat passphrase is changed. Use the new one next time you sign in on a new device.</p>
        <button className="primary wide" onClick={onClose}>
          Done
        </button>
      </Modal>
    );
  }

  return (
    <Modal title={TITLES[mode]} onClose={onClose}>
      <form className="encryption-form" onSubmit={(e) => void submit(e)}>
        {mode === "setup" && (
          <p>
            Turn on end-to-end encryption so only the people in a conversation can read it. Not even the Dendrop server can. Pick a chat
            passphrase: you'll type it once on each phone or PC you use.
          </p>
        )}
        {mode === "unlock" && <p>Type your chat passphrase to read your encrypted messages on this device. You only need to do this once here.</p>}
        {mode === "reset" && (
          <p className="warning">
            Resetting makes new keys. Messages encrypted before now can't be read on this account any more, on any device. New messages will
            work as normal.
          </p>
        )}
        {mode === "change" && (
          <label>
            Current passphrase
            <input type="password" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} autoFocus />
          </label>
        )}
        <label>
          {mode === "change" ? "New passphrase" : "Chat passphrase"}
          <input
            type="password"
            autoComplete={isNew ? "new-password" : "current-password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus={mode !== "change"}
          />
        </label>
        {isNew && (
          <label>
            Type it again
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {isNew && mode !== "change" && (
          <p className="muted small">If you forget it you can reset, but you'd lose access to older encrypted messages. A password manager is a good home for it.</p>
        )}
        {error && <p className="error">{error}</p>}
        <button className={`wide ${mode === "reset" ? "danger-button" : "primary"}`} disabled={busy}>
          {busy ? "Working…" : mode === "setup" ? "Turn on encryption" : mode === "unlock" ? "Unlock" : mode === "reset" ? "Reset and make new keys" : "Change passphrase"}
        </button>
        <div className="encryption-links">
          {mode === "unlock" && (
            <button type="button" className="link" onClick={() => setMode("reset")}>
              Forgot it?
            </button>
          )}
          {mode === "reset" && (
            <button type="button" className="link" onClick={() => setMode("unlock")}>
              I remember it after all
            </button>
          )}
          {(mode === "setup" || mode === "unlock") && (
            <button type="button" className="link muted" onClick={onClose}>
              Not now
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
